import type { ProjectBranch } from "../../contracts/branches.js";
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function pickBranchToEvict(activeAuto: ProjectBranch[], cap = 8): ProjectBranch | null {
  const auto = activeAuto.filter(b => b.origin === "auto" && b.status === "active");
  return auto.length < cap ? null : [...auto].sort((a, b) =>
    cmp(a.last_activity_at ?? a.createdAt, b.last_activity_at ?? b.createdAt) ||
    cmp(a.createdAt, b.createdAt) || cmp(a.branchId, b.branchId))[0] ?? null;
}
