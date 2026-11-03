import type { MaintenanceCard } from "../../contracts/maintenance.js";
export function estimateTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++; }
  return Math.ceil(ascii / 4 + other / 1.5);
}
export function cardEstTokens(card: Pick<MaintenanceCard, "kind" | "instructions" | "input">): number {
  return estimateTokens(card.instructions + JSON.stringify(card.input)) + 400 + (card.kind === "l2_chunk" ? 1200 : 300);
}
