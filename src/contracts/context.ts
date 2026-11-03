export type ContextAuthority = "remembered" | "authoritative" | "derived" | "observed" | "evidence";

export type ContextScope = "global" | "project" | "capability";

export interface ContextItem {
  id: string;
  /**
   * Exact immutable provenance reference for this recalled durable Memory
   * revision when LITSAN can prove one. Callers should pass this value back
   * unchanged as a downstream distillation evidence_ref instead of rebuilding
   * a reference from the stable Memory id.
   */
  evidenceRef?: string;
  content: string;
  authority: ContextAuthority;
  scope: ContextScope;
  source: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  provenance?: Record<string, unknown>;
}
