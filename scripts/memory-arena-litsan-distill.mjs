#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { listCaptureEvents } from "../dist/capture.js";
import { enqueueDistillationJob } from "../dist/distillation-jobs.js";
import { distillationEvidenceDocument } from "../dist/distillation-transport.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VERSION = valueArg("--version") ?? "arena_smoke_20261023";
const STATE_ROOT = resolve(ROOT, valueArg("--state-root") ?? ".review-runtime/memory-arena/state/memhub/server");
const ACCOUNT_ID = valueArg("--account-id") ?? "memory-arena-account";
const MCP_URL = valueArg("--mcp-url") ?? "http://127.0.0.1:19111/mcp";
const LLM_BASE_URL = (valueArg("--llm-base-url") ?? "http://127.0.0.1:19095/v1").replace(/\/$/, "");
const HARNESS = valueArg("--source-harness") ?? "memory-arena-deepseek";
const MODEL = valueArg("--model") ?? "deepseek-flash";
const THINKING = valueArg("--thinking") ?? "disabled";
const ONLY_PROJECT = valueArg("--project");
const MANIFEST_PATH = resolve(ROOT, ".review-runtime", "memory-arena", `memhub-distill-${VERSION}.json`);

const client = new Client({ name: "memhub-memory-arena-distiller", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

try {
  const captures = await listCaptureEvents(STATE_ROOT, ACCOUNT_ID);
  const projects = benchmarkProjects(VERSION).filter((project) => !ONLY_PROJECT || project.project === ONLY_PROJECT);
  const manifest = await loadManifest();

  for (const project of projects) {
    const existing = manifest.projects.find((item) => item.project === project.project && item.status === "completed");
    if (existing) {
      console.log(`\n[${project.conv_idx}/${project.speaker}] ${project.project}: already completed, skipping`);
      continue;
    }
    const projectCaptures = captures.filter((capture) => capture.project_hint === project.project);
    if (!projectCaptures.length) {
      manifest.projects.push({ ...project, status: "missing_captures" });
      continue;
    }

    console.log(`\n[${project.conv_idx}/${project.speaker}] ${project.project}: ${projectCaptures.length} captures`);
    const queued = await enqueueDistillationJob({
      stateRoot: STATE_ROOT,
      accountId: ACCOUNT_ID,
      projectId: project.project,
      captures: projectCaptures,
      reason: "manual"
    });

    const l2Lease = await leaseJob(queued.job, "l2", project.project);
    const l2Evidence = await fullEvidence(l2Lease);
    const l2Content = await chat([
      {
        role: "system",
        content: [
          "You are the semantic distillation harness for LITSAN L2 project timelines.",
          "Use only the supplied canonical evidence. Do not invent facts.",
          "Preserve dates, named entities, relationships, preferences, plans, events, changes, corrections and superseded history needed for later question answering.",
          "Prefer high recall over aggressive compression, but remove conversational filler.",
          "When later evidence updates an earlier fact, keep both the historical state and the latest state with explicit chronology.",
          "Write a complete canonical replacement, not a delta.",
          "Follow LITSAN's bilingual contract: English first, then paired Simplified Chinese for each section/item.",
          "Return only the markdown artifact, no preamble and no code fence."
        ].join("\n")
      },
      {
        role: "user",
        content: `Project: ${project.project}\n\nCanonical L1 evidence:\n${l2Evidence}`
      }
    ], 8192);

    const l2Submit = await tool("memhub_distill", {
      action: "submit",
      job_id: l2Lease.job.job_id,
      content: l2Content,
      source_harness: HARNESS,
      lease_token: l2Lease.job.lease_token
    });

    const l3JobId = l2Submit?.next_layer_job?.job?.job_id;
    if (!l3JobId) throw new Error(`L2 submit for ${project.project} did not enqueue L3`);
    const l3Lease = await leaseJob(l2Submit.next_layer_job.job, "l3", project.project);
    const l3Evidence = await fullEvidence(l3Lease);
    const l3Content = await chat([
      {
        role: "system",
        content: [
          "You are the semantic distillation harness for LITSAN L3 Current Truth / project profile.",
          "Use only the supplied L2 evidence. Do not invent facts.",
          "Extract the current, durable state that is useful for future question answering: stable preferences, relationships, goals, commitments, ongoing projects, current possessions/roles/locations, and durable decisions.",
          "Resolve updates temporally: the newest supported state is current, while important superseded states may be noted as history when needed to avoid contradictions.",
          "Do not discard concrete named facts merely because they seem minor; LoCoMo-style questions may ask about them later.",
          "Follow LITSAN's bilingual contract: English first, then paired Simplified Chinese for each section/item.",
          "Return only the markdown artifact, no preamble and no code fence."
        ].join("\n")
      },
      { role: "user", content: `Project: ${project.project}\n\nCanonical L2 evidence:\n${l3Evidence}` }
    ], 8192);

    const l3Submit = await tool("memhub_distill", {
      action: "submit",
      job_id: l3Lease.job.job_id,
      content: l3Content,
      source_harness: HARNESS,
      lease_token: l3Lease.job.lease_token
    });

    const record = {
      ...project,
      status: "completed",
      capture_count: projectCaptures.length,
      l1_chars: projectCaptures.reduce((sum, item) => sum + (item.user_text?.length ?? 0) + (item.assistant_text?.length ?? 0), 0),
      l2_job_id: l2Lease.job.job_id,
      l2_memory_id: l2Submit?.memory?.id ?? null,
      l2_chars: l2Content.length,
      l3_job_id: l3Lease.job.job_id,
      l3_memory_id: l3Submit?.memory?.id ?? null,
      l3_chars: l3Content.length
    };
    manifest.projects.push(record);
    await persist(manifest);
    console.log(`  L2 ${record.l2_chars} chars; L3 ${record.l3_chars} chars`);
  }

  manifest.completed_at = new Date().toISOString();
  await persist(manifest);
  console.log(`\nmanifest=${MANIFEST_PATH}`);
} finally {
  await client.close();
}

async function leaseJob(job, kind, project) {
  const jobId = job.job_id;
  if (job.status === "leased" && job.leased_by === HARNESS && job.lease_token) {
    try {
      const resumed = await tool("memhub_distill", {
        action: "next",
        job_id: jobId,
        source_harness: HARNESS,
        lease_token: job.lease_token,
        evidence_offset: 0,
        evidence_chunk_chars: 200000
      });
      if (resumed?.job?.job_id !== jobId) throw new Error(`Resume returned wrong job for ${project}`);
      return resumed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/lease has expired/i.test(message)) throw error;
      // Opaque leases fence generations, but an expired generation is
      // eligible for reassignment.  Re-lease by scope/target so Core assigns
      // a fresh token to this exact expired job instead of trying to reuse the
      // stale token from a previous interrupted Arena run.
      const reassigned = await tool("memhub_distill", {
        action: "next",
        kind,
        scope: "project",
        project,
        workspace_project: project,
        source_harness: HARNESS,
        lease_token_supported: true,
        lease_seconds: 900,
        evidence_chunk_chars: 200000
      });
      if (reassigned?.job?.job_id !== jobId) {
        throw new Error(`Expected expired ${kind} job ${jobId} for ${project}, got ${reassigned?.job?.job_id ?? "none"}`);
      }
      return reassigned;
    }
  }
  if (job.status !== "pending") {
    throw new Error(`Cannot lease ${kind} job ${jobId} for ${project}: status=${job.status}`);
  }
  const leased = await tool("memhub_distill", {
    action: "next",
    kind,
    scope: "project",
    project,
    workspace_project: project,
    source_harness: HARNESS,
    lease_token_supported: true,
    lease_seconds: 900,
    evidence_chunk_chars: 200000
  });
  if (leased?.job?.job_id !== jobId) {
    throw new Error(`Expected ${kind} job ${jobId} for ${project}, got ${leased?.job?.job_id ?? "none"}`);
  }
  return leased;
}

async function fullEvidence(first) {
  if (first.evidence_transport?.mode === "inline") {
    return distillationEvidenceDocument(first.job);
  }
  let text = first.evidence_chunk ?? "";
  let current = first;
  while (current.evidence_transport?.next_offset != null) {
    current = await tool("memhub_distill", {
      action: "next",
      job_id: first.job.job_id,
      source_harness: HARNESS,
      lease_token: first.job.lease_token,
      evidence_offset: current.evidence_transport.next_offset,
      evidence_chunk_chars: 200000
    });
    text += current.evidence_chunk ?? "";
  }
  return text;
}

async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text payload`);
  if (result.isError) throw new Error(`${name}: ${text}`);
  let parsed = JSON.parse(text);
  if (parsed?.result_transport?.mode === "chunked" && typeof parsed.result_chunk === "string") {
    let combined = parsed.result_chunk;
    let transport = parsed.result_transport;
    while (transport.next_offset != null) {
      const continuation = await client.callTool({
        name: "memhub_result",
        arguments: {
          result_id: transport.result_id,
          offset: transport.next_offset,
          chunk_chars: 100000
        }
      });
      const continuationText = continuation.content?.find((item) => item.type === "text")?.text;
      if (!continuationText || continuation.isError) {
        throw new Error(`memhub_result continuation failed for ${transport.result_id}`);
      }
      const next = JSON.parse(continuationText);
      if (typeof next.result_chunk !== "string") throw new Error("memhub_result returned no result_chunk");
      combined += next.result_chunk;
      transport = next.result_transport;
    }
    parsed = JSON.parse(combined);
  }
  return parsed;
}

async function chat(messages, maxTokens) {
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer arena-local-proxy" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: maxTokens })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`LLM proxy ${response.status}: ${text.slice(0,1000)}`);
  const payload = JSON.parse(text);
  const content = payload?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`LLM returned empty content: ${text.slice(0,1000)}`);
  return content;
}

function benchmarkProjects(version) {
  const out = [];
  for (let convIdx = 0; convIdx < 10; convIdx += 1) {
    for (const speaker of ["speaker_a", "speaker_b"]) {
      const userId = `locomo_exp_user_${convIdx}_${speaker}_${version}`;
      const digest = createHash("sha256").update(userId).digest("hex").slice(0, 16);
      out.push({ conv_idx: convIdx, speaker, user_id: userId, project: `arena-${digest}-g0` });
    }
  }
  return out;
}

async function persist(manifest) {
  await mkdir(resolve(ROOT, ".review-runtime", "memory-arena"), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

async function loadManifest() {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    if (parsed?.version === VERSION && Array.isArray(parsed.projects)) return parsed;
  } catch {}
  return {
    version: VERSION,
    account_id: ACCOUNT_ID,
    model: MODEL,
    thinking: THINKING,
    source_harness: HARNESS,
    started_at: new Date().toISOString(),
    projects: []
  };
}

function valueArg(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
