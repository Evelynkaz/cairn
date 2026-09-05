import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCustomInstructions, ImporterFormatError } from "./chatgpt.js";
import { MAX_ENTRY_LENGTH } from "./pasted.js";

// Fixtures below are constructed by hand from documented/community-reported
// shapes (OpenAI help article 8096356 for the presence of custom
// instructions in the export; an unofficial API for the inner key names).
// They have NOT been validated against a real ChatGPT data export -- the
// next person touching this file should keep that in mind.

function conversationWithCustomInstructions(contextData: Record<string, unknown>) {
  return {
    title: "Some chat",
    mapping: {
      "root-node-id": {
        // The root node's message is always null.
        message: null,
      },
      "system-node-id": {
        message: {
          author: { role: "system" },
          metadata: {
            is_user_system_message: true,
            user_context_message_data: contextData,
          },
        },
      },
      "assistant-node-id": {
        message: {
          author: { role: "assistant" },
          content: { parts: ["hello"] },
          metadata: {},
        },
      },
    },
  };
}

test("returns custom instructions in the documented shape", () => {
  const conversations = [
    conversationWithCustomInstructions({
      about_user_message: "Works as a backend engineer.",
      about_model_message: "Be concise.",
    }),
  ];

  const result = extractCustomInstructions(conversations);
  assert.deepEqual(result, {
    aboutUser: "Works as a backend engineer.",
    aboutModel: "Be concise.",
  });
});

test("falls back to other string fields when inner keys are named differently", () => {
  const conversations = [
    conversationWithCustomInstructions({
      user_profile: "Lives in Berlin.",
      model_instructions: "Answer briefly.",
    }),
  ];

  const result = extractCustomInstructions(conversations);
  assert.deepEqual(result, {
    aboutUser: "Lives in Berlin.",
    aboutModel: "Answer briefly.",
  });
});

test("the fallback caps a field's length instead of returning it in full", () => {
  const oversized = "x".repeat(MAX_ENTRY_LENGTH + 500);
  const conversations = [
    conversationWithCustomInstructions({
      user_profile: oversized,
    }),
  ];

  const result = extractCustomInstructions(conversations);
  assert.equal(result.aboutUser?.length, MAX_ENTRY_LENGTH);
});

test("a valid export with no custom instructions returns empty, not an error", () => {
  const conversations = [
    {
      title: "Ordinary chat",
      mapping: {
        "root-node-id": { message: null },
        "assistant-node-id": {
          message: {
            author: { role: "assistant" },
            content: { parts: ["hi there"] },
            metadata: {},
          },
        },
      },
    },
  ];

  const result = extractCustomInstructions(conversations);
  assert.deepEqual(result, {});
});

test("mapping nodes with message: null (the root node) do not crash", () => {
  const conversations = [
    {
      mapping: {
        "root-node-id": { message: null },
        "another-null-node": { message: null },
      },
    },
  ];

  assert.doesNotThrow(() => extractCustomInstructions(conversations));
  assert.deepEqual(extractCustomInstructions(conversations), {});
});

test("something that is not a ChatGPT export throws ImporterFormatError", () => {
  assert.throws(() => extractCustomInstructions({ not: "an array" }), ImporterFormatError);
  assert.throws(() => extractCustomInstructions("just a string"), ImporterFormatError);
  assert.throws(() => extractCustomInstructions(null), ImporterFormatError);
  assert.throws(() => extractCustomInstructions([{ mapping: "not an object" }]), ImporterFormatError);
});

test("the error message contains none of the input", () => {
  const secret = "sk-super-secret-user-conversation-content-do-not-leak";
  try {
    extractCustomInstructions(secret);
    assert.fail("expected ImporterFormatError");
  } catch (err) {
    assert.ok(err instanceof ImporterFormatError);
    assert.ok(!err.message.includes(secret));
  }
});
