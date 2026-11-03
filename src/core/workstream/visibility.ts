export function l1VisibleInBranch(effectiveBranchId: string, viewBranchId: string | "main"): boolean {
  return viewBranchId === "main" || effectiveBranchId === viewBranchId;
}
