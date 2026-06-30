import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createLogger } from "@magpie/logger";
import type { ChatProvider } from "@magpie/core";
import { routeQuestionToFlow, type RoutableFlow } from "./routing.js";

const flows: RoutableFlow[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" }
];

test("logs at warn and returns undefined when the provider call fails", async () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  const logger = createLogger({ level: "debug", destination: stream });
  const failingProvider: ChatProvider = {
    complete: async () => {
      throw new Error("provider down");
    }
  };

  const decision = await routeQuestionToFlow("q?", flows, failingProvider, logger);

  assert.equal(decision, undefined);
  const lines = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => typeof l.msg === "string" && l.msg.includes("routing")));
});
