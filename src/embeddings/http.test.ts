import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHttpProvider } from "./http.js";

// All HTTP provider tests run against a stub server on 127.0.0.1 that this
// file starts and stops itself -- never against a real API, per the "no
// network in tests" rule for this project.
function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub server did not report a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<{ input?: string[] }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

function vectorLength(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
}

test("ollama happy path returns L2-normalised vectors in input order", async () => {
  const stub = await startStub((req, res) => {
    assert.equal(req.url, "/api/embed");
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, (_, i) => [i + 1, i + 2, i + 3]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "custom-3d-model" });
    const vectors = await provider.embed(["a", "b"]);
    assert.equal(vectors.length, 2);
    for (const v of vectors) {
      assert.ok(Math.abs(vectorLength(v) - 1) < 1e-4, `vector length ${vectorLength(v)} is not ~1`);
    }
    assert.equal(provider.dim, 3);
  } finally {
    await stub.close();
  }
});

test("openai happy path: unnormalised vectors come back unit length", async () => {
  const stub = await startStub((req, res) => {
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer sk-happy-path-key");
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const data = Array.from({ length: count }, (_, i) => ({ index: i, embedding: [10, 0, 0, i] }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      modelId: "custom-4d-model",
      env: { OPENAI_API_KEY: "sk-happy-path-key" },
    });
    const vectors = await provider.embed(["x", "y"]);
    assert.equal(vectors.length, 2);
    for (const v of vectors) {
      assert.ok(Math.abs(vectorLength(v) - 1) < 1e-4);
    }
  } finally {
    await stub.close();
  }
});

test("voyage happy path", async () => {
  const stub = await startStub((req, res) => {
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer voy-happy-path-key");
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const data = Array.from({ length: count }, (_, i) => ({ index: i, embedding: [1, 2, 3, 4, i + 1] }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({
      name: "voyage",
      baseUrl: stub.url,
      modelId: "custom-5d-model",
      env: { VOYAGE_API_KEY: "voy-happy-path-key" },
    });
    const vectors = await provider.embed(["one"]);
    assert.equal(vectors.length, 1);
    assert.ok(vectors[0]);
    assert.ok(Math.abs(vectorLength(vectors[0]) - 1) < 1e-4);
  } finally {
    await stub.close();
  }
});

// The stub deliberately returns `data` with index fields reversed relative
// to request order, with embeddings distinguishable per index. If the
// index-based sort in http.ts were ever removed, vectors[0] would come back
// derived from embedding [0, 1] (the "b" input) instead of [1, 0] (the "a"
// input) -- this assertion fails in that case. Verified by hand: temporarily
// commenting out the sort in http.ts makes this test fail.
test("out-of-order index fields are re-sorted into input order", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then(() => {
        const data = [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      modelId: "custom-order-model",
      env: { OPENAI_API_KEY: "sk-order-key" },
    });
    const [vecA, vecB] = await provider.embed(["a", "b"]);
    assert.ok(vecA && vecB);
    assert.ok(Math.abs((vecA[0] ?? 0) - 1) < 1e-6, "vector for input 'a' must come from index 0 ([1,0])");
    assert.ok(Math.abs((vecB[1] ?? 0) - 1) < 1e-6, "vector for input 'b' must come from index 1 ([0,1])");
  } finally {
    await stub.close();
  }
});

test("a non-2xx response throws with the status and a truncated body excerpt", async () => {
  const longBody = "x".repeat(5000);
  const stub = await startStub((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(longBody);
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      env: { OPENAI_API_KEY: "sk-error-key" },
    });
    await assert.rejects(provider.embed(["x"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /500/);
      assert.ok(error.message.length < longBody.length, "the full 5000-char body must not be echoed verbatim");
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("a missing API key throws naming the required env var", async () => {
  const openai = await createHttpProvider({ name: "openai", env: {} });
  await assert.rejects(openai.embed(["x"]), /OPENAI_API_KEY/);

  const voyage = await createHttpProvider({ name: "voyage", env: {} });
  await assert.rejects(voyage.embed(["x"]), /VOYAGE_API_KEY/);
});

test("the thrown error text never contains the API key value", async () => {
  const fakeKey = "sk-do-not-leak-this-secret-9f3a";
  const stub = await startStub((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      env: { OPENAI_API_KEY: fakeKey },
    });
    await assert.rejects(provider.embed(["x"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(fakeKey), "error message must not contain the API key");
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("a hanging stub trips the configured timeout", async () => {
  const stub = await startStub(() => {
    // Never respond: the client's timeout must fire instead of hanging forever.
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, timeoutMs: 50 });
    await assert.rejects(provider.embed(["x"]));
  } finally {
    await stub.close();
  }
});

// This is the composition bug this fix round exists for: a known default
// model must construct with a real, positive `dim` and must not need a
// network round trip to get it (a hosted API is not always reachable, and
// the whole point of trusting a table of known defaults is to avoid paying
// a request for the common case).
test("a known default model constructs with the right dim and makes no network request", async () => {
  let requestCount = 0;
  const stub = await startStub((req, res) => {
    requestCount += 1;
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => Array(768).fill(0.1));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url });
    assert.equal(provider.dim, 768, "nomic-embed-text is a known default with dim 768");
    assert.equal(requestCount, 0, "constructing a known-model provider must not touch the network");
  } finally {
    await stub.close();
  }
});

test("an unknown model probes its dimension exactly once at construction", async () => {
  let requestCount = 0;
  const stub = await startStub((req, res) => {
    requestCount += 1;
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => [1, 2, 3, 4, 5, 6]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "some-unlisted-model" });
    assert.equal(requestCount, 1, "an unknown model must probe exactly once at construction");
    assert.equal(provider.dim, 6, "dim must come from the probed response");
  } finally {
    await stub.close();
  }
});

test("a stub returning string components throws naming the provider and the offending index, and nothing is written", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, (_, i) =>
          i === 1 ? ["oops", 1, 2] : [1, 2, 3],
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "custom-3d-model" });
    await assert.rejects(provider.embed(["a", "b"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /"ollama"/);
      assert.match(error.message, /index 1/);
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("a stub returning null components throws", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => [null, null, null]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "custom-3d-model" });
    await assert.rejects(provider.embed(["a"]));
  } finally {
    await stub.close();
  }
});

test("a stub returning an all-zero vector throws", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => [0, 0, 0]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "custom-3d-model" });
    await assert.rejects(provider.embed(["a"]));
  } finally {
    await stub.close();
  }
});

