import { isWorkstreamEnabled } from "./workstream-config.js";
import { readBranchDraft } from "./branch-drafts.js";
import type { RecallHit, RetrievalCandidateDecision } from "./contracts/retrieval.js";
import { readIndexedCaptureEvent, listFreshCaptureEvidence, withCaptureIndexMutation, withCaptureIndexDb, withReadonlyCaptureIndex } from "./capture.js";
import { captureCoreRawTurnId, captureTurnId } from "./capture-ingest.js";
import { effectiveBranches } from "./capture-branch-assignments.js";
import { l1VisibleInBranch } from "./core/workstream/visibility.js";

export async function filterBranchL1Hits(stateRoot: string, account: string, branch: string, hits: RecallHit[], dropped: RetrievalCandidateDecision[]): Promise<RecallHit[]> {
  if (!hits.some(hit => hit.memoryLayer === "L1")) return hits;
  // The Core ids are non-invertible hashes. Lazily backfill a persistent identity
  // index once for legacy captures, then read only newly unindexed events.
  const lookup = () => withReadonlyCaptureIndex(stateRoot, account, db => {
    const found = new Map<string, string>();
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workstream_capture_ids'").get()) return found;
    const get = db.prepare("SELECT event_id FROM workstream_capture_ids WHERE account_id=? AND turn_id=? UNION ALL SELECT event_id FROM workstream_capture_ids WHERE account_id=? AND raw_id=?");
    for (const hit of hits.filter(h => h.memoryLayer === "L1")) {
      const row = get.get(account, hit.id, account, hit.id) as { event_id: string } | undefined;
      if (row) found.set(hit.id, row.event_id);
    }
    return found;
  });
  let eventByCoreId = await lookup();
  if (hits.some(hit => hit.memoryLayer === "L1" && !eventByCoreId.has(hit.id))) {
    await indexCaptureIdentities(stateRoot, account);
    eventByCoreId = await lookup();
  }
  const assignments = await effectiveBranches(stateRoot, account, [...eventByCoreId.values()]);
  return hits.filter(hit => {
    if (hit.memoryLayer !== "L1") return true;
    const event = eventByCoreId.get(hit.id);
    if (event && l1VisibleInBranch(assignments.get(event) ?? "main", branch)) return true;
    dropped.push({ id: hit.id, memoryLayer: "L1", result: "dropped", reason: "other_branch" });
    return false;
  });
}

export async function listFreshBranchEvidence(stateRoot: string, account: string, branch: string,
  options: Parameters<typeof listFreshCaptureEvidence>[2], dropped: RetrievalCandidateDecision[]) {
  // Bounded over-fetch is independent of the fresh-L1 relevance/order policy.
  const captures = await listFreshCaptureEvidence(stateRoot, account, { ...options, candidateLimit: 64 });
  const assignments = await effectiveBranches(stateRoot, account, captures.map(e => e.event_id));
  const visible = captures.filter(event => {
    if (l1VisibleInBranch(assignments.get(event.event_id) ?? "main", branch)) return true;
    dropped.push({ id: event.event_id, memoryLayer: "L1", source: "memhub-capture", result: "dropped", reason: "other_branch" });
    return false;
  }).slice(0, options.limit);
  if (visible.length >= options.limit) return visible;
  // Scope the fallback SQL page before LIMIT so a busy sibling cannot starve
  // this branch behind arbitrarily many recent foreign turns.
  const scoped = await listFreshCaptureEvidence(stateRoot, account, { ...options, branchId: branch });
  const latest = await effectiveBranches(stateRoot, account, scoped.map(e => e.event_id));
  return scoped.filter(event => l1VisibleInBranch(latest.get(event.event_id) ?? "main", branch));
}

async function indexCaptureIdentities(stateRoot: string, account: string): Promise<void> {
  // Establish/reconcile the existing capture index before its mutation lock.
  await withReadonlyCaptureIndex(stateRoot, account, () => undefined);
  await withCaptureIndexMutation(stateRoot, () => withCaptureIndexDb(stateRoot, async db => {
    db.exec(`CREATE TABLE IF NOT EXISTS workstream_capture_ids (
      account_id TEXT NOT NULL, event_id TEXT NOT NULL, turn_id TEXT NOT NULL, raw_id TEXT NOT NULL,
      PRIMARY KEY(account_id,event_id));
      CREATE INDEX IF NOT EXISTS idx_workstream_turn ON workstream_capture_ids(account_id,turn_id);
      CREATE INDEX IF NOT EXISTS idx_workstream_raw ON workstream_capture_ids(account_id,raw_id);`);
    const missing = db.prepare(`SELECT c.* FROM capture_index c LEFT JOIN workstream_capture_ids w
      ON c.account_id=w.account_id AND c.event_id=w.event_id WHERE c.account_id=? AND w.event_id IS NULL`).all(account);
    const put = db.prepare("INSERT OR IGNORE INTO workstream_capture_ids VALUES (?,?,?,?)");
    for (const raw of missing) {
      const row = raw as { event_id: string };
      try {
        const event = await readIndexedCaptureEvent(stateRoot, { account_id: account, event_id: row.event_id } as Parameters<typeof readIndexedCaptureEvent>[1]);
        put.run(account, event.event_id, captureTurnId(account, event.host, event.event_id), captureCoreRawTurnId(account, event.host, event.event_id));
      } catch { /* Unreadable captures cannot prove identity; retry after repair. */ }
    }
  }));
}

export async function branchDraftContext(stateRoot: string, account: string, project: string, branch: string) {
  if (branch === "main" || !await isWorkstreamEnabled(stateRoot, account, project)) return undefined;
  const draft = await readBranchDraft(stateRoot, account, project, branch);
  if (!draft || draft.status !== "open") return undefined;
  const block: { branch_id: string; events: { date: string; title_en: string; title_zh: string; summary: string; evidence_refs: string[] }[]; omitted: number } = {
    branch_id: branch, events: [], omitted: draft.events.length - (draft.merged_event_count ?? 0)
  };
  for (const { event } of draft.events.slice(draft.merged_event_count ?? 0).reverse().slice(0, 8)) {
    const item = { date: event.date, title_en: event.title_en, title_zh: event.title_zh,
      summary: `${event.body_en} / ${event.body_zh}`.slice(0, 300), evidence_refs: event.evidence_refs };
    block.events.push(item); block.omitted--;
    if (JSON.stringify(block).length > 2500) { block.events.pop(); block.omitted++; break; }
  }
  return block;
}
