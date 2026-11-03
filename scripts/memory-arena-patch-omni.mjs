#!/usr/bin/env node
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OMNI = resolve(ROOT, ".review-runtime", "memory-arena", "OmniMemEval");
const FACTORY = resolve(OMNI, "scripts", "client_factory");
const registryPath = resolve(FACTORY, "registry.py");
const genericSearchPath = resolve(OMNI, "scripts", "utils", "search_helpers.py");
const locomoSearchPath = resolve(OMNI, "scripts", "locomo", "locomo_search.py");
const locomoIngestionPath = resolve(OMNI, "scripts", "locomo", "locomo_ingestion.py");
const locomoResponsesPath = resolve(OMNI, "scripts", "locomo", "locomo_responses.py");
const nlpMetricsPath = resolve(OMNI, "scripts", "utils", "nlp_metrics.py");
await mkdir(FACTORY, { recursive: true });
await copyFile(resolve(ROOT, "benchmarks", "memory-arena", "omni", "litsan_client.py"), resolve(FACTORY, "litsan_client.py"));
await copyFile(resolve(ROOT, "benchmarks", "memory-arena", "omni", "everos_current_client.py"), resolve(FACTORY, "everos_current_client.py"));
await copyFile(resolve(ROOT, "benchmarks", "memory-arena", "omni", "mem0_local_client.py"), resolve(FACTORY, "mem0_local_client.py"));
let registry = await readFile(registryPath, "utf8");
if (!registry.includes('"memhub":')) {
  const marker = "_LIB_CLIENT_REGISTRY = {";
  if (!registry.includes(marker)) throw new Error("OmniMemEval registry marker not found");
  registry = registry.replace(marker, `${marker}\n    "memhub":      ("litsan_client",      "LitsanClient"),`);
  await writeFile(registryPath, registry);
}
registry = await readFile(registryPath, "utf8");
registry = registry.replace(/("memhub":\s*)\("memhub_client",\s*"MemhubClient"\)/g, '$1("litsan_client", "LitsanClient")');
registry = registry.replace(
  '"everos":      ("everos_client",      "EverosClient"),',
  '"everos":      ("everos_current_client", "EverosCurrentClient"),'
);
registry = registry.replace(
  '"mem0":        ("mem0_client",        "Mem0Client"),',
  '"mem0":        ("mem0_local_client",  "Mem0LocalClient"),'
);
await writeFile(registryPath, registry);
await addDispatchEntry(genericSearchPath, '    "memhub": generic_text_search,', 'DEFAULT_SEARCH_DISPATCH = {');
await addDispatchEntry(locomoSearchPath, '        "memhub": generic_text_search,', '    _search_dispatch = {');
await makeBertScoreLazy(nlpMetricsPath);
await makeJudgeLabelJsonCompatible(nlpMetricsPath);
await makeLocomoDataPathConfigurable(locomoIngestionPath);
await makeLocomoDataPathConfigurable(locomoSearchPath);
await makeLocomoDataPathConfigurable(locomoResponsesPath);
console.log("OmniMemEval LITSAN adapter installed");

async function addDispatchEntry(path, entry, marker) {
  let text = await readFile(path, "utf8");
  if (text.includes('"memhub": generic_text_search')) return;
  if (!text.includes(marker)) throw new Error(`OmniMemEval search dispatch marker not found in ${path}`);
  text = text.replace(marker, `${marker}\n${entry}`);
  await writeFile(path, text);
}

async function makeBertScoreLazy(path) {
  let text = await readFile(path, "utf8");
  // Remove only a module-level import.  Do not match the intentionally
  // indented lazy import when this patch is run a second time.
  text = text.replace(/^from bert_score import score as bert_score\r?\n/m, "");
  const block = /    if "semantic" in options:\r?\n(?:\s*from bert_score import score as bert_score\r?\n)?\s*metrics\["semantic"\] = \{\}/;
  if (!block.test(text)) throw new Error(`OmniMemEval semantic metric marker not found in ${path}`);
  text = text.replace(
    block,
    '    if "semantic" in options:\n        from bert_score import score as bert_score\n        metrics["semantic"] = {}'
  );
  await writeFile(path, text);
}

async function makeJudgeLabelJsonCompatible(path) {
  let text = await readFile(path, "utf8");
  if (text.includes("allowing additional fields")) return;
  const start = text.indexOf("def extract_label_json(text: str) -> str | None:\n");
  const end = text.indexOf("\n\n# ── Individual metrics", start);
  if (start < 0 || end < 0) throw new Error(`OmniMemEval label extractor marker not found in ${path}`);
  const replacement = [
    'def extract_label_json(text: str) -> str | None:',
    '    """Extract a judge label from JSON, allowing additional fields."""',
    '    if not isinstance(text, str):',
    '        return None',
    '    stripped = text.strip()',
    '    candidates = [stripped]',
    '    start = stripped.find("{")',
    '    end = stripped.rfind("}")',
    '    if start >= 0 and end > start:',
    '        candidates.append(stripped[start : end + 1])',
    '    for candidate in candidates:',
    '        try:',
    '            parsed = json.loads(candidate)',
    '        except (json.JSONDecodeError, TypeError):',
    '            continue',
    '        if isinstance(parsed, dict) and isinstance(parsed.get("label"), str):',
    '            return json.dumps({"label": parsed["label"]})',
    '    return None',
    '',
  ].join("\n");
  text = text.slice(0, start) + replacement + text.slice(end);
  await writeFile(path, text);
}

async function makeLocomoDataPathConfigurable(path) {
  let text = await readFile(path, "utf8");
  const original = 'pd.read_json("data/locomo/locomo10.json")';
  const replacement = 'pd.read_json(os.getenv("LOCOMO_DATA_PATH", "data/locomo/locomo10.json"))';
  if (text.includes(replacement)) return;
  if (!text.includes(original)) throw new Error(`LoCoMo data path marker not found in ${path}`);
  text = text.replaceAll(original, replacement);
  await writeFile(path, text);
}

