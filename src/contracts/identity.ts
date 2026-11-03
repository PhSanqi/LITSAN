export type AccountId = string;
export type UserId = string;
export type ProjectId = string;
export type BranchId = string;

export interface SourceContext {
  platform: string;
  transport: string;
  principalId?: string;
  connectionId?: string;
  authenticatedAccount?: string;
}

export interface RequestIdentity {
  accountId: AccountId;
  userId: UserId;
  source: SourceContext;
}
