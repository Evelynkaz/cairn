// Importer for the "paste your stored memory as text" flow (BUILD_BRIEF
// §16 milestone 10). Neither ChatGPT's nor Claude's data export contains a
// memory file (research finding, not an oversight) -- but both products
// show the user their stored memory as text in settings, and copying that
// out is the only way to get it today. This module turns that pasted blob
// into a flat list of candidate memories; it does not touch Store.

// Untrusted input like any other paste: cap both the number of entries and
// the length of each so a huge or adversarial paste can't blow up the
// store or the dashboard that renders it.
export const MAX_PASTED_ENTRIES = 500;
export const MAX_ENTRY_LENGTH = 2000;

export interface PastedImportOptions {
  scope?: string;
  tags?: string[];
  sourceLabel?: string;
}

export interface ParsedMemory {
  text: string;
}

// Leading bullets ("-", "*", "•") or numbered-list markers ("1.", "1)"),
// with optional surrounding whitespace.
const LEADING_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;

// A line that, once a marker is stripped, is only punctuation/whitespace
// (e.g. a paste artifact like "---" or "*") carries no memory content.
const ONLY_PUNCTUATION = /^[\p{P}\p{S}\s]*$/u;

export function parsePastedMemories(
  input: string,
  options?: PastedImportOptions,
): ParsedMemory[] {
  // scope/tags/sourceLabel are for the caller wiring this into Store later
  // (this module parses only); accepted here so the signature is stable.
  void options;
  const lines = input.split(/\r\n|\r|\n/u);
  const memories: ParsedMemory[] = [];

  for (const rawLine of lines) {
    if (memories.length >= MAX_PASTED_ENTRIES) break;

    const stripped = rawLine.replace(LEADING_MARKER, "").trim();
    if (stripped.length === 0) continue;
    if (ONLY_PUNCTUATION.test(stripped)) continue;

    memories.push({ text: stripped.slice(0, MAX_ENTRY_LENGTH) });
  }

  return memories;
}
