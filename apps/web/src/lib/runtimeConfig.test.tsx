import assert from "node:assert/strict";
import test from "node:test";
import { serializeRuntimeConfig } from "./runtimeConfig";

test("serializeRuntimeConfig escapes '<' so '</script>' cannot appear literally", () => {
  const config = { apiBaseUrl: "https://example.com</script><script>alert(1)</script>" };
  const serialized = serializeRuntimeConfig(config);

  assert.ok(!serialized.includes("<"), "serialized output must not contain a literal '<'");
  assert.ok(!serialized.includes("</script>"), "serialized output must not contain a literal '</script>'");
});

test("serializeRuntimeConfig round-trips through JSON.parse to the original object", () => {
  const config = {
    apiBaseUrl: "https://example.com</script>",
    auth: { domain: "<img src=x onerror=alert(1)>", clientId: "abc", audience: "aud", redirectUri: "http://x" }
  };
  const serialized = serializeRuntimeConfig(config);

  assert.deepEqual(JSON.parse(serialized), config);
});

test("serializeRuntimeConfig escapes U+2028 and U+2029", () => {
  const config = { value: "line sep para" };
  const serialized = serializeRuntimeConfig(config);

  assert.ok(!serialized.includes(" "), "serialized output must not contain a raw U+2028");
  assert.ok(!serialized.includes(" "), "serialized output must not contain a raw U+2029");
  assert.deepEqual(JSON.parse(serialized), config);
});
