import type { ArchitectureNodeKind } from "../../contracts/project-model.js";

export const ARCHITECTURE_NODE_KINDS = ["project","domain","capability","process","method","mechanism"] as const satisfies readonly ArchitectureNodeKind[];
