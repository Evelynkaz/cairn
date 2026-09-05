import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../testing/tmp.js";
import type { ClientTarget } from "./clients.js";
import { __setTmpSuffixForTesting, applyToClient, applyToClients, cairnServerEntry } from "./apply.js";
import { DEFAULT_PORT } from "../daemon/server.js";

function target(configPath: string, overrides: Partial<ClientTarget> = {}): ClientTarget {
  return {
    id: "cursor",
    name: "Cursor",
    configPath,
    transport: "stdio",
    detected: true,
    ...overrides,
  };
}

function backupFiles(dir: string, base: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.cairn-backup-`));
}

// Narrow to uid 0 specifically: root bypasses POSIX permission checks
// entirely, so a chmod(0o444) write-refusal cannot be observed there. Any
// other POSIX user (including CI's unprivileged `runner`) still exercises
// the real refusal, which is the property these tests exist to protect.
function permissionChecksAreBypassed(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

test("skipped-not-detected leaves nothing on disk", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "sub", "mcp.json");
    const result = applyToClient(target(configPath, { detected: false }));
    assert.equal(result.outcome, "skipped-not-detected");
    assert.ok(!existsSync(configPath));
  });
});

test("created: no file writes a fresh config with only mcpServers.cairn", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "sub", "mcp.json");
    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "created");
    assert.ok(existsSync(configPath));
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(written), ["mcpServers"]);
    assert.deepEqual(Object.keys(written.mcpServers), ["cairn"]);
    assert.deepEqual(written.mcpServers.cairn, { command: "npx", args: ["-y", "cairn-mem@latest"] });
  });
});

test("updated: existing servers and unrelated top-level keys survive, backup holds original", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = {
      mcpServers: {
        other: { command: "foo", args: ["bar"] },
        another: { url: "http://example.com/mcp", type: "http" },
      },
      someOtherTopLevelKey: { nested: true },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "updated");
    assert.ok(result.backupPath);
    assert.ok(existsSync(result.backupPath!));

    const backupContent = JSON.parse(readFileSync(result.backupPath!, "utf8"));
    assert.deepEqual(backupContent, original);

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
    assert.deepEqual(updated.mcpServers.another, original.mcpServers.another);
    assert.deepEqual(updated.mcpServers.cairn, { command: "npx", args: ["-y", "cairn-mem@latest"] });
    assert.deepEqual(updated.someOtherTopLevelKey, original.someOtherTopLevelKey);
  });
});

test("unchanged: second apply is a no-op, no second backup, mtime untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2), "utf8");

    const first = applyToClient(target(configPath));
    assert.equal(first.outcome, "updated");
    assert.equal(backupFiles(dir, "mcp.json").length, 1);

    const mtimeBefore = statSync(configPath).mtimeMs;
    const second = applyToClient(target(configPath));
    assert.equal(second.outcome, "unchanged");
    assert.equal(second.backupPath, undefined);
    assert.equal(statSync(configPath).mtimeMs, mtimeBefore);
    assert.equal(backupFiles(dir, "mcp.json").length, 1);
  });
});

test("skipped-unparsable: malformed JSON is left byte-identical with a useful detail", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const bad = "{ not json";
    writeFileSync(configPath, bad, "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "skipped-unparsable");
    assert.ok(result.detail && result.detail.includes(configPath));
    assert.equal(readFileSync(configPath, "utf8"), bad);
    assert.equal(backupFiles(dir, "mcp.json").length, 0);
  });
});

test("valid JSON but not an object (array) is skipped-unparsable and untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const bad = "[]";
    writeFileSync(configPath, bad, "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "skipped-unparsable");
    assert.ok(result.detail);
    assert.equal(readFileSync(configPath, "utf8"), bad);
  });
});

test("valid JSON but not an object (string) is skipped-unparsable and untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const bad = '"x"';
    writeFileSync(configPath, bad, "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "skipped-unparsable");
    assert.ok(result.detail);
    assert.equal(readFileSync(configPath, "utf8"), bad);
  });
});

test("dryRun: created outcome, no filesystem changes", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "sub", "mcp.json");
    const result = applyToClient(target(configPath), { dryRun: true });
    assert.equal(result.outcome, "created");
    assert.ok(!existsSync(configPath));
    assert.ok(!existsSync(join(dir, "sub")));
  });
});

test("dryRun: updated outcome, original file and backups untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = { mcpServers: { other: { command: "foo" } } };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const result = applyToClient(target(configPath), { dryRun: true });
    assert.equal(result.outcome, "updated");
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
    assert.equal(backupFiles(dir, "mcp.json").length, 0);
  });
});

test("dryRun: unchanged outcome when cairn entry already matches, no writes", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = { mcpServers: { cairn: { command: "npx", args: ["-y", "cairn-mem@latest"] } } };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const mtimeBefore = statSync(configPath).mtimeMs;
    const result = applyToClient(target(configPath), { dryRun: true });
    assert.equal(result.outcome, "unchanged");
    assert.equal(statSync(configPath).mtimeMs, mtimeBefore);
    assert.equal(backupFiles(dir, "mcp.json").length, 0);
  });
});

test("http entry shape uses a custom port", () => {
  withTempDir((dir) => {
    const t = target(join(dir, "mcp.json"), { transport: "http" });
    assert.deepEqual(cairnServerEntry(t, { port: 9999 }), { url: "http://127.0.0.1:9999/mcp", type: "http" });
  });
});

test("stdio entry shape ignores port", () => {
  withTempDir((dir) => {
    const t = target(join(dir, "mcp.json"), { transport: "stdio" });
    assert.deepEqual(cairnServerEntry(t, { port: 9999 }), { command: "npx", args: ["-y", "cairn-mem@latest"] });
  });
});

test("applyToClients maps over multiple targets independently", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    const targets = [
      target(join(dir, "a", "mcp.json"), { id: "cursor" }),
      target(join(dir, "b", "mcp.json"), { id: "claude-code", detected: false }),
    ];
    const results = applyToClients(targets);
    assert.equal(results[0]?.outcome, "created");
    assert.equal(results[1]?.outcome, "skipped-not-detected");
  });
});

test("http entry uses the daemon's default port when none is given", () => {
  withTempDir((dir) => {
    const t = target(join(dir, "mcp.json"), { transport: "http" });
    assert.deepEqual(cairnServerEntry(t), { url: `http://127.0.0.1:${DEFAULT_PORT}/mcp`, type: "http" });
  });
});

