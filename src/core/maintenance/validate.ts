import type { MaintenanceCard, MaintenanceRejectCode, CardValidationResult } from "../../contracts/maintenance.js";
import { maintenanceGenerators } from "./registry.js";
export { L2_ANSWER_SCHEMA, ARCH_LINK_ANSWER_SCHEMA } from "./answers.js";
export interface CardValidationContext {
  accountId?: string; project?: string; workspaceProject?: string; leaseToken?: string; harness?: string;
  now?: number; fingerprint?: string; contaminated?: boolean;
}
export type { CardValidationResult } from "../../contracts/maintenance.js";
const fail = (code: MaintenanceRejectCode, detail: string): CardValidationResult => ({ ok: false, code, detail });
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export function validateCardAnswer(card: MaintenanceCard, answer: unknown, ctx: CardValidationContext = {}): CardValidationResult {
  if (ctx.accountId !== undefined && ctx.accountId !== card.account_id) return fail("wrong_account", "card belongs to another account");
  if ([ctx.project, ctx.workspaceProject].some(p => p !== undefined && p !== card.project_id)) return fail("wrong_project", "project does not match card");
  if (ctx.now !== undefined) {
    if (card.status !== "leased" || !card.lease) return fail("card_not_leased", "card is not leased");
    if (Date.parse(card.lease.until) <= ctx.now) return fail("lease_expired", "lease expired");
    if (ctx.leaseToken !== card.lease.token || (ctx.harness !== undefined && ctx.harness !== card.lease.owner)) return fail("lease_token_stale", "lease generation or owner mismatch");
  }
  if (ctx.fingerprint !== undefined && ctx.fingerprint !== card.fingerprint) return fail("stale_fingerprint", "input changed");
  let serialized: string | undefined;
  try { serialized = JSON.stringify(answer); } catch { return fail("schema_invalid", "answer must be JSON"); }
  if (serialized && serialized.length > 8000) return fail("oversize", "answer exceeds 8000 characters");
  const generator = maintenanceGenerators.get(card.kind);
  if (!generator) return fail("unsupported_kind", "no validator registered for this kind");
  if (!record(answer)) return fail("schema_invalid", "answer must be an object");
  if (ctx.contaminated) return fail("contaminated", "answer contains unsafe durable-memory text");
  return generator.validate(card, answer);
}
