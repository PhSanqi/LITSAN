export interface CodeEvidenceItem {
  kind: "module" | "dependency" | "constant" | "layer";
  ref: string;
  path: string;
  start: number;
  end: number;
  snippet: string;
  name?: string;
  value?: string | number | boolean;
  language?: string;
  bytes?: number;
  target?: string;
  layer?: string;
  layer_ref?: string;
}
export interface CodeEvidenceSnapshot {
  version: 1;
  project: string;
  revision: string;
  commit?: string;
  items: CodeEvidenceItem[];
  layers: { name: string; paths: string[]; exclude?: string[]; ref: string }[];
  allowed: Record<string, string[]>;
  truncated: string[];
}