test("failed: a read-only file produces 'failed' and the write does not truncate it", (t) => {
  if (permissionChecksAreBypassed()) {
    t.skip("running as root bypasses the permission check, so the write refusal cannot be exercised");
    return;
  }
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = { mcpServers: { other: { command: "foo" } } };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");
    chmodSync(configPath, 0o444);

    try {
      const result = applyToClient(target(configPath));
      assert.equal(result.outcome, "failed");
      assert.ok(result.detail);
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
      // No orphaned backup or temp file left behind for a retry to pile onto.
      assert.equal(backupFiles(dir, "mcp.json").length, 0);
      assert.ok(!existsSync(`${configPath}.cairn-tmp`));
    } finally {
      chmodSync(configPath, 0o666);
    }
  });
});

test("failed: other targets are still processed after one fails", (t) => {
  if (permissionChecksAreBypassed()) {
    t.skip("running as root bypasses the permission check, so the write refusal cannot be exercised");
    return;
  }
  withTempDir((dir) => {
    const failing = join(dir, "readonly.json");
    const ok = join(dir, "ok.json");
    writeFileSync(failing, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
    chmodSync(failing, 0o444);

    try {
      const results = applyToClients([
        target(failing, { id: "claude-desktop" }),
        target(ok, { id: "cursor" }),
      ]);
      assert.equal(results[0]?.outcome, "failed");
      assert.equal(results[1]?.outcome, "created");
      assert.ok(existsSync(ok));
    } finally {
      chmodSync(failing, 0o666);
    }
  });
});

test("BOM: a UTF-8 BOM-prefixed config is parsed and updated, not rejected", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = { mcpServers: { other: { command: "foo" } } };
    writeFileSync(configPath, `﻿${JSON.stringify(original, null, 2)}`, "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "updated");
    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
    assert.deepEqual(updated.mcpServers.cairn, { command: "npx", args: ["-y", "cairn-mem@latest"] });
  });
});

test("empty file: a zero-byte config is treated as 'created', not unparsable", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, "", "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "created");
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(written.mcpServers.cairn, { command: "npx", args: ["-y", "cairn-mem@latest"] });
  });
});

test("whitespace-only file: also treated as 'created'", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, "   \n\t  \n", "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "created");
  });
});

