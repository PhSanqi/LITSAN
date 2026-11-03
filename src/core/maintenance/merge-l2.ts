import type { L2ChunkEvent } from "../../contracts/maintenance.js";
export const normalizeL2EventKey = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
export function datedL2Headings(content: string): { date: string; title: string }[] {
  return [...content.normalize("NFKC").matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.+)$/gm)]
    .map(h => ({ date: h[1]!, title: h[2]!.split(" / ")[0]! }));
}
interface ChunkEvent { chunkIndex: number; eventIndex: number; event: L2ChunkEvent; cardId: string }
function factBody(event: L2ChunkEvent): string {
  const lines = event.body_en.trim().split(/\r?\n/u);
  const isFact = (line: string) => /^(?:atomic\s+facts?|facts?)\s*[:：]\s*\S/iu.test(line.trim().replace(/^[-*+]\s+/u, "").replace(/\*\*/gu, ""));
  const refs = event.evidence_refs.join(", ");
  // shortcut: legacy prose becomes one event-level fact; use explicit lines for finer facts.
  if (!lines.some(isFact)) return `Atomic fact: ${event.body_en.trim().replace(/\s+/gu, " ")} | Evidence: ${refs}`;
  return lines.map(line => isFact(line) && !/(?:\s*\|\s*|\s+)(?:evidence|refs?|证据|引用)\s*[:：]/iu.test(line)
    ? `${line.trimEnd()} | Evidence: ${refs}` : line).join("\n");
}
export function resolveChunkEvents(events: ChunkEvent[], baseContent: string | null = null): { events: ChunkEvent[]; dropped_duplicates: number; base_continuations: { key: string; event: L2ChunkEvent }[] } {
  const seen = new Set(datedL2Headings(baseContent ?? "").map(h => normalizeL2EventKey(h.date + " " + h.title)));
  const baseAliases = new Map([...seen].map(key => [key, key]));
  const base_continuations: { key: string; event: L2ChunkEvent }[] = [];
  const roots = new Map<string, ChunkEvent | null>();
  let dropped_duplicates = 0;
  // Resolve continuations in acceptance order before sorting the resulting real changes by date.
  for (const row of [...events].sort((a, b) => a.chunkIndex - b.chunkIndex || a.eventIndex - b.eventIndex)) {
    const event = structuredClone(row.event), key = normalizeL2EventKey(event.date + " " + event.title_en);
    event.body_en = factBody(event);
    if (event.continues) {
      const prior = roots.get(event.continues);
      if (!roots.has(event.continues)) throw new Error("unknown continuation target");
      if (!prior) {
        const target = baseAliases.get(event.continues)!;
        base_continuations.push({ key: target, event });
        if (!roots.has(key)) { roots.set(key, null); baseAliases.set(key, target); }
        seen.add(key); continue;
      }
      prior.event.body_en += "\n\n" + event.body_en;
      prior.event.body_zh += "\n\n" + event.body_zh;
      prior.event.evidence_refs = [...new Set([...prior.event.evidence_refs, ...event.evidence_refs])];
      // A later chunk can refer to any event accepted so far, including a continuation.
      if (!roots.has(key)) roots.set(key, prior);
      seen.add(key);
      continue;
    }
    if (seen.has(key)) { if (!roots.has(key)) roots.set(key, null); dropped_duplicates++; continue; }
    seen.add(key); roots.set(key, { ...row, event });
  }
  return { events: [...new Set(roots.values())].filter((row): row is ChunkEvent => row !== null)
    .sort((a, b) => a.event.date.localeCompare(b.event.date) || a.chunkIndex - b.chunkIndex || a.eventIndex - b.eventIndex), dropped_duplicates, base_continuations };
}
export function mergeChunkEvents(input: { baseContent: string | null; canonicalTitle: string; provenanceLine?: string; events: ChunkEvent[] }): { content: string; appended: number; dropped_duplicates: number } {
  const resolved = resolveChunkEvents(input.events, input.baseContent);
  const rendered = resolved.events
    .map(({ event }) => `## ${event.date}: ${event.title_en} / ${event.title_zh}\n\n${event.body_en}\n\n${event.body_zh}\n\n${input.provenanceLine ? input.provenanceLine + "\n" : ""}Evidence: ${event.evidence_refs.join(", ")}\n`);
  let base = input.baseContent === null ? `# ${input.canonicalTitle}` : input.baseContent.trim();
  if (resolved.base_continuations.length) base = base.split(/(?=^##\s)/m).map(section => {
    const heading = datedL2Headings(section)[0];
    const additions = heading ? resolved.base_continuations.filter(row => row.key === normalizeL2EventKey(heading.date + " " + heading.title)) : [];
    if (!additions.length) return section;
    // Keep every original paragraph/ref; add detail within the existing heading without creating a new event.
    return section.trimEnd() + additions.map(({ event }) => `\n\n${event.body_en}\n\n${event.body_zh}\n\nEvidence: ${event.evidence_refs.join(", ")}`).join("") + "\n\n";
  }).join("").trimEnd();
  return { content: base + (rendered.length ? "\n\n" + rendered.join("\n") : input.baseContent === null ? "\n\n" : ""), appended: rendered.length, dropped_duplicates: resolved.dropped_duplicates };
}
