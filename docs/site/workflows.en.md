# Everyday workflows

The workflows below assume you have installed your own LITSAN instance. Public examples are fictional; only your authenticated workspace or connector can access and continue your own projects.

LITSAN should reduce the amount of background you need to repeat. The normal flow is: confirm scope, see next work and recent continuity, continue the project, and trace deeper only when needed.

## Confirm scope before work

Account is the stable human boundary. Devices, models, transports, and harnesses are provenance. Project is the primary business-memory boundary. Current workspace/project evidence determines project scope; host conversation identity does not. Ambiguous evidence should not be guessed into a project.

“All projects” is a portfolio view, not a giant combined project. Select one project to expand Current Truth, TODOs, chronology, and provenance.

## Continue an existing project

Choose the project, read Next and Recent continuity/Current Truth, then start work. Only open full L2/L1 when the short recovery view is insufficient. Normal context recall favors account L4 + current project L3/L2 + reusable Skills.

Before ending the session, leave an explicit project TODO for work the next AI session should continue. TODOs are action state, not a substitute for durable rules.

## Create and disambiguate projects

A project registry entry should have a stable slug and a description useful for routing. Similar projects need explicit aliases/descriptions. Merge converts the source project into a historical alias; delete is logical and changes active routing without physically rewriting durable history.

## Manage TODOs

Keep TODO text executable: “rerun Windows installer smoke and record the result,” not “continue optimization.” Mark completed or abandoned work so Overview remains actionable. If a TODO becomes a stable rule, let it enter chronology/profile through evidence rather than keeping it forever as a pending action.

For `litsan_todo` add, generate a unique UUID first and pass it as `todo_id`. If the reply is lost, retry with the same project, UUID, and text: the original TODO is returned without changing its status. Reusing that UUID for different text or another project in the same account is rejected. Without `todo_id`, each add creates a new TODO; read the list before retrying.

## Use the four memory layers

L1 is source evidence. L2 is project chronology. L3 is stable project rules and experience. L4 is account-level profile supported across projects. The layers answer different questions and should not be collapsed into one summary.

Skill is orthogonal: it is a reusable procedure, not L5. It can travel across projects without importing source-project business facts.

Skill telemetry records selected/loaded/invoked/success/failure/user-correction stages. Repeated successful executions are stronger evidence than a procedure that merely looks reusable in text. Promotion state therefore moves from insufficient evidence to candidate/proven as successful execution evidence accumulates; it remains a governance signal and never bypasses revision/retire authorization.

## Trace a conclusion

Start at the durable conclusion, inspect project/time/provenance, trace through L2 chronology, then open L1 when original evidence is required. Do not start routine work by scanning thousands of raw turns.

## Continue across chats and devices

In a new chat, provide current project/workspace evidence and let the harness recall context. On Server Edition, multiple clients can share one stable account while retaining project isolation. Revoking one client/OAuth credential should not erase account memory.

## Processing workflow

User sees processing status; Admin can configure automatic policy. Prioritize failed over pending/leased; completed is low-noise history. If L1 exists but L2 does not update, inspect the job before manually editing durable artifacts.

## Portfolio workflow

Use All Projects to decide where attention belongs: pending work first, then recency, then processing exceptions and L2/L3 readiness. The portfolio should stay compact. Open one project before reading full Current Truth or provenance.

## Progressive disclosure

Long-memory retrieval follows `discover → contextualize/hydrate` instead of eagerly injecting every matched body. `litsan_context` discovers compact L2/L3/L4 candidates and, when the current revision can be proven, returns an exact `evidenceRef`. Load only the selected full revision with `litsan_memory action=load`; load Skill bodies separately with `litsan_skill action=load`.

`litsan_memory` accepts the exact immutable revision ref returned by context, such as `l2:<memory-id>:<revision-id>`. Do not reconstruct “latest” from a stable Memory ID. Hydration records estimated token cost and reuse count so usefulness can be measured by actual reuse rather than stored volume.

## Project map, timeline, and evidence

Choose a project and open **Project map** in the User or Admin console. The architecture map shows its domains, capabilities, processes, methods, mechanisms and their relationships; double-click a node for its description and available evidence. This is a derived architecture view, not a new memory layer or separate Current Truth.

The timeline below uses time as its horizontal axis and shows a mainline with topic-grouped branches. Processed milestones come from the timeline digest; unprocessed history is labeled as a preview. Topic links do not claim actual Git forks or merges. Double-click an event for its details and sources. Language selection uses existing bilingual text; missing translations fall back to the original, and the architecture map shows a notice.

**Export current flow** saves a snapshot of the rendered project map for communication and inspection. It does not write back to architecture or memory. To verify a claim, inspect the original evidence and exact revision linked from its node or event.

## Consolidation / reflection

When a project accumulates multiple L2 or L3 revisions, `litsan_distill action=consolidate` can produce a read-only consolidation plan. The workflow borrows the useful part of EverOS Reflection without adding another layer: select historical revisions, recover their canonical upstream evidence, let the connected harness merge/re-extract a compact replacement, then submit it through the existing governed writer to the same canonical project timeline/profile artifact.

Old revisions remain traceable history. The plan does not invent the replacement content and does not bypass scope/evidence validation. With insufficient evidence or only one revision, it remains ineligible.

## Ending or pausing projects

Clean up stale TODOs, preserve final chronology and stable rules, and avoid logical deletion just to make the list shorter. When returning months later, re-read recent L2 and reassess whether old L3 rules still match the current environment.

## Success checks

- New chats continue a project without restating the full history.
- All Projects shows multiple compact records rather than one expanded project.
- Selected project Current Truth/TODO/provenance agree.
- Project A rules do not leak into B.
- Skills reuse process, not business facts.
- Failed processing is visible and actionable.
- Full bodies are hydrated only for selected exact revisions rather than every recall hit.
- Project map and timeline expose their available source evidence for inspection.

## FAQ

### Do I always need to select a project manually?
No. Strong workspace/project evidence can route automatically. Explicit selection is safer when candidates are ambiguous or when you intentionally switch projects.

### Is Current Truth a new memory layer?
No. It is a work-recovery view derived mainly from the current project chronology/registry.
