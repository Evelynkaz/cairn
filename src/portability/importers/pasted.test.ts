import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PASTED_ENTRIES, MAX_ENTRY_LENGTH, parsePastedMemories } from "./pasted.js";

test("plain lines become one memory each", () => {
  const result = parsePastedMemories("I prefer Vim\nI live in Berlin");
  assert.deepEqual(result, [{ text: "I prefer Vim" }, { text: "I live in Berlin" }]);
});

test("each bullet marker is stripped", () => {
  const result = parsePastedMemories("- dash\n* star\n• bullet");
  assert.deepEqual(result, [{ text: "dash" }, { text: "star" }, { text: "bullet" }]);
});

test("numbered list markers are stripped", () => {
  const result = parsePastedMemories("1. first\n2) second");
  assert.deepEqual(result, [{ text: "first" }, { text: "second" }]);
});

test("mixed markers in one paste", () => {
  const result = parsePastedMemories("- a\n1. b\nplain c\n3) d");
  assert.deepEqual(result, [{ text: "a" }, { text: "b" }, { text: "plain c" }, { text: "d" }]);
});

test("blank lines are dropped", () => {
  const result = parsePastedMemories("one\n\n\ntwo\n   \nthree");
  assert.deepEqual(result, [{ text: "one" }, { text: "two" }, { text: "three" }]);
});

test("leading and trailing whitespace is trimmed", () => {
  const result = parsePastedMemories("   spaced out   \n\tindented\t");
  assert.deepEqual(result, [{ text: "spaced out" }, { text: "indented" }]);
});

test("punctuation-only lines are dropped", () => {
  const result = parsePastedMemories("---\nreal memory\n***\n...\n-");
  assert.deepEqual(result, [{ text: "real memory" }]);
});

test("entry count is capped", () => {
  const lines = Array.from({ length: MAX_PASTED_ENTRIES + 50 }, (_, i) => `memory ${i}`);
  const result = parsePastedMemories(lines.join("\n"));
  assert.equal(result.length, MAX_PASTED_ENTRIES);
  assert.equal(result[0]?.text, "memory 0");
});

test("entry length is capped", () => {
  const long = "x".repeat(MAX_ENTRY_LENGTH + 500);
  const result = parsePastedMemories(long);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.text.length, MAX_ENTRY_LENGTH);
});

test("a realistic multi-line paste", () => {
  const paste = [
    "Here is my saved memory:",
    "",
    "- Prefers dark mode",
    "- Works as a backend engineer",
    "1. Lives in Toronto",
    "   ",
    "* Has two cats named Miso and Tofu",
    "---",
  ].join("\n");

  const result = parsePastedMemories(paste);
  assert.deepEqual(result, [
    { text: "Here is my saved memory:" },
    { text: "Prefers dark mode" },
    { text: "Works as a backend engineer" },
    { text: "Lives in Toronto" },
    { text: "Has two cats named Miso and Tofu" },
  ]);
});
