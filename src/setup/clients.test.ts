import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../testing/tmp.js";
import { clientTargets } from "./clients.js";

test("claude desktop path resolution per platform", () => {
  withTempDir((home) => {
    const darwin = clientTargets({}, "darwin", home);
    assert.equal(
      darwin.find((t) => t.id === "claude-desktop")?.configPath,
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );

    const win = clientTargets({ APPDATA: join(home, "AppData", "Roaming") }, "win32", home);
    assert.equal(
      win.find((t) => t.id === "claude-desktop")?.configPath,
      join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );

    const linux = clientTargets({}, "linux", home);
    assert.equal(
      linux.find((t) => t.id === "claude-desktop")?.configPath,
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
  });
});

test("cursor and claude code paths are platform-independent", () => {
  withTempDir((home) => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const targets = clientTargets({}, platform, home);
      assert.equal(targets.find((t) => t.id === "cursor")?.configPath, join(home, ".cursor", "mcp.json"));
      assert.equal(targets.find((t) => t.id === "claude-code")?.configPath, join(home, ".claude.json"));
    }
  });
});

test("nine path assertions across three clients and three platforms", () => {
  withTempDir((home) => {
    const expectations: Record<string, (platform: NodeJS.Platform) => string> = {
      "claude-desktop": (platform) =>
        platform === "darwin"
          ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : platform === "win32"
            ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
            : join(home, ".config", "Claude", "claude_desktop_config.json"),
      "claude-code": () => join(home, ".claude.json"),
      cursor: () => join(home, ".cursor", "mcp.json"),
    };
    let count = 0;
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const env = platform === "win32" ? { APPDATA: join(home, "AppData", "Roaming") } : {};
      const targets = clientTargets(env, platform, home);
      for (const target of targets) {
        assert.equal(target.configPath, expectations[target.id]?.(platform));
        count += 1;
      }
    }
    assert.equal(count, 9);
  });
});

test("detected is true when only the parent directory exists", () => {
  withTempDir((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "cursor")?.detected, true);
  });
});

test("detected is false when neither the file nor parent directory exists", () => {
  withTempDir((home) => {
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "cursor")?.detected, false);
  });
});

test("detected is true when the config file itself exists", () => {
  withTempDir((home) => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), "{}", "utf8");
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "cursor")?.detected, true);
  });
});

test("claude-code is not detected in an empty home", () => {
  withTempDir((home) => {
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "claude-code")?.detected, false);
  });
});

test("claude-code is detected when ~/.claude.json exists", () => {
  withTempDir((home) => {
    writeFileSync(join(home, ".claude.json"), "{}", "utf8");
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "claude-code")?.detected, true);
  });
});

test("claude-code is detected when only a ~/.claude directory exists", () => {
  withTempDir((home) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const targets = clientTargets({}, "linux", home);
    assert.equal(targets.find((t) => t.id === "claude-code")?.detected, true);
  });
});
