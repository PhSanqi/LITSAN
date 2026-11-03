import type { DistillationJob } from '../../contracts/distillation.js';
import type { MaintenanceCard, MaintenanceCardSet, MaintenanceLogEntry, MaintenanceReadonly, L2ChunkInput } from '../../contracts/maintenance.js';

/** Read-only accounting: retired parents never count as work awaiting a model. */
export function maintenanceBacklog(cards: readonly MaintenanceCard[], sets: readonly MaintenanceCardSet[], jobs: readonly MaintenanceReadonly<DistillationJob>[], logs: readonly MaintenanceLogEntry[], now: number) {
  const parents = new Map(jobs.map(job => [job.job_id, job]));
  const cardsById = new Map(cards.map(card => [card.card_id, card]));
  const cardSets = new Map(sets.flatMap(set => set.card_ids.map(id => [id, set] as const)));
  const unfinished = (id: string) => ['pending', 'leased'].includes(parents.get(id)?.status ?? '');
  const live = (card: MaintenanceCard) => {
    if (card.kind !== 'l2_chunk') return true;
    const set = cardSets.get(card.card_id);
    return Boolean(set?.status === 'open' && (set.parent_job_ids ?? [set.parent_job_id]).every(unfinished));
  };
  const open = (card: MaintenanceCard) => card.status === 'pending' || card.status === 'leased';
  const waiting = (card: MaintenanceCard) => card.status === 'pending' || card.status === 'leased' && Date.parse(card.lease?.until ?? '') <= now;
  const active = cards.filter(live);
  const stale = cards.filter(card => card.kind === 'l2_chunk' && open(card) && !live(card));
  const l2 = active.filter(card => card.kind === 'l2_chunk');
  const pendingJobs = jobs.filter(job => job.target === 'l2' && unfinished(job.job_id));
  const represented = new Set(sets.filter(set => set.status === 'open' && (set.parent_job_ids ?? [set.parent_job_id]).every(unfinished) &&
    set.card_ids.some(id => ['pending','leased','accepted'].includes(cardsById.get(id)?.status ?? '')))
    .flatMap(set => set.parent_job_ids ?? [set.parent_job_id]));
  const cutoff = now - 86400000;
  const recent = (value?: string) => Boolean(value && Date.parse(value) >= cutoff && Date.parse(value) <= now);
  const accepted = logs.filter(log => log.kind === 'l2_chunk' && log.outcome === 'accepted' && recent(log.ts));
  const created = cards.filter(card => card.kind === 'l2_chunk' && recent(card.created_at));
  const age = (list: readonly MaintenanceCard[]) => list.length ? Math.round(Math.max(0, now - Math.min(...list.map(card => Date.parse(card.created_at)))) / 36000) / 100 : 0;
  const projects = [...new Set([...cards.map(card => card.project_id), ...pendingJobs.map(job => job.project_id).filter((id): id is string => Boolean(id))])].sort();
  return {
    active_cards: active,
    stale_l2_card_ids: stale.map(card => card.card_id),
    summary: {
      pending_cards: l2.filter(waiting).length,
      leased_cards: l2.filter(card => card.status === 'leased' && !waiting(card)).length,
      accepted_waiting_merge: l2.filter(card => card.status === 'accepted').length,
      quality_review_pending: l2.filter(card => open(card) && (card.input as L2ChunkInput | undefined)?.stage === 'review').length,
      quality_blocked_sets: sets.filter(set => set.status === 'open' && set.quality_blocked && (set.parent_job_ids ?? [set.parent_job_id]).every(unfinished)).length,
      quality_blocked: sets.filter(set => set.status === 'open' && set.quality_blocked && (set.parent_job_ids ?? [set.parent_job_id]).every(unfinished))
        .map(set => ({ set_id: set.set_id, project_id: set.project_id, reason: set.quality_blocked })),
      stale_cards: stale.length,
      parent_jobs: pendingJobs.length,
      unmaterialized_jobs: pendingJobs.filter(job => !represented.has(job.job_id)).length,
      oldest_pending_age_h: age(l2.filter(waiting)),
      promotion_jobs: jobs.filter(job => ['l3','l4'].includes(job.target) && unfinished(job.job_id)).length,
      throughput_24h: {
        created_cards: created.length,
        created_then_superseded: created.filter(card => card.status === 'superseded').length,
        accepted_cards: accepted.length,
        in_turn_accepted: accepted.filter(log => log.harness.startsWith('memhub-in-turn:')).length,
        other_accepted: accepted.filter(log => !log.harness.startsWith('memhub-in-turn:')).length,
        committed_l2_revisions: jobs.filter(job => job.target === 'l2' && job.status === 'completed' && job.result_kind === 'l2' && recent(job.completed_at)).length
      },
      projects: projects.map(project => ({
        project,
        pending_cards: l2.filter(card => card.project_id === project && waiting(card)).length,
        accepted_waiting_merge: l2.filter(card => card.project_id === project && card.status === 'accepted').length,
        stale_cards: stale.filter(card => card.project_id === project).length,
        parent_jobs: pendingJobs.filter(job => job.project_id === project).length,
        unmaterialized_jobs: pendingJobs.filter(job => job.project_id === project && !represented.has(job.job_id)).length
      })).filter(row => row.pending_cards || row.accepted_waiting_merge || row.stale_cards || row.parent_jobs)
    }
  };
}
