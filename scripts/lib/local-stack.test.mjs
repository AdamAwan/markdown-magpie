import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { cleanEnv, freePort, waitFor } from "./local-stack.mjs";

test("cleanEnv strips steering vars, keeps DATABASE_URL and the rest, applies overrides", () => {
  const env = cleanEnv(
    { AUTH_REQUIRED: "false", PORT: "4100" },
    {
      DATABASE_URL: "postgres://x",
      PATH: "/bin",
      OPENAI_COMPATIBLE_API_KEY: "real-key",
      AUTH_REQUIRED: "true",
      KNOWLEDGE_FLOWS: "[]",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      PORT: "4000",
      API_BASE_URL: "http://prod"
    }
  );
  assert.deepEqual(env, {
    DATABASE_URL: "postgres://x",
    PATH: "/bin",
    AUTH_REQUIRED: "false",
    PORT: "4100"
  });
});

test("freePort returns a port that can be bound", async () => {
  const port = await freePort();
  assert.ok(port > 0);
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
});

test("waitFor treats a throwing probe as not-ready and times out with the label", async () => {
  let calls = 0;
  await waitFor(
    "third call",
    2_000,
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("not yet");
      return true;
    },
    5
  );
  assert.equal(calls, 3);
  await assert.rejects(
    waitFor("never", 30, async () => false, 5),
    /Timed out waiting for never/
  );
});
