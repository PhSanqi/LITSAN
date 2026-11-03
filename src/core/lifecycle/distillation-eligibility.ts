export function distillationExclusion(event: { provenance?: Record<string, unknown> }): "relation_relays" | "relation_duplicate_of" | undefined {
  const relatesTo = event.provenance?.relates_to;
  if (!relatesTo || typeof relatesTo !== "object" || Array.isArray(relatesTo)) return undefined;
  const relation = (relatesTo as Record<string, unknown>).relation;
  if (relation === "relays") return "relation_relays";
  if (relation === "duplicate_of") return "relation_duplicate_of";
  return undefined;
}

export type DiscoverySkipReason = "auto_disabled" | "before_cutover" | "privacy_excluded" | "relation_relays" | "relation_duplicate_of" | "empty_text";

type DiscoveryContext = {
  autoEnabled: boolean;
  autoSince: string | null | undefined;
  ingestedAt: string | null | undefined;
  privacyExcluded: boolean;
};

type DiscoveryEvent = { provenance?: Record<string, unknown>; user_text?: string; assistant_text?: string };

export function discoverySkipReason(event: DiscoveryEvent, ctx: DiscoveryContext): DiscoverySkipReason | undefined {
  if (!ctx.autoEnabled || !ctx.autoSince) return "auto_disabled";
  if (!ctx.ingestedAt || ctx.ingestedAt < ctx.autoSince) return "before_cutover";
  if (ctx.privacyExcluded) return "privacy_excluded";
  const relation = distillationExclusion(event);
  if (relation) return relation;
  if (!event.user_text?.trim() || !event.assistant_text?.trim()) return "empty_text";
  return undefined;
}

export function discoveryWouldClaim(event: DiscoveryEvent, ctx: DiscoveryContext): boolean {
  return discoverySkipReason(event, ctx) === undefined;
}
