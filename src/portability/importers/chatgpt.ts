// Importer for ChatGPT's custom instructions (BUILD_BRIEF §16 milestone
// 10). OpenAI help article 8096356 confirms custom instructions ARE
// included in a ChatGPT data export -- the one officially-guaranteed
// personalization payload, needing no copy-paste from the user. They live
// in conversations.json as a hidden system message flagged by
// metadata.is_user_system_message, carrying
// metadata.user_context_message_data.
//
import { MAX_ENTRY_LENGTH } from "./pasted.js";

// Deliberately NOT built here: mining "Model set context updated" memory
// write events out of conversation transcripts. Those are creation events
// only -- no deletions, no supersessions -- so importing them would
// produce a contradictory append-only log, exactly the stale-fact problem
// §7's supersede machinery exists to solve. Also deliberately not built:
// any extraction of facts from transcript text, which would require an
// LLM on the write path and §2 forbids that. This module reads the one
// structured, officially-confirmed field and nothing else.

export interface ChatGptCustomInstructions {
  aboutUser?: string;
  aboutModel?: string;
}

export class ImporterFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImporterFormatError";
  }
}

interface ConversationNode {
  message?: {
    metadata?: {
      is_user_system_message?: unknown;
      user_context_message_data?: unknown;
    } | null;
  } | null;
}

interface Conversation {
  mapping?: Record<string, ConversationNode | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Both export formats evolve silently with no version field, so this
// check is deliberately loose: an array whose elements plausibly look
// like ChatGPT conversations (each is an object, and if it has a mapping
// at all, that mapping is an object). Anything looser risks accepting
// arbitrary JSON; anything stricter risks rejecting a real export whose
// shape drifted.
function looksLikeChatGptExport(value: unknown): value is Conversation[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isRecord(item)) return false;
    if ("mapping" in item && item["mapping"] !== undefined && !isRecord(item["mapping"])) {
      return false;
    }
  }
  return true;
}

export function extractCustomInstructions(conversationsJson: unknown): ChatGptCustomInstructions {
  if (!looksLikeChatGptExport(conversationsJson)) {
    throw new ImporterFormatError(
      "Expected a ChatGPT conversations.json export: an array of conversation objects, each with an optional 'mapping' object of node id to node.",
    );
  }

  for (const conversation of conversationsJson) {
    const mapping = conversation.mapping;
    if (!mapping) continue;

    for (const node of Object.values(mapping)) {
      // The root node's message is always null; every other node's
      // message is optional too depending on export version.
      const message = node?.message;
      if (!message) continue;

      const metadata = message.metadata;
      if (!metadata || metadata.is_user_system_message !== true) continue;

      const data = metadata.user_context_message_data;
      if (!isRecord(data)) continue;

      return extractFromContextData(data);
    }
  }

  return {};
}

// The inner key names are unverified against a real export: research
// found about_user_message / about_model_message in an unofficial API,
// plausible but unevidenced for the export format. So read those first,
// but fall back to any other string-valued field on the object -- do not
// fail just because the names differ, since we have no confirmed schema.
function extractFromContextData(data: Record<string, unknown>): ChatGptCustomInstructions {
  const result: ChatGptCustomInstructions = {};

  const aboutUser = data["about_user_message"];
  const aboutModel = data["about_model_message"];
  if (typeof aboutUser === "string") result.aboutUser = aboutUser;
  if (typeof aboutModel === "string") result.aboutModel = aboutModel;

  if (result.aboutUser === undefined || result.aboutModel === undefined) {
    for (const [key, value] of Object.entries(data)) {
      if (key === "about_user_message" || key === "about_model_message") continue;
      if (typeof value !== "string") continue;

      // Unlike about_user_message/about_model_message above (confirmed-shape
      // fields, trusted as-is), this fallback accepts ANY string-valued
      // field on an unconfirmed schema -- cap it the way pasted.ts caps a
      // pasted entry, so a large field can't become an enormous memory.
      const capped = value.slice(0, MAX_ENTRY_LENGTH);
      if (result.aboutUser === undefined) {
        result.aboutUser = capped;
      } else if (result.aboutModel === undefined) {
        result.aboutModel = capped;
      }
    }
  }

  return result;
}
