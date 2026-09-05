import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "./db.js";
import { resolvePrivacyMode, setPrivacyMode } from "./privacy-settings.js";

test("default privacy mode is 'on' with source default", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const config = resolvePrivacyMode(db, {});
      assert.deepEqual(config, { mode: "on", source: "default" });
    } finally {
      db.close();
    }
  });
});

test("a settings value is picked up with source settings", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setPrivacyMode(db, "strict");
      const config = resolvePrivacyMode(db, {});
      assert.deepEqual(config, { mode: "strict", source: "settings" });
    } finally {
      db.close();
    }
  });
});

test("CAIRN_PRIVACY overrides settings with source env", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setPrivacyMode(db, "off");
      const config = resolvePrivacyMode(db, { CAIRN_PRIVACY: "strict" });
      assert.deepEqual(config, { mode: "strict", source: "env" });
    } finally {
      db.close();
    }
  });
});

test("an invalid CAIRN_PRIVACY throws listing the valid names", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => resolvePrivacyMode(db, { CAIRN_PRIVACY: "paranoid" }), /off, on, strict/);
    } finally {
      db.close();
    }
  });
});

test("an invalid stored settings value falls back to the default without throwing", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      db.q(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run("privacy.mode", "paranoid");
      const config = resolvePrivacyMode(db, {});
      assert.deepEqual(config, { mode: "on", source: "default" });
    } finally {
      db.close();
    }
  });
});

test("setPrivacyMode rejects an invalid mode", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(() => setPrivacyMode(db, "paranoid" as never), /invalid privacy mode/);
    } finally {
      db.close();
    }
  });
});
