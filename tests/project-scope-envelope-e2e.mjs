import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestRoot } from "./test-isolation.mjs";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { buildRetrievalScopeEnvelope, resolveProjectScope } from "../dist/project-scope.js";

const deterministic = resolveProjectScope({ namespaceProjectId: "memhub", workspaceProjectId: "memhub" });
assert.equal(deterministic.projectId, "memhub");
assert.equal(deterministic.source, "deterministic_binding");

const conflict = resolveProjectScope({ namespaceProjectId: "memhub", workspaceProjectId: "other" });
assert.equal(conflict.projectId, null);
assert.equal(conflict.recallScope, "global_only");
assert.equal(conflict.source, "ambiguous");

const semanticConflict = resolveProjectScope({ semanticProjectIds: ["alpha", "beta"] });
assert.equal(semanticConflict.projectId, null);
assert.deepEqual(semanticConflict.candidates, ["alpha", "beta"]);

const globalOnly = buildRetrievalScopeEnvelope({
  accountId: "acct",
  resolution: resolveProjectScope({}),
  crossProjectSkillAllowed: false
});
assert.equal(globalOnly.primaryProject, null);
assert.equal(globalOnly.globalAllowed, true);
assert.deepEqual(globalOnly.projectStorageIds, []);

const skillEnvelope = buildRetrievalScopeEnvelope({
  accountId: "acct",
  resolution: deterministic,
  projectStorageIds: ["memhub", "memhub-old"],
  reusableSkillProjectIds: ["memhub", "selfmedia"],
  crossProjectSkillAllowed: true
});
assert.deepEqual(skillEnvelope.reusableSkillProjectIds, ["memhub", "selfmedia"]);
assert.deepEqual(skillEnvelope.projectStorageIds, ["memhub", "memhub-old"]);

const root = await createTestRoot("scope-envelope-");
try {
  const registry = new JsonProjectRegistry(join(root, "projects.json"));
  await registry.create("acct-a", { projectId: "memhub", description: "A", aliases: ["memory-hub"] });
  await registry.create("acct-b", { projectId: "memhub", description: "B", aliases: ["memory-hub"] });
  assert.equal(await registry.resolve("acct-a", "memory-hub"), "memhub");
  assert.equal(await registry.resolve("acct-b", "memory-hub"), "memhub");
  assert.equal((await registry.list("acct-a")).length, 1);
  assert.equal((await registry.list("acct-b")).length, 1);
  await registry.archive("acct-a", "memhub");
  assert.equal(await registry.resolve("acct-a", "memhub"), null, "archived project is not routable by default");
  assert.equal(await registry.resolve("acct-a", "memhub", { includeArchived: true }), "memhub");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("memhub-project-scope-envelope-e2e: ok");
