import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, TOP_LEVEL_COMMANDS } from "./args.js";

test("bare argv parses as root", () => {
  assert.deepEqual(parseArgs([]), { command: "root" });
});

test("help aliases all parse as help", () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    assert.deepEqual(parseArgs(argv), { command: "help" });
  }
});

test("--version parses as version", () => {
  assert.deepEqual(parseArgs(["--version"]), { command: "version" });
});

test("mcp/daemon/start/stop parse with no flags", () => {
  assert.deepEqual(parseArgs(["mcp"]), { command: "mcp" });
  assert.deepEqual(parseArgs(["daemon"]), { command: "daemon" });
  assert.deepEqual(parseArgs(["start"]), { command: "start" });
  assert.deepEqual(parseArgs(["stop"]), { command: "stop" });
});

test("status parses with and without --json", () => {
  assert.deepEqual(parseArgs(["status"]), { command: "status", json: false });
  assert.deepEqual(parseArgs(["status", "--json"]), { command: "status", json: true });
});

test("ui parses --no-open as open:false, defaults to open:true", () => {
  assert.deepEqual(parseArgs(["ui"]), { command: "ui", open: true });
  assert.deepEqual(parseArgs(["ui", "--no-open"]), { command: "ui", open: false });
});

test("setup parses --key=value, repeated --client=, and bare flags", () => {
  assert.deepEqual(parseArgs(["setup"]), { command: "setup", clients: [], dryRun: false, print: false });
  assert.deepEqual(parseArgs(["setup", "--dry-run"]), {
    command: "setup",
    clients: [],
    dryRun: true,
    print: false,
  });
  assert.deepEqual(parseArgs(["setup", "--client=cursor", "--client=claude-code", "--print"]), {
    command: "setup",
    clients: ["cursor", "claude-code"],
    dryRun: false,
    print: true,
  });
});

test("embeddings status/enable/disable parse", () => {
  assert.deepEqual(parseArgs(["embeddings", "status"]), { command: "embeddings-status", json: false });
  assert.deepEqual(parseArgs(["embeddings", "status", "--json"]), {
    command: "embeddings-status",
    json: true,
  });
  assert.deepEqual(parseArgs(["embeddings", "enable"]), {
    command: "embeddings-enable",
    provider: undefined,
    modelId: undefined,
  });
  assert.deepEqual(parseArgs(["embeddings", "enable", "--provider=ollama", "--model=foo"]), {
    command: "embeddings-enable",
    provider: "ollama",
    modelId: "foo",
  });
  assert.deepEqual(parseArgs(["embeddings", "disable"]), { command: "embeddings-disable" });
});

test("hook session-start parses", () => {
  assert.deepEqual(parseArgs(["hook", "session-start"]), { command: "hook-session-start" });
});

test("unknown hook subcommand names the offender and lists valid subcommands", () => {
  const result = parseArgs(["hook", "frobnicate"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown "cairn hook" subcommand "frobnicate"/);
  assert.match(result.message, /session-start/);
});

test("hook with no subcommand is a usage error, not a crash", () => {
  const result = parseArgs(["hook"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown "cairn hook" subcommand ""/);
});

test("hook session-start rejects unexpected flags like the other commands", () => {
  const result = parseArgs(["hook", "session-start", "--bogus"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown flag "--bogus"/);
});

test("unknown command names the offender and lists valid commands", () => {
  const result = parseArgs(["frobnicate"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown command "frobnicate"/);
  for (const cmd of TOP_LEVEL_COMMANDS) {
    assert.ok(result.message.includes(cmd), `expected message to list "${cmd}"`);
  }
});

test("unknown embeddings subcommand names the offender and lists valid subcommands", () => {
  const result = parseArgs(["embeddings", "frobnicate"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown "cairn embeddings" subcommand "frobnicate"/);
  assert.match(result.message, /status, enable, disable/);
});

test("unknown flag names the offender and lists valid flags for that command", () => {
  const result = parseArgs(["status", "--bogus"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown flag "--bogus" for "cairn status"/);
  assert.match(result.message, /--json/);
});

test("a flag valid for one command is unknown for another", () => {
  const result = parseArgs(["setup", "--json"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /unknown flag "--json" for "cairn setup"/);
});

test("a value flag with no value is an error", () => {
  const result = parseArgs(["embeddings", "enable", "--provider"]);
  assert.equal(result.command, "error");
  assert.ok(result.command === "error");
  assert.match(result.message, /requires a value/);
});
