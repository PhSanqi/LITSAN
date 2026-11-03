// Infrastructure suites model a compliant client; quality-stage behavior has its own raw-call suite.
import { readMaintenanceStore } from "../dist/maintenance-store.js";
import { nextCard, submitCard as submitRaw } from "../dist/maintenance-control.js";
export function withFacts(card, answer) {
  if (!card?.input?.quality || !answer || !Array.isArray(answer.events) || answer.facts) return answer;
  const facts = card.input.items.map(item => {
    const field = ["user_text", "assistant_text", "content", "tool_summary"].find(k => item[k]?.trim());
    const events = answer.events.flatMap((event, i) => event?.evidence_refs?.includes(item.ref) ? [i] : []);
    return { ref: item.ref, field, quote: item[field].slice(0, 150), state: "reported", disposition: events.length ? "kept" : "transient", events,
      ...(events.length ? {} : { reason: "Synthetic fixture source has no additional durable fact" }) };
  });
  return { ...answer, facts };
}
export async function finishReview(deps, originalId, result) {
  if (!result.ok || result.already_accepted) return result;
  const store = await readMaintenanceStore(deps.stateRoot, deps.runtime.accountId);
  const original = store.cards.find(c => c.card_id === originalId), next = store.cards.find(c => c.card_id === original?.quality_next_card_id);
  if (next?.input?.stage !== "review" || !["pending", "leased"].includes(next.status)) return result;
  const selected = next.status === "leased" ? { card: { ...next, lease_token: next.lease.token } } : await nextCard({ ...deps, cardId: next.card_id, projectId: next.project_id, profile: { execution: "background", max_card_tokens: 8000 }, inlineL2MaxTokens: undefined });
  const answer = withFacts(selected.card, structuredClone(selected.card.input.candidate));
  const reviewed = await submitRaw({ ...deps, harness: next.lease?.owner ?? deps.harness, inlineTurnId: undefined, project: next.project_id, cardId: next.card_id, leaseToken: selected.card.lease_token, answer });
  const set = (await readMaintenanceStore(deps.stateRoot, deps.runtime.accountId)).sets.find(s => s.card_ids.includes(next.card_id));
  return { ...result, ...(set ? { set_status: set.status } : {}), ...(reviewed.merge_error ? { merge_error: reviewed.merge_error } : {}) };
}
export async function submitReviewed(input) {
  const card = (await readMaintenanceStore(input.stateRoot, input.runtime.accountId)).cards.find(c => c.card_id === input.cardId);
  const result = await submitRaw({ ...input, answer: withFacts(card, input.answer) });
  return finishReview(input, input.cardId, result);
}
