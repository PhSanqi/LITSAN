import type { ClientProfile } from "../../contracts/maintenance.js";
export function normalizeClientProfile(raw?: unknown): ClientProfile & { max_card_tokens: number; cards_per_turn: number } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const execution = ["inline", "delegate", "background"].includes(String(value.execution)) ? value.execution as ClientProfile["execution"] : "inline";
  const cap = execution === "inline" ? 2000 : 8000;
  const fallback = execution === "inline" ? 1500 : execution === "delegate" ? 6000 : 8000;
  const clamp = (n: unknown, defaultValue: number, min: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : defaultValue;
  return { execution, max_card_tokens: clamp(value.max_card_tokens, fallback, 500, cap), cards_per_turn: clamp(value.cards_per_turn, 1, 0, 5),
    ...(["busy", "available", "unknown"].includes(String(value.availability)) ? { availability: value.availability as ClientProfile["availability"] } : {}),
    ...(typeof value.available_tokens === "number" ? { available_tokens: clamp(value.available_tokens, 0, 0, 24000) } : {}),
    ...(typeof value.model === "string" && value.model.trim() && value.model.length <= 80 ? { model: value.model.trim() } : {}) };
}
