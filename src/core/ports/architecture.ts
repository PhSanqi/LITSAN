import type { ProjectArchitectureDocument, ArchitectureRevisionRecord } from "../../contracts/architecture.js";
import type { ArchitectureCognitiveMap, ArchitectureCognitiveMapDocument } from "../../contracts/project-model.js";
import type { ContextItem } from "../../contracts/context.js";

export interface ArchitectureRevisionStore {
  prepareArchitectureRevision(input: {
    stateRoot: string;
    accountId: string;
    projectId: string;
    path: string;
    beforeExists: boolean;
    beforeFingerprint: string;
    beforeContent: string;
    proposedContent: string;
  }): Promise<ArchitectureRevisionRecord>;
  commitArchitectureRevision(input: {
    stateRoot: string;
    accountId: string;
    projectId: string;
    revisionId: string;
    afterFingerprint: string;
  }): Promise<ArchitectureRevisionRecord>;
}

export interface ArchitectureReader {
  getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]>;
  inspectProjectArchitecture(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchitectureDocument | null>;
  inspectProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
  }): Promise<ArchitectureCognitiveMapDocument>;
}

export interface ArchitectureWriter {
  writeProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    expectedPath: string;
    expectedFingerprint: string;
    content: string;
  }): Promise<{ before: ProjectArchitectureDocument; after: ProjectArchitectureDocument }>;
  writeProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
    expectedFingerprint: string;
    map: ArchitectureCognitiveMap;
  }): Promise<{ before: ArchitectureCognitiveMapDocument; after: ArchitectureCognitiveMapDocument }>;
}
