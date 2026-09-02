import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempDir, tempDbPath } from "../testing/tmp.js";
import { openDb } from "../storage/db.js";
import { resolveEmbeddingConfig, setEmbeddingConfig, describeConfig } from "./registry.js";

test("default config is off/not consented with source default", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      const config = resolveEmbeddingConfig(db, {});
      assert.deepEqual(config, { provider: "off", modelId: null, consented: false, source: "default" });
      assert.match(describeConfig(config), /off/);
    } finally {
      db.close();
    }
  });
});

test("a settings value is picked up with source settings", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setEmbeddingConfig(db, { provider: "local-onnx", modelId: "bge-small-en-v1.5", consented: true });
      const config = resolveEmbeddingConfig(db, {});
      assert.deepEqual(config, {
        provider: "local-onnx",
        modelId: "bge-small-en-v1.5",
        consented: true,
        source: "settings",
      });
    } finally {
      db.close();
    }
  });
});

test("CAIRN_EMBEDDINGS overrides settings with source env", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setEmbeddingConfig(db, { provider: "local-onnx" });
      const config = resolveEmbeddingConfig(db, { CAIRN_EMBEDDINGS: "openai" });
      assert.equal(config.provider, "openai");
      assert.equal(config.source, "env");
    } finally {
      db.close();
    }
  });
});

test("CAIRN_EMBEDDINGS naming the SAME provider as settings keeps the stored modelId and consent", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setEmbeddingConfig(db, { provider: "local-onnx", modelId: "Xenova/bge-small-en-v1.5", consented: true });
      const config = resolveEmbeddingConfig(db, { CAIRN_EMBEDDINGS: "local-onnx" });
      assert.deepEqual(config, {
        provider: "local-onnx",
        modelId: "Xenova/bge-small-en-v1.5",
        consented: true,
        source: "env",
      });
    } finally {
      db.close();
    }
  });
});

test("CAIRN_EMBEDDINGS naming a DIFFERENT provider drops the stale modelId but keeps consent", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setEmbeddingConfig(db, { provider: "ollama", modelId: "mxbai-embed-large", consented: true });
      const config = resolveEmbeddingConfig(db, { CAIRN_EMBEDDINGS: "openai" });
      assert.deepEqual(config, {
        provider: "openai",
        modelId: null,
        consented: true,
        source: "env",
      });
    } finally {
      db.close();
    }
  });
});

test("an invalid env value throws and lists the valid names", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      assert.throws(
        () => resolveEmbeddingConfig(db, { CAIRN_EMBEDDINGS: "not-a-real-provider" }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /not-a-real-provider/);
          assert.match(error.message, /off/);
          assert.match(error.message, /local-onnx/);
          assert.match(error.message, /voyage/);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });
});

test("an invalid settings value falls back to off without throwing", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      db.q("insert into settings (key, value) values (?, ?)").run("embeddings.provider", "not-a-real-provider");
      const config = resolveEmbeddingConfig(db, {});
      assert.equal(config.provider, "off");
      assert.equal(config.consented, false);
      assert.equal(config.source, "settings");
    } finally {
      db.close();
    }
  });
});

test("setEmbeddingConfig round-trips and persists across a close()/openDb() cycle", () => {
  withTempDir((dir) => {
    const path = tempDbPath(dir);
    const db1 = openDb({ path });
    try {
      const resolved = setEmbeddingConfig(db1, {
        provider: "local-static",
        modelId: "model2vec-static-v1",
        consented: true,
      });
      assert.deepEqual(resolved, {
        provider: "local-static",
        modelId: "model2vec-static-v1",
        consented: true,
        source: "settings",
      });
    } finally {
      db1.close();
    }

    const db2 = openDb({ path });
    try {
      const config = resolveEmbeddingConfig(db2, {});
      assert.deepEqual(config, {
        provider: "local-static",
        modelId: "model2vec-static-v1",
        consented: true,
        source: "settings",
      });
    } finally {
      db2.close();
    }
  });
});

test("no settings key ever looks like an API key; stored keys are exactly the expected embeddings.* set", () => {
  withTempDir((dir) => {
    const db = openDb({ path: tempDbPath(dir) });
    try {
      setEmbeddingConfig(db, { provider: "openai", modelId: "text-embedding-3-small", consented: true });
      const rows = db.q("select key, value from settings order by key").all();
      const keys = rows.map((row) => String(row["key"]));
      assert.deepEqual(keys, ["embeddings.consented", "embeddings.modelId", "embeddings.provider"]);
      for (const row of rows) {
        const value = String(row["value"]);
        assert.doesNotMatch(value, /^sk-/, "no stored value may look like an API key");
      }
    } finally {
      db.close();
    }
  });
});
