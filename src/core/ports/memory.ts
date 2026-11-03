import type { DistilledArtifactKind } from "../../contracts/memory.js";
import type { CaptureEvidence } from "../../contracts/capture.js";

export interface CaptureEvidenceReader {
  listCaptureEvents(stateRoot: string, accountId?: string): Promise<CaptureEvidence[]>;
}

export interface MemoryViewerReader {
  viewerGet(path: string, timeoutMs?: number): Promise<unknown>;
}

export interface MemoryViewerWriter {
  viewerPost(path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  viewerDelete(path: string, timeoutMs?: number): Promise<unknown>;
}

export interface TurnSessionWriter {
  openSession(request: Record<string, unknown>): Promise<unknown>;
  completeTurn(turnId: string, request: Record<string, unknown>): Promise<unknown>;
}

export interface MemoryDistiller {
  distill(input: {
    accountId: string;
    userId: string;
    kind: DistilledArtifactKind;
    content: string;
    projectId: string | null;
    conversationId?: string;
    title?: string;
    tags?: string[];
    sourceHarness: string;
    artifactId?: string;
    version?: string;
    provenance?: Record<string, string | undefined>;
    evidenceRefs?: string[];
    sourceConversations?: string[];
    confidence?: number;
    contractVersion?: string;
  }): Promise<unknown>;
}
