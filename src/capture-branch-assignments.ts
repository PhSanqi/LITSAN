import type Database from "better-sqlite3";
import { withCaptureIndexDb, withCaptureIndexMutation, withReadonlyCaptureIndex } from "./capture.js";

export interface CaptureBranchAssignment {
  id: number; account_id: string; project_id: string; event_id: string; branch_id: string;
  workstream_key: string | null; reason: string; actor: string; created_at: string;
}
const exists = (db: Database.Database | null) => Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE name='capture_branch_assignments'").get());

export async function assignEventBranch(stateRoot: string, input: Omit<CaptureBranchAssignment, "id">, onlyIfUnassigned = false): Promise<boolean> {
  return withCaptureIndexMutation(stateRoot, () => withCaptureIndexDb(stateRoot, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS capture_branch_assignments (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, event_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, workstream_key TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_capture_branch_event ON capture_branch_assignments(account_id,event_id,id);
    CREATE INDEX IF NOT EXISTS idx_capture_branch_key ON capture_branch_assignments(account_id,project_id,workstream_key,id);`);
    return db.transaction(() => {
      const prior = db.prepare("SELECT * FROM capture_branch_assignments WHERE account_id=? AND event_id=? ORDER BY id DESC LIMIT 1")
        .get(input.account_id, input.event_id) as CaptureBranchAssignment | undefined;
      if (prior && onlyIfUnassigned) return false;
      db.prepare(`INSERT INTO capture_branch_assignments
        (account_id,project_id,event_id,branch_id,workstream_key,reason,actor,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(input.account_id, input.project_id, input.event_id, input.branch_id, input.workstream_key, input.reason, input.actor, input.created_at);
      return true;
    })();
  }));
}

export async function eventBranchAssignment(stateRoot: string, account: string, eventId: string): Promise<CaptureBranchAssignment | undefined> {
  return withReadonlyCaptureIndex(stateRoot, account, db => exists(db) ? db!.prepare(
    "SELECT * FROM capture_branch_assignments WHERE account_id=? AND event_id=? ORDER BY id DESC LIMIT 1"
  ).get(account, eventId) as CaptureBranchAssignment | undefined : undefined);
}

export async function effectiveBranches(stateRoot: string, account: string, eventIds: string[]): Promise<Map<string, string>> {
  return withReadonlyCaptureIndex(stateRoot, account, db => {
    const branches = new Map(eventIds.map(id => [id, "main"]));
    if (exists(db)) {
      const get = db!.prepare("SELECT branch_id FROM capture_branch_assignments WHERE account_id=? AND event_id=? ORDER BY id DESC LIMIT 1");
      for (const id of branches.keys()) {
        const row = get.get(account, id) as { branch_id: string } | undefined;
        if (row) branches.set(id, row.branch_id);
      }
    }
    return branches;
  });
}

export async function listEventsByKey(stateRoot: string, account: string, project: string, key: string): Promise<string[]> {
  return withReadonlyCaptureIndex(stateRoot, account, db => exists(db) ? (db!.prepare(`
    SELECT a.event_id FROM capture_branch_assignments a WHERE a.account_id=? AND a.project_id=? AND a.workstream_key=?
    AND a.id=(SELECT MAX(b.id) FROM capture_branch_assignments b WHERE b.account_id=a.account_id AND b.event_id=a.event_id)
    ORDER BY a.id`).all(account, project, key) as { event_id: string }[]).map(row => row.event_id) : []);
}
