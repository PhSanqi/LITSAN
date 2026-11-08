#!/usr/bin/env node
// P6 planner step (eval harness only; LITSAN owns no model call).
// usage: node followup.mjs plan <questions.json> <A|B> <responses.json> <plans-out.json> [parts]
// Reads the first-call responses, shows each case's delivered passages to Codex gpt-5.6-luna (low), and
// writes {id: {sufficient, missing, queries, ok, planner_ms, attempts}}. Prompts are cached by sha256.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const CACHE = join(ROOT, ".review-runtime", "followup", "calls");
const WORK = join(ROOT, ".review-runtime", "followup", "work");
const MODEL = "gpt-5.6-luna";
const CONCURRENCY = Number(process.env.FU_CONCURRENCY ?? 6);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

export function parseContext(text) {
  const d = JSON.parse(text);
  const sup = d?.turnKnowledgePlan?.supporting ?? [];
  const raw = [], facts = [];
  for (const e of sup) for (const p of e.passages ?? []) {
    if (e.id === "adaptive:raw-evidence" && p.evidence_ref) raw.push({ ref: p.evidence_ref, text: p.text });
    else if (p.fact_id) facts.push({ fact_id: p.fact_id, text: p.text });
  }
  return { raw, facts };
}

function parseAnswer(text) {
  let s = text.trim();
  if (s.startsWith("```")) s = s.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim();
  return JSON.parse(s);
}

function codex(prompt) {
  return new Promise((resolveP, reject) => {
    const args = ["-m", MODEL, "-c", 'model_reasoning_effort="low"', "-c", 'model_verbosity="low"', "exec", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--ephemeral", "--json", "-C", WORK, "-"];
    const p = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 240_000);
    p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => { clearTimeout(timer); resolveP({ code, out, err }); });
    p.stdin.end(prompt);
  });
}

// One cached call; returns {answer, ms}. Throws when the turn failed, used a tool or returned no valid JSON.
export async function cachedCall(tag, prompt) {
  const key = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const base = join(CACHE, `${tag}-${key}`);
  let stdout, ms;
  if (await exists(`${base}.jsonl`)) { stdout = await readFile(`${base}.jsonl`, "utf8"); ms = Number(await readFile(`${base}.ms`, "utf8").catch(() => 0)); }
  else {
    const t0 = performance.now();
    const { code, out, err } = await codex(prompt);
    ms = Math.round(performance.now() - t0);
    if (code !== 0) throw new Error(`codex exit ${code}: ${err.slice(-300)}`);
    stdout = out;
    await writeFile(`${base}.prompt.txt`, prompt); await writeFile(`${base}.jsonl`, out); await writeFile(`${base}.ms`, String(ms));
  }
  let message = "";
  for (const line of stdout.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "item.completed") {
      const t = e.item?.type;
      if (t === "agent_message") message = e.item.text ?? "";
      else if (t !== "reasoning" && !(t === "error" && /Falling back from WebSockets/.test(e.item?.message ?? ""))) throw new Error(`unexpected item ${t}`);
    }
  }
  return { answer: parseAnswer(message), ms };
}

async function plan() {
  const [, , , qfile, variant, respFile, outFile] = process.argv;
  const parts = process.argv[7]?.split(",");
  const head = (await readFile(join(HERE, `planner-${variant}.txt`), "utf8")).trim();
  const qs = JSON.parse(await readFile(qfile, "utf8"));
  const rows = Object.entries(qs).filter(([part]) => !parts || parts.includes(part)).flatMap(([, list]) => list).filter((r) => r.evidence?.length);
  const resp = JSON.parse(await readFile(respFile, "utf8"));
  await mkdir(CACHE, { recursive: true }); await mkdir(WORK, { recursive: true });
  const result = (await exists(outFile)) ? JSON.parse(await readFile(outFile, "utf8")) : {};
  const todo = rows.filter((r) => resp[r.id] && !result[r.id]);
  let next = 0, done = 0;
  async function worker() {
    for (;;) {
      const r = todo[next++]; if (!r) return;
      const { raw, facts } = parseContext(resp[r.id].text);
      const userCase = { id: r.id, question: r.question, FOUND: { raw_turns: raw.map((x) => ({ ref: x.ref, text: x.text })), facts: facts.map((x) => ({ text: x.text })) } };
      const prompt = `${head}\n${JSON.stringify([userCase])}`;
      const entry = { ok: false, sufficient: true, missing: [], queries: [], planner_ms: 0, attempts: 0, model_calls: 0, error: null };
      for (let attempt = 0; attempt < 2 && !entry.ok; attempt++) {
        const p = attempt ? `${prompt}\nEnsure the response is valid JSON with all quotation marks inside strings escaped.` : prompt;
        entry.attempts++; entry.model_calls++;
        try {
          const { answer, ms } = await cachedCall(`plan${variant}`, p);
          entry.planner_ms += ms;
          const one = Array.isArray(answer) ? answer.find((x) => x?.id === r.id) : null;
          if (!one || typeof one.sufficient !== "boolean") throw new Error("bad shape");
          const queries = (Array.isArray(one.queries) ? one.queries : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
          Object.assign(entry, { ok: true, sufficient: one.sufficient, missing: one.missing ?? [], queries: one.sufficient ? [] : queries, error: null });
        } catch (e) { entry.error = String(e.message ?? e).slice(0, 200); }
      }
      result[r.id] = entry;
      if (++done % 20 === 0) { await writeFile(outFile, JSON.stringify(result)); console.log("planned", done, "/", todo.length); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writeFile(outFile, JSON.stringify(result));
  const all = rows.map((r) => result[r.id]).filter(Boolean);
  console.log("plans", all.length, "failed", all.filter((x) => !x.ok).length, "with follow-ups", all.filter((x) => x.queries.length).length);
}

if (process.argv[2] === "plan") await plan();
