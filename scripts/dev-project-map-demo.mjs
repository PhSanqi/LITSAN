// Dev-only: isolated fake Core and real gateway. No production state or network.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addAccount, setAccountRole, ensureLocalAdminToken } from "../dist/auth.js";
import { createLitsanRuntime } from "../dist/runtime.js";
import { architectureCognitiveMapFingerprint } from "../dist/architecture-cognitive-map.js";
import { graphProjectModel } from "../tests/fakes/project-model-fakes.mjs";
import { createTestRoot, testEnvironment } from "../tests/test-isolation.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const model = graphProjectModel();
// Deterministic, deliberately incomplete map: evidence, confidence, branches,
// unmapped changes and todos. The browser check also injects dangling edges
// directly into the read model, since the production parser rejects them.
model.architecture.map.generated_at = "2026-10-04T00:00:00.000Z";
model.architecture.map.timeline_links = model.architecture.map.timeline_links.slice(0, 4);
for (const [index, id] of ["decode", "export"].entries()) {
  const node = model.architecture.map.nodes.find(node => node.id === id);
  node.evidence_refs = [];
  node.confidence = index ? 0.3 : 0.5;
}
for (const [index, kind] of ["domain", "capability", "process"].entries()) {
  const parent_id = ["alpha", "capture", "ingest"][index];
  model.architecture.map.nodes.push({ id: `empty-${kind}`, kind, parent_id, label: `Unfinished ${kind}`,
    summary: "Needs decomposition", order: 9, evidence_refs: [], confidence: 0.5 });
}
model.architecture.map.abstraction_cutoff = 'mechanism';
model.architecture.map.facet_vocab = { layer: ['shell', 'core'] };
for (const node of model.architecture.map.nodes) {
  node.facets = { layer: ['capture', 'decode', 'normalize'].includes(node.id) ? 'core' : 'shell' };
}
model.architecture.map.nodes.find(node => node.id === 'decode').facts = [
  { key: 'top-k', value: 8, unit: 'items', evidence_refs: ['l1:demo'], confidence: 0.9 },
  { key: 'threshold', value: 0.6, evidence_refs: ['l1:demo'], confidence: 0.8 },
  { key: 'limit', value: 12, evidence_refs: ['l1:demo'], confidence: 0.7 }
];
model.architecture.map.nodes.push({ id: 'bounded-admission', kind: 'mechanism', parent_id: 'decode', label: 'Bounded admission',
  summary: 'Keep the highest scoring items', order: 0, evidence_refs: ['l1:demo'], confidence: 0.9, facets: { layer: 'core' } });
model.todos = ["Review evidence", "Complete decomposition", "Verify Windows"].map((text, index) =>
  ({ id: `demo-todo-${index}`, text, status: "pending" }));
if (process.argv.includes("--no-l2")) model.l2 = [];
if (process.argv.includes("--no-map")) model.architecture = { map: null, fingerprint: null };
// File-backed browser acceptance; no HTTP listener, service or network request.
// Supply an already-installed Playwright via MEMHUB_PLAYWRIGHT_MODULE if needed.
if (process.argv.includes("--check")) {
  const { checkProjectMapDemo } = await import("./project-map-demo-check.mjs");
  await checkProjectMapDemo(model);
  process.exit(0);
}
const stateRoot = await createTestRoot("project-map-demo-");
const architectureRoot = join(stateRoot, "architecture");
let gateway;
const core = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("content-type", "application/json");
  if (request.headers.authorization !== "Bearer demo-core-token") {
    response.writeHead(401).end(JSON.stringify({ message: "Demo Core token required" }));
    return;
  }
  if (url.pathname === "/api/v1/l2") {
    response.end(JSON.stringify({ items: model.l2, total: model.l2.length, totalPages: 1, hasNext: false }));
  } else response.end(JSON.stringify({ ok: true, items: [], total: 0 }));
});
let stop;
const stopped = new Promise(resolve => { stop = resolve; });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await mkdir(architectureRoot);
  await new Promise((resolve, reject) => {
    core.once("error", reject);
    core.listen(0, "127.0.0.1", resolve);
  });
  const account = await addAccount(stateRoot, "project-map-demo");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const token = await ensureLocalAdminToken(stateRoot);
  const endpoint = `http://127.0.0.1:${core.address().port}`;
  const runtime = createLitsanRuntime({ controlRoot: stateRoot, architectureRoot, accountId: account.account_id,
    memoryEndpoint: endpoint, memoryToken: "demo-core-token" });
  await runtime.projects.create(account.account_id, { projectId: "alpha", name: "Alpha · Project Map demo", description: "Isolated architecture graph demo" });
  for (const todo of model.todos) await runtime.projects.addTodo(account.account_id, "alpha", todo.text);
  if (model.architecture.map) await runtime.architecture.writeProjectCognitiveMap({ accountId: account.account_id, projectId: "alpha",
    expectedFingerprint: architectureCognitiveMapFingerprint(null), map: model.architecture.map });
  gateway = spawn(process.execPath, ["dist/mcp.js", "--http", "0", "--state-root", stateRoot,
    "--architecture-root", architectureRoot, "--account", account.account_id,
    "--memory-url", endpoint, "--memory-token", "demo-core-token"],
  { cwd: repo, env: testEnvironment(stateRoot, architectureRoot), stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", chunk => process.stderr.write(chunk));
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Gateway startup timed out")), 10000);
    gateway.once("error", error => { clearTimeout(timer); reject(error); });
    gateway.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Gateway exited: ${code ?? signal}\n${output}`)); });
    gateway.stderr.on("data", chunk => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const url = `${origin}/memhub/user?view=visualization&project=alpha`;
  const auth = `Basic ${Buffer.from(`local:${token}`).toString("base64")}`;
  const response = await fetch(url, { headers: { authorization: auth } });
  if (!response.ok) throw new Error(`Demo page returned HTTP ${response.status}`);
  await response.text();
  console.log(`Page URL: ${url}`);
  console.log("Browser: open the Page URL and sign in with the Basic-auth username/password below (a credential-bearing URL breaks the page's relative API fetches).");
  console.log(`Authorization: ${auth}`);
  console.log(`Basic-auth username: local; password/token: ${token}`);
  console.log(`State: ${stateRoot}; ${model.l2.length ? "8 L2 events" : "map only"}, ${model.architecture.map?.nodes.length ?? 0} nodes. Ctrl+C to stop.`);
  gateway.once("exit", stop);
  await stopped;
} finally {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const exited = once(gateway, "exit");
    gateway.kill("SIGTERM");
    const timeout = setTimeout(() => gateway.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timeout);
  }
  core.closeAllConnections();
  if (core.listening) await new Promise(resolve => core.close(resolve));
  // Only the fresh demo root inside this worktree is removed.
  await rm(stateRoot, { recursive: true, force: true });
}
