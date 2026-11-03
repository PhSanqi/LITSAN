import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeCaptureIndexDb, storeCaptureEvent } from "../dist/capture.js";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { executeUserAuthorizedMemory, planUserAuthorizedMemory } from "../dist/user-authorized-memory.js";

const accountId = "acct-governance";
const OLD_L4 = "# Cross-project User Profile\n\nSuperseded profile text.\n已被取代的旧画像。";
const CANON_L4 = "# Cross-project User Profile\n\nCurrent canonical profile.\n当前规范画像。";
const PROPOSED_L4 = "# Cross-project User Profile\n\nApproved replacement.\n已批准的替换文本。";

// Core keeps listing the superseded L4 as active, which is what let the
// incident's stale base pass the old "active and content matches" check.
async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), "litsan-governance-"));
  t.after(async () => { closeCaptureIndexDb(stateRoot); await rm(stateRoot, { recursive: true, force: true }); });
  const core = new Map([
    ["user_profile_old", { id: "user_profile_old", body: OLD_L4, status: "activated" }],
    ["user_profile_canon", { id: "user_profile_canon", body: CANON_L4, status: "activated" }]
  ]);
  const writes = [];
  const runtime = {
    accountId,
    userId: "user-governance",
    source: { platform: "governance-test", transport: "test" },
    memoryClient: { async viewerGet(path) {
      assert.match(path, /^\/api\/v1\/l4\?/);
      return { items: [...core.values()].map((item) => ({ ...item })) };
    } },
    memory: { async distill(input) {
      writes.push(input);
      core.get("user_profile_canon").body = input.content;
      return { id: "user_profile_canon" };
    } }
  };
  const seed = async (resultId, content, committedAt) => {
    const job = await recordCompletedDistillationRevision({
      stateRoot, accountId, target: "l4", projectId: null, resultId, content, committedAt, coreBody: content,
      evidence: [{ ref: `l1:seed-${resultId}-${committedAt}`, kind: "turn", layer: "L1", timestamp: committedAt, content: "seed" }]
    });
    return `l4:${resultId}:${job.job_id}`;
  };
  const oldRef = await seed("user_profile_old", OLD_L4, "2026-10-01T00:00:00.000Z");
  const canonRef = await seed("user_profile_canon", CANON_L4, "2026-11-01T00:00:00.000Z");
  let turn = 0;
  const confirm = async (timestamp = new Date().toISOString()) => {
    const eventId = `confirm-${++turn}`;
    await storeCaptureEvent(stateRoot, { actor_id: "user-governance", account_id: accountId }, {
      event_id: eventId, host: "test", conversation_id: "conv", continuity_id: "conv", timestamp,
      user_text: "Confirmed. Write exactly that full L4 replacement.", capture_status: "open"
    });
    return `l1:${eventId}`;
  };
  return { stateRoot, runtime, core, writes, seed, oldRef, canonRef, confirm };
}

test("plan rejects a superseded L4 base that Core still lists as active", async (t) => {
  const { stateRoot, runtime, writes, oldRef, canonRef } = await fixture(t);
  await assert.rejects(
    planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: oldRef }),
    (error) => /not the current canonical L4 revision/.test(error.message) && error.message.includes(canonRef)
  );
  const plan = await planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: canonRef });
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.equal(plan.current_evidence_ref, canonRef);
  assert.equal(writes.length, 0);
});

test("plan rejects an older revision of the canonical memory even when its body matches", async (t) => {
  const { stateRoot, runtime, seed, canonRef } = await fixture(t);
  const newerRef = await seed("user_profile_canon", CANON_L4, "2026-11-02T00:00:00.000Z");
  assert.notEqual(newerRef, canonRef);
  await assert.rejects(
    planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: canonRef }),
    /not the current canonical L4 revision/
  );
});

test("execute refuses when another revision became canonical after the plan", async (t) => {
  const { stateRoot, runtime, writes, seed, canonRef, confirm } = await fixture(t);
  const plan = await planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: canonRef });
  await seed("user_profile_old", OLD_L4, new Date(Date.now() + 1000).toISOString());
  await assert.rejects(
    executeUserAuthorizedMemory({ stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: await confirm() }),
    /changed after plan/
  );
  assert.equal(writes.length, 0);
});

test("a refused execute does not consume the authorization", async (t) => {
  const { stateRoot, runtime, core, writes, canonRef, confirm } = await fixture(t);
  const plan = await planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: canonRef });
  const preplanConfirmation = await confirm("2026-01-01T00:00:00.000Z");
  await assert.rejects(
    executeUserAuthorizedMemory({ stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: preplanConfirmation }),
    /captured after this plan was created/
  );
  await assert.rejects(
    executeUserAuthorizedMemory({ stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: "not-an-l1-ref" }),
    /exact l1:<event-id>/
  );
  assert.equal(writes.length, 0);

  const result = await executeUserAuthorizedMemory({
    stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: await confirm()
  });
  assert.equal(result.ok, true);
  assert.equal(result.previous_evidence_ref, canonRef);
  assert.equal(writes.length, 1);
  assert.equal(core.get("user_profile_canon").body.trim(), PROPOSED_L4);

  await assert.rejects(
    executeUserAuthorizedMemory({ stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: await confirm() }),
    /invalid or already-used L3\/L4 authorization/
  );
  assert.equal(writes.length, 1);
});

test("concurrent executes of one authorization write at most once", async (t) => {
  const { stateRoot, runtime, writes, canonRef, confirm } = await fixture(t);
  const plan = await planUserAuthorizedMemory({ stateRoot, runtime, kind: "l4", projectId: null, content: PROPOSED_L4, baseEvidenceRef: canonRef });
  const ref = await confirm();
  const results = await Promise.allSettled([1, 2].map(() =>
    executeUserAuthorizedMemory({ stateRoot, runtime, authorizationId: plan.authorization_id, confirmationEvidenceRef: ref })));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(results.find((item) => item.status === "rejected").reason.message, /already-used/);
  assert.equal(writes.length, 1);
});
