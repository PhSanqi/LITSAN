import type { DistillationJob } from "../../contracts/distillation.js";

export interface DistillationJobReader {
  listDistillationJobs(stateRoot: string, accountId?: string, includeRetired?: boolean): Promise<DistillationJob[]>;
}