test("mcpServers not an object (string): skipped-unparsable, original untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const bad = { mcpServers: "hello", other: 1 };
    writeFileSync(configPath, JSON.stringify(bad, null, 2), "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "skipped-unparsable");
    assert.ok(result.detail);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), bad);
    assert.equal(backupFiles(dir, "mcp.json").length, 0);
  });
});

test("mcpServers not an object (array): skipped-unparsable, original untouched", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const bad = { mcpServers: [{ name: "a" }] };
    writeFileSync(configPath, JSON.stringify(bad, null, 2), "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "skipped-unparsable");
    assert.ok(result.detail);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), bad);
  });
});

test("replaced: an existing different cairn entry is reported 'replaced', backed up", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = {
      mcpServers: {
        cairn: { command: "node", args: ["/opt/cairn/dist/cli/index.js"], env: { CAIRN_HOME: "/data/cairn" } },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "replaced");
    assert.ok(result.backupPath);
    const backupContent = JSON.parse(readFileSync(result.backupPath!, "utf8"));
    assert.deepEqual(backupContent, original);

    const updated = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.mcpServers.cairn, { command: "npx", args: ["-y", "cairn-mem@latest"] });
  });
});

test("updated: no prior cairn entry, even with other servers present, is still 'updated'", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const original = { mcpServers: { other: { command: "foo" } } };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");

    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "updated");
  });
});

test("atomic write: no .cairn-tmp file survives a successful update", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2), "utf8");

    applyToClient(target(configPath));
    assert.ok(!existsSync(`${configPath}.cairn-tmp`));
  });
});

test("atomic write: mode of the original file is carried onto the replacement", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2), "utf8");
    chmodSync(configPath, 0o644);
    const modeBefore = statSync(configPath).mode;

    applyToClient(target(configPath));
    assert.equal(statSync(configPath).mode, modeBefore);
  });
});

test("atomic write: a 0600 original file's mode is preserved across an update", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2), "utf8");
    chmodSync(configPath, 0o600);

    applyToClient(target(configPath));
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  });
});

test("created: a new config is 0600 and a newly created directory is 0700", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "sub", "mcp.json");
    const result = applyToClient(target(configPath));
    assert.equal(result.outcome, "created");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
  });
});

test("symlink attack: a symlink planted at the temp path is refused, not followed", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "mcp.json");
    const attackerFile = join(dir, "attacker-owned.json");
    const original = { mcpServers: { other: { command: "foo" } } };
    writeFileSync(configPath, JSON.stringify(original, null, 2), "utf8");
    writeFileSync(attackerFile, "not a cairn config", "utf8");

    // The temp name is normally randomised precisely so this can't be
    // pre-planted; pin it here only so the test can force the exact race
    // the fix defends against (O_EXCL|O_NOFOLLOW), not to suggest the name
    // is guessable in production.
    const fixedSuffix = "deadbeefcafe";
    const tmpPath = `${configPath}.cairn-tmp-${fixedSuffix}`;
    symlinkSync(attackerFile, tmpPath);

    __setTmpSuffixForTesting(fixedSuffix);
    try {
      const result = applyToClient(target(configPath));
      assert.equal(result.outcome, "failed");
    } finally {
      __setTmpSuffixForTesting(undefined);
    }

    // The symlink itself must be untouched: not followed for the write, not
    // chmod'd, not replaced by the rename.
    assert.ok(lstatSync(tmpPath).isSymbolicLink());
    assert.equal(readFileSync(attackerFile, "utf8"), "not a cairn config");
    // The real config is either unchanged or a regular file, never the
    // symlink itself landed on top of it.
    assert.equal(lstatSync(configPath).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
  });
});

test("failed: an unreadable existing config yields 'failed' and later targets are still processed", (t) => {
  if (permissionChecksAreBypassed()) {
    t.skip("running as root bypasses the permission check, so the read refusal cannot be exercised");
    return;
  }
  withTempDir((dir) => {
    const unreadable = join(dir, "unreadable.json");
    const ok = join(dir, "ok.json");
    writeFileSync(unreadable, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
    chmodSync(unreadable, 0o000);

    try {
      const results = applyToClients([target(unreadable, { id: "claude-desktop" }), target(ok, { id: "cursor" })]);
      assert.equal(results[0]?.outcome, "failed");
      assert.ok(results[0]?.detail);
      assert.equal(results[1]?.outcome, "created");
      assert.ok(existsSync(ok));
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});
