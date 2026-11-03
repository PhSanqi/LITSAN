import type { ClientProfile, MaintenanceConfig, MaintenanceOfferState, MaintenanceOfferTurn, MaintenanceOfferReason } from "../../contracts/maintenance.js";
import { normalizeClientProfile } from "./profile.js";
export function decideOffer({ config, profile: raw, turn, state, now }: {
  config: MaintenanceConfig; profile?: ClientProfile | unknown; turn: MaintenanceOfferTurn; state: MaintenanceOfferState; now: number;
}): { offer: false; reason: MaintenanceOfferReason } | { offer: true; maxCardTokens: number; projectScope: "current" | "any" } {
  const no = (reason: MaintenanceOfferReason) => ({ offer: false as const, reason });
  if (config.conversation_maintenance === "off") return no("setting_off");
  if (!turn.ingested) return no("not_ingested");
  if (!turn.projectId) return no("no_project");
  if (config.opted_out_projects.includes(turn.projectId)) return no("opted_out");
  if (turn.assistantChars + turn.toolSummaryChars > config.heavy_turn_chars) return no("heavy_turn");
  const profile = normalizeClientProfile(raw);
  if (profile.execution === "background") return no("background_profile");
  const today = state.day === new Date(now).toISOString().slice(0, 10);
  const tokens = today ? state.est_tokens_offered : 0;
  if ((today ? state.cards_offered : 0) >= config.daily_card_cap || tokens >= config.daily_est_token_cap) return no("daily_cap");
  const continuity = Object.hasOwn(state.by_continuity, turn.continuityId) ? state.by_continuity[turn.continuityId] : undefined;
  if (profile.execution === "inline" && (continuity?.committed_turns_since_offer ?? 0) + 1 < config.inline_every_n_turns) return no("throttled");
  if (profile.execution === "delegate" && continuity?.last_offer_at && now - Date.parse(continuity.last_offer_at) < config.delegate_min_interval_s * 1000) return no("throttled");
  return { offer: true, maxCardTokens: Math.min(profile.max_card_tokens, config.daily_est_token_cap - tokens), projectScope: config.cross_project ? "any" : "current" };
}
