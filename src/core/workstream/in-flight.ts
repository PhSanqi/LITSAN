import type { InFlightBlock, InFlightEntry, ProjectBranch } from "../../contracts/branches.js";
import type { ArchitectureCognitiveMap } from "../../contracts/project-model.js";
import { selectCandidateNodes } from "../maintenance/candidates.js";
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function buildInFlightBlock(input: {
  branches: ProjectBranch[]; currentBranchId: string; map: ArchitectureCognitiveMap | null;
  currentMapFingerprint: string; now: string;
}): InFlightBlock {
  const candidates = input.branches.filter(b => b.status === "active" && b.branchId !== input.currentBranchId)
    .sort((a, b) => cmp(b.last_activity_at ?? b.createdAt, a.last_activity_at ?? a.createdAt) || cmp(a.branchId, b.branchId));
  const block: InFlightBlock = { branches: [], omitted: candidates.length };
  for (const branch of candidates.slice(0, 5)) {
    const entry: InFlightEntry = {
      branch_id: branch.branchId, name: branch.name, goal: branch.goal.slice(0, 160),
      last_activity_at: branch.last_activity_at ?? branch.createdAt,
      likely_nodes: input.map ? selectCandidateNodes(input.map, `${branch.name} ${branch.goal}`, 3).map(n => n.id) : [],
      base_stale: branch.base_map_fingerprint !== input.currentMapFingerprint
    };
    // Budget the actual wire representation, including escaping and metadata.
    while (JSON.stringify(entry).length > 300 && (entry.goal.length || entry.name.length || entry.likely_nodes.length)) {
      if (entry.goal.length) entry.goal = entry.goal.slice(0, -1);
      else if (entry.name.length) entry.name = entry.name.slice(0, -1);
      else entry.likely_nodes.pop();
    }
    if (JSON.stringify(entry).length > 300) break;
    block.branches.push(entry);
    block.omitted--;
    if (JSON.stringify(block).length > 1500) { block.branches.pop(); block.omitted++; break; }
  }
  return block;
}
