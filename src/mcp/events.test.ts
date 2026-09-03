// Unit coverage for the bus itself (events.ts). server.test.ts covers the
// cross-`createMcpServer` wiring built on top of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventBus } from "./events.js";

test("publish reaches every subscriber", () => {
  const bus = new MemoryEventBus();
  const receivedA: string[] = [];
  const receivedB: string[] = [];
  bus.subscribe((event) => {
    if (event.type === "updated") receivedA.push(event.uri);
  });
  bus.subscribe((event) => {
    if (event.type === "updated") receivedB.push(event.uri);
  });

  bus.publish({ type: "updated", uri: "cairn://memory/1", sourceSessionId: "a" });

  assert.deepEqual(receivedA, ["cairn://memory/1"]);
  assert.deepEqual(receivedB, ["cairn://memory/1"]);
});

test("unsubscribe stops delivery", () => {
  const bus = new MemoryEventBus();
  const received: string[] = [];
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "updated") received.push(event.uri);
  });

  bus.publish({ type: "updated", uri: "cairn://memory/1", sourceSessionId: "a" });
  unsubscribe();
  bus.publish({ type: "updated", uri: "cairn://memory/2", sourceSessionId: "a" });

  assert.deepEqual(received, ["cairn://memory/1"]);
  assert.equal(bus.listenerCount, 0);
});

test("a throwing listener does not stop the others or propagate to the publisher", () => {
  const bus = new MemoryEventBus();
  const received: string[] = [];
  bus.subscribe(() => {
    throw new Error("listener boom");
  });
  bus.subscribe((event) => {
    if (event.type === "updated") received.push(event.uri);
  });

  assert.doesNotThrow(() => {
    bus.publish({ type: "updated", uri: "cairn://memory/1", sourceSessionId: "a" });
  });
  assert.deepEqual(received, ["cairn://memory/1"]);
});

test("listenerCount reflects subscribe/unsubscribe", () => {
  const bus = new MemoryEventBus();
  assert.equal(bus.listenerCount, 0);
  const unsubscribe1 = bus.subscribe(() => {});
  const unsubscribe2 = bus.subscribe(() => {});
  assert.equal(bus.listenerCount, 2);
  unsubscribe1();
  assert.equal(bus.listenerCount, 1);
  unsubscribe2();
  assert.equal(bus.listenerCount, 0);
});
