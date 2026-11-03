import { commitArchitectureRevision, prepareArchitectureRevision } from "./architecture-history.js";
import * as core from "./core/governance/architecture-governance.js";
export type { ArchitectureGovernanceDeps, ExplicitProjectResolver } from "./core/governance/architecture-governance.js";
export { planArchitectureMutation } from "./core/governance/architecture-governance.js";

export function executeArchitectureMutation(input: Parameters<typeof core.executeArchitectureMutation>[0]): ReturnType<typeof core.executeArchitectureMutation> {
  return core.executeArchitectureMutation(input, { commitArchitectureRevision, prepareArchitectureRevision });
}