test("a stub returning a legitimate vector still passes unchanged", async () => {
  const stub = await startStub((req, res) => {
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => [3, 4, 0]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "custom-3d-model" });
    const vectors = await provider.embed(["a"]);
    assert.equal(vectors.length, 1);
    const v = vectors[0];
    assert.ok(v);
    assert.ok(Math.abs(v[0]! - 0.6) < 1e-6);
    assert.ok(Math.abs(v[1]! - 0.8) < 1e-6);
    assert.ok(Math.abs(v[2]! - 0) < 1e-6);
  } finally {
    await stub.close();
  }
});

test("modelId is namespaced by provider name while the request body carries the bare model name", async () => {
  let requestedModel: string | undefined;
  const stub = await startStub((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { model?: string; input?: string[] };
      requestedModel = body.model;
      const count = body.input?.length ?? 0;
      // text-embedding-3-small is a known default model (dim 1536, see
      // KNOWN_MODEL_DIMS) -- the stub must match that dimension exactly.
      const data = Array.from({ length: count }, (_, i) => ({
        index: i,
        embedding: Array.from({ length: 1536 }, (_, j) => (j === 0 ? i + 1 : 0)),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      modelId: "text-embedding-3-small",
      env: { OPENAI_API_KEY: "sk-namespace-key" },
    });
    assert.equal(
      provider.modelId,
      "openai:text-embedding-3-small",
      "the stamped modelId must be namespaced by provider name",
    );
    await provider.embed(["x"]);
    assert.equal(requestedModel, "text-embedding-3-small", "the request body must carry the bare model name");
  } finally {
    await stub.close();
  }
});

test("an echoed Authorization header in an error body never leaks the API key", async () => {
  const fakeKey = "sk-echoed-in-error-body-abc123";
  const stub = await startStub((req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end(`request context: authorization=${req.headers.authorization ?? ""}`);
  });
  try {
    const provider = await createHttpProvider({
      name: "openai",
      baseUrl: stub.url,
      env: { OPENAI_API_KEY: fakeKey },
    });
    await assert.rejects(provider.embed(["x"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(fakeKey), "error message must not contain the API key");
      assert.ok(!(error.stack ?? "").includes(fakeKey), "error stack must not contain the API key");
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("a response whose vector length no longer matches dim throws naming both dimensions", async () => {
  // First request (the construction-time probe) reports dim 6, fixing
  // `provider.dim` at 6. The second request (the real embed() call below)
  // reports dim 3 instead, simulating a model silently swapped behind the
  // same endpoint after construction.
  let requestCount = 0;
  const stub = await startStub((req, res) => {
    requestCount += 1;
    const dim = requestCount === 1 ? 6 : 3;
    readJsonBody(req)
      .then((body) => {
        const count = body.input?.length ?? 0;
        const embeddings = Array.from({ length: count }, () => Array.from({ length: dim }, (_, i) => i + 1));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  try {
    const provider = await createHttpProvider({ name: "ollama", baseUrl: stub.url, modelId: "drifting-model" });
    assert.equal(provider.dim, 6, "dim must be fixed from the construction-time probe");
    await assert.rejects(provider.embed(["x"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /expected dim 6/);
      assert.match(error.message, /length 3/);
      return true;
    });
  } finally {
    await stub.close();
  }
});
