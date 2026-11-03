export interface RetrievalBenchmarkCase {
  id?: string;
  query: string;
  project?: string | null;
  account?: string;
  capability_projects?: string[];
  required_evidence: string[];
  critical_evidence?: string[];
  optional_evidence?: string[];
  forbidden_evidence?: string[];
  expected_current_claims?: string[];
}

export interface RetrievalBenchmarkObservation {
  selected_evidence: string[];
  current_claim_evidence?: string[];
  superseded_evidence?: string[];
  context_bytes?: number;
  hydrate_count?: number;
  latency_ms?: number;
}

export interface RetrievalBenchmarkMetrics {
  cases: number;
  grounded_task_accuracy: number;
  recall: number;
  critical_recall: number;
  precision: number;
  current_truth_precision: number;
  superseded_leakage: number;
  duplicate_ratio: number;
  context_bytes: number;
  hydrate_count: number;
  latency_ms: number;
}

export function evaluateRetrievalBenchmark(
  cases: readonly RetrievalBenchmarkCase[],
  observations: readonly RetrievalBenchmarkObservation[]
): RetrievalBenchmarkMetrics {
  if (cases.length !== observations.length) throw new Error("benchmark case/observation count mismatch");
  let groundedCases = 0, required = 0, requiredHit = 0, critical = 0, criticalHit = 0;
  let relevantSelected = 0, selected = 0, forbiddenSelected = 0;
  let currentSelected = 0, truthClassifiedSelected = 0, duplicateSelected = 0;
  let contextBytes = 0, hydrateCount = 0, latencyMs = 0;
  cases.forEach((testCase, index) => {
    const observation = observations[index]!;
    const selectedEvidence = observation.selected_evidence;
    const selectedSet = new Set(selectedEvidence);
    duplicateSelected += selectedEvidence.length - selectedSet.size;
    selected += selectedEvidence.length;
    const relevant = new Set([
      ...(testCase.required_evidence ?? []),
      ...(testCase.critical_evidence ?? []),
      ...(testCase.optional_evidence ?? [])
    ]);
    required += testCase.required_evidence.length;
    requiredHit += testCase.required_evidence.filter((ref) => selectedSet.has(ref)).length;
    const criticalEvidence = testCase.critical_evidence ?? testCase.required_evidence;
    critical += criticalEvidence.length;
    criticalHit += criticalEvidence.filter((ref) => selectedSet.has(ref)).length;
    relevantSelected += selectedEvidence.filter((ref) => relevant.has(ref)).length;
    const forbidden = new Set(testCase.forbidden_evidence ?? []);
    forbiddenSelected += selectedEvidence.filter((ref) => forbidden.has(ref)).length;
    if (
      testCase.required_evidence.every((ref) => selectedSet.has(ref)) &&
      selectedEvidence.every((ref) => !forbidden.has(ref))
    ) groundedCases += 1;
    const current = new Set(observation.current_claim_evidence ?? []);
    currentSelected += selectedEvidence.filter((ref) => current.has(ref)).length;
    const superseded = new Set(observation.superseded_evidence ?? []);
    truthClassifiedSelected += selectedEvidence.filter((ref) => current.has(ref) || superseded.has(ref)).length;
    contextBytes += observation.context_bytes ?? 0;
    hydrateCount += observation.hydrate_count ?? 0;
    latencyMs += observation.latency_ms ?? 0;
  });
  return {
    cases: cases.length,
    grounded_task_accuracy: ratio(groundedCases, cases.length),
    recall: ratio(requiredHit, required),
    critical_recall: ratio(criticalHit, critical),
    precision: ratio(relevantSelected, selected),
    current_truth_precision: ratio(currentSelected, truthClassifiedSelected),
    superseded_leakage: ratio(forbiddenSelected, selected),
    duplicate_ratio: ratio(duplicateSelected, selected),
    context_bytes: cases.length ? Math.round(contextBytes / cases.length) : 0,
    hydrate_count: cases.length ? round(hydrateCount / cases.length) : 0,
    latency_ms: cases.length ? round(latencyMs / cases.length) : 0
  };
}

export function compareRetrievalBenchmarks(
  baseline: RetrievalBenchmarkMetrics,
  candidate: RetrievalBenchmarkMetrics
) {
  const numericKeys = Object.keys(baseline).filter((key) => key !== "cases") as Array<Exclude<keyof RetrievalBenchmarkMetrics, "cases">>;
  return Object.fromEntries(numericKeys.map((key) => [key, round(candidate[key] - baseline[key])]));
}

function ratio(numerator: number, denominator: number): number { return denominator > 0 ? round(numerator / denominator) : 1; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
