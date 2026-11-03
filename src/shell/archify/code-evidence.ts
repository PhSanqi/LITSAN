import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, posix, resolve, sep } from "node:path";
import { parseTree, getNodePath, type Node as JsonNode } from "jsonc-parser";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";
import type { CodeEvidenceItem, CodeEvidenceSnapshot } from "../../contracts/code-evidence.js";

const run = promisify(execFile);
const MAX_FILES = 1000, MAX_BYTES = 10 * 1024 * 1024, MAX_FILE = 256 * 1024, MAX_MS = 5000, MAX_OUTPUT = 64 * 1024;
const relevant = /limit|top_?k|max|min|threshold|timeout|port|depth|layers|size|ttl|budget/i;
const secret = /key|token|secret|password|passwd|credential|authorization|cookie|private/i;
const excluded = /(?:^|\/)(?:node_modules|vendor|dist|build|out|coverage|runtime-releases|\.git|\.tsbuild|\.cache|\.memmy|\.litsan)(?:\/|$)/i;
const privatePath = /(?:^|\/)(?:\.env[^/]*|[^/]*(?:credential|secret|password|private[-_]?key|id_rsa|id_ed25519)[^/]*|(?:keys?|tokens?)(?:\.[^/]*)?)(?:\/|$)|\.(?:pem|key|p12|pfx|keystore)$/i;
const sourceExt = /\.(?:[cm]?[jt]sx?)$/i;
const configExt = /\.(?:jsonc?|ya?ml|toml)$/i;
const portable = (path: string) => path.split(sep).join("/");
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Draft = Omit<CodeEvidenceItem, "ref">;
type Rule = { name: string; paths: string[]; exclude?: string[] };
type File = { path: string; content: string; bytes: number };

