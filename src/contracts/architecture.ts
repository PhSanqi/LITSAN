export interface ProjectArchitectureDocument {
  projectId: string;
  workspaceDir: string;
  path: string;
  relativePath: string;
  exists: boolean;
  content: string;
  fingerprint: string;
}

export interface ArchitectureRevisionRecord {
  revision_id: string;
  account_id: string;
  project_id: string;
  path: string;
  before_exists: boolean;
  before_fingerprint: string;
  before_content: string;
  proposed_content: string;
  proposed_sha256: string;
  status: "prepared" | "committed";
  created_at: string;
  committed_at?: string;
  after_fingerprint?: string;
}
