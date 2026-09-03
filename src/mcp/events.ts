// The in-process fan-out a single daemon needs so a mutation on one MCP
// session (BUILD_BRIEF §4: one daemon, many clients -- Claude Desktop,
// Cursor, ...) can reach every OTHER session's own `notifications/resources
// /updated`/`resources/list_changed`, not just the mutating session's own
// transport. Deliberately not an EventEmitter: a plain Set of listeners is
// all this needs, and keeps this module dependency-free and synchronous.

// What a listener needs to decide whether/how to announce a change to its
// own client: the changed resource (a specific memory, or "the list
// changed") and the identity of the session that caused it, so a session
// can skip re-announcing a client's own write back to that same client (it
// already learns about its own write through the tool call's own result).
export interface MemoryUpdatedEvent {
  type: "updated";
  uri: string;
  sourceSessionId: string;
}

export interface MemoryListChangedEvent {
  type: "list_changed";
  sourceSessionId: string;
}

export type MemoryEvent = MemoryUpdatedEvent | MemoryListChangedEvent;

export type MemoryEventListener = (event: MemoryEvent) => void;

export class MemoryEventBus {
  private readonly listeners = new Set<MemoryEventListener>();

  // How many listeners are currently subscribed -- exposed so a test (or a
  // future daemon health probe) can assert a session's teardown actually
  // unsubscribed it, rather than only asserting the absence of a crash.
  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(event: MemoryEvent): void {
    // Iterate a snapshot: a listener that unsubscribes itself (or another
    // listener) mid-dispatch must not skip or double-notify a survivor.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // One listener's failure -- e.g. it synchronously throws while
        // reacting to the event -- must never stop delivery to the other
        // listeners, and must never propagate back into publish()'s
        // caller, which is the mutating client's own tool call.
      }
    }
  }

  subscribe(listener: MemoryEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