function glob(pattern: string): RegExp {
  if (typeof pattern !== "string" || !pattern || pattern.length > 240 || pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..") || /[\[\]{}]/.test(pattern))
    throw new TypeError("unsupported or unsafe layer path pattern");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      i++; if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}
function ignored(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return false;
    const p = pattern.replace(/^\//, "").replace(/\/$/, "");
    try { return glob(p).test(path) || glob(p + "/**").test(path) || (!p.includes("/") && path.split("/").some(part => glob(p).test(part))); }
    catch { return true; } // Unknown ignore syntax excludes conservatively, never exposes it.
  });
}
async function safeFile(root: string, path: string, cap = MAX_FILE): Promise<File | null> {
  const parts = path.split("/");
  if (isAbsolute(path) || parts.some(part => !part || part === "." || part === "..") || path.includes("\\") || privatePath.test(path)) return null;
  let expected: Awaited<ReturnType<typeof lstat>> | undefined;
  for (let i = 1; i <= parts.length; i++) {
    const info = await lstat(resolve(root, ...parts.slice(0, i))).catch(() => null);
    if (!info || info.isSymbolicLink() || (i < parts.length && !info.isDirectory())) return null;
    if (i === parts.length && (!info.isFile() || info.size > cap)) return null;
    if (i === parts.length) expected = info;
  }
  const target = resolve(root, path);
  if (await realpath(target).catch(() => "") !== target) return null;
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > cap || info.ino !== expected?.ino || info.dev !== expected?.dev) return null;
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > cap || buffer.subarray(0, bytesRead).includes(0)) return null;
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (content.includes("\uFFFD")) return null;
    return { path, content, bytes: bytesRead };
  } finally { await handle.close(); }
}
function mask(source: string): string {
  // Keep offsets/newlines, but prevent declarations inside comments/strings from matching.
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60/g,
    text => text.replace(/[^\r\n]/g, " "));
}
function literal(text: string): string | number | boolean | undefined {
  if (/^-?(?:\d+(?:\.\d+)?|0x[\da-f]+)$/i.test(text)) return Number(text);
  if (/^(?:true|false)$/.test(text)) return text === "true";
  if (/^["'][a-z0-9_.:/ -]{1,120}["']$/i.test(text)) {
    const value = text.slice(1, -1);
    if (!secret.test(value) && !/https?:|[a-z0-9_-]{32,}/i.test(value)) return value;
  }
  return undefined;
}
function extract(file: File): Draft[] {
  const out: Draft[] = [], source = file.content, masked = mask(source);
  const line = (offset: number) => source.slice(0, offset).split("\n").length;
  const add = (kind: Draft["kind"], offset: number, length: number, extra: Partial<Draft>, snippet = source.slice(offset, offset + length)) =>
    out.push({ kind, path: file.path, start: line(offset), end: line(offset + Math.max(0, length - 1)), snippet: snippet.slice(0, 400), ...extra });
  const constant = (name: string, value: unknown, offset: number, length: number) => {
    if (!relevant.test(name) || secret.test(name) || !["string", "number", "boolean"].includes(typeof value)) return;
    const safe = typeof value === "string" ? literal(JSON.stringify(value)) : value;
    if (safe === undefined || (typeof safe === "number" && !Number.isFinite(safe))) return;
    // Emit only the selected key/value, never neighboring object fields or comments.
    add("constant", offset, length, { name, value: safe as string | number | boolean }, name + " = " + JSON.stringify(safe));
  };
  if (sourceExt.test(file.path)) {
    add("module", 0, source.length, { language: /[cm]?tsx?$/i.test(file.path) ? "typescript" : "javascript", bytes: file.bytes }, "");
    // shortcut: only line-leading literal declarations; use a parser if computed expressions become required.
    for (const m of source.matchAll(/^[ \t]*export\s+const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*(?:number|string|boolean))?\s*=\s*(-?(?:0x[\da-f]+|\d+(?:\.\d+)?)|true|false|"[^"\r\n]*"|'[^'\r\n]*')\s*(?:as\s+const\s*)?(?=;|,|\r?$)/gmi)) {
      if (!/^[ \t]*export/.test(masked.slice(m.index, m.index! + m[0].length))) continue;
      constant(m[1]!, literal(m[2]!), m.index!, m[0].length);
    }
    for (const m of source.matchAll(/^[ \t]*(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["']([^"'\r\n]+)["']/gm)) {
      if (!/^[ \t]*(?:import|export)/.test(masked.slice(m.index, m.index! + m[0].length))) continue;
      const target = m[1]!;
      if (!/^[a-z0-9_@./-]+$/i.test(target) || privatePath.test(target) || secret.test(target)) continue;
      add("dependency", m.index!, m[0].length, { target }, file.path + " -> " + target);
    }
  } else if (/\.jsonc?$/i.test(file.path)) {
    const errors: import("jsonc-parser").ParseError[] = [];
    const root = parseTree(source, errors);
    if (errors.length) return [];
    const walk = (node: JsonNode, depth = 0) => {
      if (depth > 32) return;
      if (["string", "number", "boolean"].includes(node.type)) constant(getNodePath(node).join("."), node.value, node.offset, node.length);
      for (const child of node.children ?? []) if (node.type !== "property" || child === node.children?.[1]) walk(child, depth + 1);
    };
    if (root) walk(root);
  } else if (/\.ya?ml$/i.test(file.path)) {
    const doc = parseDocument(source);
    const walk = (node: unknown, path: string[]) => {
      if (path.length > 32) return;
      if (isMap(node)) for (const pair of node.items) if (isScalar(pair.key)) walk(pair.value, [...path, String(pair.key.value)]);
      if (isSeq(node)) node.items.forEach((item, i) => walk(item, [...path, String(i)]));
      if (isScalar(node) && node.range) constant(path.join("."), node.value, node.range[0], node.range[1] - node.range[0]);
    };
    if (!doc.errors.length) walk(doc.contents, []);
  } else {
    // shortcut: simple TOML tables and scalar literals only; skip multiline strings until a TOML parser is needed.
    if (/"""|'''/.test(source)) return [];
    let table: string | undefined = "", offset = 0;
    for (const text of source.split("\n")) {
      if (/^\s*\[/.test(text)) table = text.match(/^\s*\[([\w.-]+)\]\s*(?:#.*)?$/)?.[1];
      const m = text.match(/^[ \t]*([\w.-]+)\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|-?\d+(?:\.\d+)?|true|false)[ \t]*\r?(?:#[^\n]*)?$/);
      if (m && table !== undefined) constant([table, m[1]].filter(Boolean).join("."), literal(m[2]!), offset, text.length);
      offset += text.length + 1;
    }
  }
  return out;
}

export async function scanCodeEvidence(rootPath: string, project: string, onFile?: (path: string, hash: string) => void): Promise<CodeEvidenceSnapshot> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(project)) throw new TypeError("invalid code evidence project");
  const root = await realpath(rootPath);
  const deadline = Date.now() + MAX_MS, truncated = new Set<string>();
  let paths: string[] = [], commit: string | undefined, clean = false, gitRoot = false;
  const git = async (args: string[]) => (await run("git", ["-C", root, ...args], { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024 })).stdout;
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (await realpath(top.trim()) === root) {
      gitRoot = true;
      commit = (await git(["rev-parse", "HEAD"])).trim();
      paths = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      clean = !(await git(["status", "--porcelain", "--untracked-files=normal"])).trim();
    }
  } catch { if (gitRoot) truncated.add("git_unavailable_or_limit"); }
  if (!gitRoot) {
    let entriesSeen = 0;
    const walk = async (dir: string, inherited: string[]) => {
      if (Date.now() > deadline || entriesSeen > MAX_FILES * 4) { truncated.add("walk_limit"); return; }
      const ignore = await safeFile(root, (dir ? dir + "/" : "") + ".gitignore", 32 * 1024);
      const patterns = [...inherited, ...(ignore?.content.split(/\r?\n/).filter(s => s && !s.startsWith("#")).map(s => s.startsWith("!") ? s : (dir ? dir + "/" : "") + (!s.replace(/\/$/, "").includes("/") ? "**/" : "") + s.replace(/^\//, "")) ?? [])];
      for (const entry of (await readdir(resolve(root, dir), { withFileTypes: true })).sort((a, b) => cmp(a.name, b.name))) {
        const path = dir ? dir + "/" + entry.name : entry.name;
        if (++entriesSeen > MAX_FILES * 4 || Date.now() > deadline) { truncated.add("walk_limit"); break; }
        if (entry.isSymbolicLink() || excluded.test(path) || privatePath.test(path) || ignored(path, patterns)) continue;
        if (entry.isDirectory()) { if (!entry.name.startsWith(".") || path === ".memhub") await walk(path, patterns); }
        else if (entry.isFile()) paths.push(path);
      }
    };
    await walk("", []);
  }
  // Native Git ignore semantics also apply to tracked ignored files.
  if (gitRoot && paths.length) {
    try {
      const ignoredFiles = await new Promise<string>((accept, reject) => {
        const child = execFile("git", ["-C", root, "check-ignore", "--no-index", "--stdin", "-z"], { timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error && (error as { code?: number }).code !== 1) reject(error); else accept(stdout);
        });
        child.stdin?.end(paths.join("\0") + "\0");
      });
      const ignoredSet = new Set(ignoredFiles.split("\0")); paths = paths.filter(path => !ignoredSet.has(path));
    } catch { truncated.add("ignore_check_failed"); paths = []; }
  }
  const files: File[] = [], digest = createHash("sha256");
  let bytes = 0;
  const priority = (path: string) => path === ".memhub/layers.json" ? 0 : path.startsWith("src/") ? 1 : 2;
  for (const path of [...new Set(paths)].sort((a, b) => priority(a) - priority(b) || cmp(a, b))) {
    if (excluded.test(path) || privatePath.test(path) || (!sourceExt.test(path) && !configExt.test(path)) || /(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock)\b/.test(path)) continue;
    if (files.length >= MAX_FILES || Date.now() > deadline) { truncated.add("file_or_time_limit"); break; }
    const file = await safeFile(root, portable(path));
    if (!file) { truncated.add("skipped_unsafe_binary_or_large_file"); continue; }
    if (bytes + file.bytes > MAX_BYTES) { truncated.add("byte_limit"); break; }
    bytes += file.bytes; files.push(file); digest.update(path + "\0" + file.content + "\0");
    if (onFile) onFile(file.path, createHash("sha256").update(file.content).digest("hex"));
  }
  const contentHash = digest.digest("hex");
  const revision = clean && commit && !truncated.size ? commit.slice(0, 12) : contentHash.slice(0, 12);
  const ref = (path: string, start: number, end: number) => "code:" + project + ":" + revision + ":" + path + "#L" + start + "-L" + end;
  const snapshot: CodeEvidenceSnapshot = { version: 1, project, revision, ...(commit ? { commit } : {}), items: [], layers: [], allowed: {}, truncated: [] };
  const manifest = files.find(file => file.path === ".memhub/layers.json");
  if (manifest) {
    const parsed = JSON.parse(manifest.content);
    if (!Array.isArray(parsed.layers) || parsed.layers.length > 11 || !parsed.allowed || Array.isArray(parsed.allowed) || typeof parsed.allowed !== "object" || Object.keys(parsed).some(key => !["layers", "allowed"].includes(key))) throw new TypeError("invalid layers manifest");
    for (const rule of parsed.layers as Rule[]) {
      if (!rule || !/^[a-z][a-z0-9_-]{0,39}$/.test(rule.name) || secret.test(rule.name) || rule.name === "mixed" || Object.keys(rule).some(key => !["name", "paths", "exclude"].includes(key)) || !Array.isArray(rule.paths) || !rule.paths.length || rule.paths.length > 30 || (rule.exclude && (!Array.isArray(rule.exclude) || rule.exclude.length > 30))) throw new TypeError("invalid layer rule");
      [...rule.paths, ...(rule.exclude ?? [])].forEach(glob);
      if (snapshot.layers.some(layer => layer.name === rule.name)) throw new TypeError("duplicate layer");
      const tree = parseTree(manifest.content)!;
      const layerNode = tree.children?.find(n => n.children?.[0]?.value === "layers")?.children?.[1]?.children?.[snapshot.layers.length];
      if (!layerNode) throw new TypeError("invalid layers location");
      const start = manifest.content.slice(0, layerNode.offset).split("\n").length;
      const end = manifest.content.slice(0, layerNode.offset + layerNode.length).split("\n").length;
      const evidence = ref(manifest.path, start, end);
      snapshot.layers.push({ name: rule.name, paths: rule.paths, ...(rule.exclude ? { exclude: rule.exclude } : {}), ref: evidence });
      snapshot.items.push({ kind: "layer", path: manifest.path, start, end, name: rule.name, ref: evidence, snippet: JSON.stringify(rule).slice(0, 400) });
    }
    const names = new Set(snapshot.layers.map(layer => layer.name));
    for (const [name, targets] of Object.entries(parsed.allowed)) {
      if (!names.has(name) || !Array.isArray(targets) || targets.some(target => !names.has(target))) throw new TypeError("invalid layer directions");
      snapshot.allowed[name] = targets;
    }
  }
  let constants = 0, imports = 0, outputBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (outputBytes > MAX_OUTPUT / 2) throw new TypeError("layers manifest exceeds code evidence budget");
  const pending: Draft[] = [];
  for (const file of files) {
    if (file.path === ".memhub/layers.json") continue;
    if (Date.now() > deadline) { truncated.add("time_limit"); break; }
    for (const item of extract(file)) {
      if (item.kind === "constant" && ++constants > 200) { truncated.add("constant_limit"); continue; }
      if (item.kind === "dependency" && ++imports > 400) { truncated.add("import_limit"); continue; }
      pending.push(item);
    }
  }
  const budgets = { constant: 16 * 1024, module: 36 * 1024, dependency: 10 * 1024, layer: 0 };
  const sourcePaths = new Set(files.filter(file => sourceExt.test(file.path)).map(file => file.path));
  for (const kind of ["constant", "module", "dependency"] as const) {
    for (const item of pending.filter(item => item.kind === kind)) {
      const row: CodeEvidenceItem = { ...item, ref: ref(item.path, item.start, item.end) };
      if (row.kind === "dependency" && row.target?.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(row.path), row.target));
        const stem = target.replace(/\.[cm]?jsx?$/, "");
        row.target = [target, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.js"].map(ext => stem + ext)].find(path => sourcePaths.has(path)) ?? row.target;
        row.snippet = (row.path + " -> " + row.target).slice(0, 400);
      }
      if (sourceExt.test(row.path)) {
        const matches = snapshot.layers.filter(rule => rule.paths.some(p => glob(p).test(row.path)) && !rule.exclude?.some(p => glob(p).test(row.path)));
        if (matches.length === 1) { row.layer = matches[0]!.name; row.layer_ref = matches[0]!.ref; }
        if (matches.length > 1) truncated.add("ambiguous_layer_rules");
      }
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size > budgets[kind] || outputBytes + size > MAX_OUTPUT - 1024) { truncated.add("output_limit"); continue; }
      snapshot.items.push(row); outputBytes += size; budgets[kind] -= size;
    }
  }
  snapshot.truncated = [...truncated].sort();
  if (!clean || truncated.size) {
    const nextRevision = createHash("sha256").update(contentHash + JSON.stringify(snapshot)).digest("hex").slice(0, 12);
    const replace = (ref: string) => ref.replace("code:" + project + ":" + revision + ":", "code:" + project + ":" + nextRevision + ":");
    snapshot.revision = nextRevision;
    for (const item of snapshot.items) { item.ref = replace(item.ref); if (item.layer_ref) item.layer_ref = replace(item.layer_ref); }
    for (const layer of snapshot.layers) layer.ref = replace(layer.ref);
  }
  return snapshot;
}
