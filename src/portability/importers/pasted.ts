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

const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;

export function parsePastedMemories(
  input: string,
  options?: PastedImportOptions,
): ParsedMemory[] {
  // scope/tags/sourceLabel are for the caller wiring this into Store later
  // (this module parses only); accepted here so the signature is stable.
  void options;
  const memories: ParsedMemory[] = [];

  // Scans char codes directly rather than input.split(/\r\n|\r|\n/u), which
  // would materialize every line up front before the entry cap below ever
  // applies -- a multi-megabyte paste of nothing but newlines would build a
  // multi-million-element array to produce zero memories. Same approach as
  // archive.ts's splitLines: find the next terminator with a tight scan,
  // never building a lines array.
  const length = input.length;
  let start = 0;
  for (let i = 0; i <= length; i++) {
    if (memories.length >= MAX_PASTED_ENTRIES) break;
    if (i < length) {
      const code = input.charCodeAt(i);
      if (code !== CHAR_LF && code !== CHAR_CR) continue;
    }

    const rawLine = input.slice(start, i);
    const stripped = rawLine.replace(LEADING_MARKER, "").trim();
    if (stripped.length > 0 && !ONLY_PUNCTUATION.test(stripped)) {
      memories.push({ text: stripped.slice(0, MAX_ENTRY_LENGTH) });
    }

    // A "\r\n" pair is one line terminator, not two lines.
    if (i < length && input.charCodeAt(i) === CHAR_CR && i + 1 < length && input.charCodeAt(i + 1) === CHAR_LF) {
      i += 1;
    }
    start = i + 1;
  }

  return memories;
}
