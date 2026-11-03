import type { MaintenanceConfig } from "../../contracts/maintenance.js";
const integer = (raw: unknown, fallback: number, min: number, max: number) =>
  typeof raw === "number" && Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.trunc(raw))) : fallback;
export function normalizeMaintenanceConfig(value: unknown = {}): MaintenanceConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    conversation_maintenance: raw.conversation_maintenance === "quiet" || raw.conversation_maintenance === "visible" ? raw.conversation_maintenance : "off",
    offer_style: raw.offer_style === "optional" ? "optional" : "delegate_request",
    daily_card_cap: integer(raw.daily_card_cap, 20, 1, 500), daily_est_token_cap: integer(raw.daily_est_token_cap, 60000, 1000, 2000000),
    inline_every_n_turns: integer(raw.inline_every_n_turns, 5, 1, 50), delegate_min_interval_s: integer(raw.delegate_min_interval_s, 60, 0, 3600),
    heavy_turn_chars: integer(raw.heavy_turn_chars, 12000, 1000, 200000), cross_project: raw.cross_project === true,
    opted_out_projects: Array.isArray(raw.opted_out_projects) ? [...new Set(raw.opted_out_projects.filter((p): p is string => typeof p === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(p)))].slice(0, 200) : []
  };
}
