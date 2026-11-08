#!/usr/bin/env node
// P7 secondary measure (eval harness only; LITSAN owns no model call): end-to-end answer correctness.
// usage: node answer-eval.mjs <questions.json> <responses.json> <arm> <out.json>
// One luna-low answer call sees only the delivered context (raw turns + facts); a second luna-low call grades
// it against the gold answer. Calls are cached by sha256 (see followup.mjs). Writes {id: {answer, correct, ms, calls}}.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { cachedCall, parseContext } from "./followup.mjs";

const [, , qfile, respFile, arm, outFile] = process.argv;
const CONCURRENCY = Number(process.env.FU_CONCURRENCY ?? 8);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const ANSWER_HEAD = `You answer questions about a long conversation between two people using ONLY the memory excerpts below (raw conversation turns with dates, and short derived facts). Dates in turns are the time the turn was said; resolve relative times (e.g. "last Friday") against that date. If the excerpts do not contain the answer, give your best answer from them. Keep the answer short (a few words or one sentence). Reply with JSON only: {"id": "<id>", "answer": "<answer>"}.`;
const JUDGE_HEAD = `Grade a model answer against the gold answer. The answer is correct if it expresses the same fact as the gold answer (same entity/number/date; equivalent wording or date format is fine; extra harmless detail is fine). It is incorrect if it differs, is missing key items of a list, or says it cannot tell. Reply with JSON only: {"id": "<id>", "correct": true|false}.`;

const rows = Object.values(JSON.parse(await readFile(qfile, "utf8"))).flat().filter((r) => r.evidence?.length);
const resp = JSON.parse(await readFile(respFile, "utf8"));
const result = (await exists(outFile)) ? JSON.parse(await readFile(outFile, "utf8")) : {};
const todo = rows.filter((r) => resp[r.id] && !result[r.id]);
let next = 0, done = 0;

async function ask(tag, head, payload, id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = `${head}\n${JSON.stringify(payload)}${attempt ? "\nEnsure the response is valid JSON with all quotation marks inside strings escaped." : ""}`;
    try { const { answer, ms } = await cachedCall(tag, prompt); if (answer?.id === id || Array.isArray(answer)) return { answer: Array.isArray(answer) ? answer[0] : answer, ms, attempt }; }
    catch { /* retry once */ }
  }
  return null;
}

async function worker() {
  for (;;) {
    const r = todo[next++]; if (!r) return;
    const { raw, facts } = parseContext(resp[r.id].text);
    const context = { raw_turns: raw.map((x) => x.text), facts: facts.map((x) => x.text) };
    const a = await ask(`ans-${arm}`, ANSWER_HEAD, { id: r.id, question: r.question, context }, r.id);
    let entry = { answer: null, correct: false, ok: false, calls: 1, ms: 0 };
    if (a?.answer?.answer != null) {
      const j = await ask("judge", JUDGE_HEAD, { id: r.id, question: r.question, gold: r.gold, answer: String(a.answer.answer) }, r.id);
      entry = { answer: String(a.answer.answer), correct: j?.answer?.correct === true, ok: !!j, calls: 2 + a.attempt + (j?.attempt ?? 0), ms: a.ms + (j?.ms ?? 0) };
    }
    result[r.id] = entry;
    if (++done % 20 === 0) { await writeFile(outFile, JSON.stringify(result)); console.log(arm, "answered", done, "/", todo.length); }
  }
}
await mkdir(new URL(".", `file://${outFile.startsWith("/") ? outFile : process.cwd() + "/" + outFile}`).pathname, { recursive: true }).catch(() => {});
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await writeFile(outFile, JSON.stringify(result));
const all = rows.map((r) => result[r.id]).filter(Boolean);
console.log(arm, "n", all.length, "correct", all.filter((x) => x.correct).length, "failed", all.filter((x) => !x.ok).length);
