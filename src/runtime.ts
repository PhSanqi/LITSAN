import { env } from "./brand.mjs";
import type { ProjectReader, ProjectWriter } from "./core/ports/projects.js";
import type { BranchReader, BranchWriter } from "./core/ports/branches.js";
import type { ArchitectureReader, ArchitectureWriter } from "./core/ports/architecture.js";
import type { MemoryViewerReader, MemoryViewerWriter, TurnSessionWriter, MemoryDistiller } from "./core/ports/memory.js";

import type { SourceContext } from "./contracts/identity.js";
import { closeCaptureIndexDb } from "./capture.js";
import { join, resolve } from "node:path";
import {
  FileProjectArchitectureSource,
  NullProjectArchitectureSource,
  type ProjectArchitectureSource
} from "./architecture-source.js";
import { JsonProjectBranchStore } from "./branch-store.js";
import { ContextRouter } from "./context-router.js";
import { LocalMemoryRestClient } from "./local-memory-client.js";
import { defaultMemoryUserId, MemoryRestContextSource, type RetrievalRankingMode } from "./memory-source.js";
import { JsonProjectRegistry } from "./project-registry.js";
import { resolveControlRoot } from "./state-root.mjs";

// Compile-time adapter checks: adding or changing a port must match the real adapters.
type AssertPort<T extends P, P> = T;

export interface LitsanRuntimeOptions {
  accountId?: string;
  memoryEndpoint?: string;
  memoryToken?: string;
  controlRoot?: string;
  branchesPath?: string;
  architectureRoot?: string;
  disableArchitecture?: boolean;
  projectRegistryPath?: string;
  ownerAccountId?: string;
  /** Internal retrieval ranking mode; default remains memhub_v1 for compatibility. */
  retrievalRankingMode?: RetrievalRankingMode;
  ownerUserId?: string;
  source?: LitsanSourceContext;
}

export type LitsanSourceContext = SourceContext;

export interface LitsanRuntime {
  accountId: string;
  userId: string;
  memoryClient: AssertPort<LocalMemoryRestClient, MemoryViewerReader & MemoryViewerWriter & TurnSessionWriter>;
  router: ContextRouter;
  memory: AssertPort<MemoryRestContextSource, MemoryDistiller>;
  architecture: AssertPort<ProjectArchitectureSource, ArchitectureReader & ArchitectureWriter>;
  projects: AssertPort<JsonProjectRegistry, ProjectReader & ProjectWriter>;
  branches: AssertPort<JsonProjectBranchStore, BranchReader & BranchWriter>;
  source: LitsanSourceContext;
  dispose(): void;
}

export function resolveLocalAccountId(options: Pick<LitsanRuntimeOptions, "accountId" | "ownerAccountId"> = {}): string {
  return requireNonEmpty(
    options.accountId?.trim() ||
    env("ACCOUNT_ID")?.trim() ||
    options.ownerAccountId?.trim() ||
    env("OWNER_ACCOUNT_ID")?.trim() ||
    "local",
    "accountId"
  );
}

export function createLitsanRuntime(options: LitsanRuntimeOptions = {}): LitsanRuntime {
  const accountId = resolveLocalAccountId(options);
  const memoryEndpoint = options.memoryEndpoint ?? env("MEMORY_URL") ?? "http://127.0.0.1:18960";
  const memoryToken = options.memoryToken ?? env("MEMORY_TOKEN");
  const ownerAccountId = options.ownerAccountId ?? env("OWNER_ACCOUNT_ID");
  const ownerUserId = options.ownerUserId ?? env("OWNER_USER_ID") ?? "local-user";
  const userId = defaultMemoryUserId(accountId, ownerAccountId, ownerUserId);
  const controlRoot = resolve(
    options.controlRoot ??
    env("CONTROL_ROOT") ??
    resolveControlRoot()
  );

  const memoryClient = new LocalMemoryRestClient({ endpoint: memoryEndpoint, token: memoryToken });
  const rankingModeValue = options.retrievalRankingMode ?? env("RETRIEVAL_RANKING_MODE") ?? "memhub_v1";
  if (rankingModeValue !== "memhub_v1" && rankingModeValue !== "memhub_core") {
    throw new Error(`LITSAN_RETRIEVAL_RANKING_MODE must be memhub_v1 or memhub_core, got ${rankingModeValue}`);
  }
  const memory = new MemoryRestContextSource(memoryClient, controlRoot, rankingModeValue);
  const architectureDisabled = options.disableArchitecture ||
    env("ARCHITECTURE") === "0" ||
    env("NORMIFY") === "0";
  const architectureRoot = resolve(
    options.architectureRoot ??
    env("ARCHITECTURE_ROOT") ??
    env("NORMIFY_ROOT") ??
    process.cwd()
  );
  const architecture = architectureDisabled
    ? new NullProjectArchitectureSource()
    : new FileProjectArchitectureSource({
      rootDir: architectureRoot,
      managedRootDir: join(controlRoot, "project-architecture")
    });
  const branches = new JsonProjectBranchStore(resolve(
    options.branchesPath ??
    env("BRANCHES") ??
    join(controlRoot, "project-branches.json")
  ));
  const projects = new JsonProjectRegistry(resolve(
    options.projectRegistryPath ??
    env("PROJECT_REGISTRY") ??
    join(controlRoot, "project-registry.json")
  ));
  const router = new ContextRouter(memory, architecture, projects, branches, controlRoot);
  const source = options.source ?? { platform: "local", transport: "local" };
  return { accountId, userId, memoryClient, router, memory, architecture, projects, branches, source,
    dispose: () => closeCaptureIndexDb(controlRoot) };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
