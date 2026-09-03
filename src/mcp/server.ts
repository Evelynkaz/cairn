// Wires an McpDeps into a full MCP server: the six §6 tools (tools.ts), the
// §6 resource mirror (a bounded recent-memories list + a per-memory
// resource), and two §6/§8 prompts. Must work with `provider`/`space`
// absent -- that is the §2 FTS-only default, not an error state.

import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpDeps } from "./deps.js";
import { registerTools, callContext, memoryToJson, MEMORY_URI_TEMPLATE, MEMORIES_LIST_URI } from "./tools.js";
import { MemoryEventBus } from "./events.js";

const SERVER_NAME = "cairn";
const SERVER_VERSION = "0.1.0";

// Bounded (§13: never return an unbounded list), and read through the same
// per-client gate/audit trail as list_memories -- a resource-capable client
// browsing this shows up truthfully in the §9 access log too.
const RESOURCE_LIST_LIMIT = 50;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { resources: { subscribe: true, listChanged: true } } },
  );

  // §6's resource mirror is only usable if a client can actually subscribe:
  // `resources/updated` must go ONLY to URIs a client explicitly subscribed
  // to (per-server here, since each connection gets its own McpServer),
  // never broadcast to every connected client regardless of subscription
  // state.
  const subscribedUris = new Set<string>();

  // One daemon owns the store (BUILD_BRIEF §4), but each session gets its
  // own McpServer/transport -- so a mutation on session A must be announced
  // on session B's own transport, not A's. `bus` is how: daemon/server.ts
  // shares one MemoryEventBus across every session's McpDeps; a caller that
  // builds a lone server (every existing test, and any single-session use)
  // gets a private bus of its own and behaves exactly as before.
  const bus = deps.bus ?? new MemoryEventBus();
  const sessionId = randomUUID();

  // A session already learns about its OWN write through resourceEvents
  // below (the direct, synchronous-per-call path) and through the tool
  // call's own result -- so a bus event this session itself published is
  // deliberately skipped here, or every self-subscribed client would see
  // each of its own writes announced twice.
  const unsubscribeBus = bus.subscribe((event) => {
    if (event.sourceSessionId === sessionId) return;
    if (event.type === "list_changed") {
      server.sendResourceListChanged();
      return;
    }
    if (subscribedUris.has(event.uri)) {
      // Fire-and-forget, deliberately not awaited: this runs on a bus
      // dispatch triggered by ANOTHER session's tool call, so a rejection
      // here (e.g. this client's transport already closed) must never
      // reach back into that other session's `remember`/`update_memory`/
      // `forget` call as a thrown error -- a write that succeeded must not
      // be reported as failed because a third party's socket died.
      server.server.sendResourceUpdated({ uri: event.uri }).catch(() => {});
    }
  });
  // The leak this project has already fixed twice: a daemon that never
  // unsubscribes a closed session's bus listener accumulates one dead
  // listener per disconnected client for the daemon's whole life.
  server.server.onclose = () => {
    unsubscribeBus();
  };

  registerTools(server, deps, {
    async notifyUpdated(uri) {
      if (subscribedUris.has(uri)) {
        await server.server.sendResourceUpdated({ uri });
      }
      bus.publish({ type: "updated", uri, sourceSessionId: sessionId });
    },
    notifyListChanged() {
      server.sendResourceListChanged();
      bus.publish({ type: "list_changed", sourceSessionId: sessionId });
    },
  });

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedUris.add(request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  server.registerResource(
    "recent-memories",
    MEMORIES_LIST_URI,
    {
      title: "Recent memories",
      description:
        "A bounded, most-recent-first index of stored memories. Lets a resource-capable client browse without " +
        "a tool call; call `recall` instead when you need memories relevant to a specific question.",
      mimeType: "application/json",
    },
    (uri) => {
      const { items } = deps.store.list({ limit: RESOURCE_LIST_LIMIT }, callContext(server));
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(items.map(memoryToJson), null, 2) }],
      };
    },
  );

  const memoryTemplate = new ResourceTemplate(MEMORY_URI_TEMPLATE, { list: undefined });
  server.registerResource(
    "memory",
    memoryTemplate,
    {
      title: "Memory",
      description: "A single memory by id, e.g. cairn://memory/<id>.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const rawId = variables["id"];
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        throw new Error("memory resource requires an id");
      }
      const memory = deps.store.get(id, {}, callContext(server));
      if (!memory) {
        throw new Error(`memory not found: ${id}`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(memoryToJson(memory), null, 2) }],
      };
    },
  );

  server.registerPrompt(
    "recall_digest",
    {
      title: "What do you know about me?",
      description: "Ask Cairn to summarize everything it remembers about the user, grounded in stored memories rather than guesswork.",
      argsSchema: { scope: z.string().optional() },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call the get_context or recall tool${args.scope ? ` (scope: "${args.scope}")` : ""} to gather what ` +
              "Cairn has stored about me, then summarize it in plain English: identity, preferences, goals, and " +
              "any open decisions. Cite memory ids for anything you state as fact, and say so if you find nothing.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "save_decision",
    {
      title: "Save this decision",
      description: "Save the decision just made in this conversation as a durable memory, so it survives into future sessions and other clients.",
      argsSchema: { decision: z.string() },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call the remember tool now to save this decision as a durable memory: "${args.decision}". Tag it ` +
              '["decision"] and set importance high (e.g. 0.8), since decisions should not be forgotten.',
          },
        },
      ],
    }),
  );

  return server;
}
