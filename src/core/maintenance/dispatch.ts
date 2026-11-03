import type { ClientProfile } from '../../contracts/maintenance.js';

/** Queue demand sets the allowance; legacy AI availability reports cannot veto the first card. */
export function inlineDispatchBudget(input: {
  profile?: unknown; pending: number; oldestHours: number; usedCards: number; usedTokens: number;
  dailyCardsLeft: number; dailyTokensLeft: number; elapsedMs: number; stopped: boolean;
}) {
  const p = (input.profile && typeof input.profile === 'object' ? input.profile : {}) as Partial<ClientProfile>;
  const demand = input.pending + input.usedCards;
  const limit = demand >= 8 ? 3 : demand >= 3 || input.oldestHours >= 24 ? 2 : 1;
  const perCard = typeof p.max_card_tokens === 'number' && Number.isFinite(p.max_card_tokens)
    ? Math.max(500, Math.min(8000, Math.trunc(p.max_card_tokens))) : 3000;
  const first = input.usedCards === 0;
  const totalTokens = Math.max(perCard, Math.min(6000, perCard * limit));
  const remainingTokens = Math.max(0, Math.min(totalTokens - input.usedTokens, first ? totalTokens : input.dailyTokensLeft));
  const reason = input.stopped ? 'backoff' : input.usedCards >= limit ? 'turn_cap'
    : !first && input.elapsedMs >= 90000 ? 'time_budget'
    : !first && (input.dailyCardsLeft <= 0 || input.dailyTokensLeft < 500) ? 'daily_cap'
    : remainingTokens < 500 ? 'token_budget' : 'ready';
  return { limit, totalTokens, maxCardTokens: Math.min(perCard, remainingTokens), reason };
}
