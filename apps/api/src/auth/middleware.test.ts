import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { requireAuth, requireScopes } from "./middleware.js";

// requireScopes must FAIL CLOSED: with auth required and no principal present it
// denies, and only the explicit auth-disabled passthrough allows a request
// through. These tests drive the middleware directly (no JWKS) to isolate that
// contract from token verification.

function appWithScope(authRequired: boolean): Hono {
  const app = new Hono();
  // Simulate requireAuth having run and recorded whether auth is enforced. When
  // auth is disabled it also skips setting a principal (as the real disabled
  // branch does); when enabled but the caller is unauthenticated, no principal.
  app.use("*", async (c, next) => {
    c.set("authRequired", authRequired);
    await next();
  });
  app.get("/guarded", requireScopes("read:knowledge"), (c) => c.json({ ok: true }));
  return app;
}

test("requireScopes denies a principal-absent request when auth is required", async () => {
  const app = appWithScope(true);
  const res = await app.request("/guarded");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("requireScopes denies when the authRequired flag is unset (defensive fail-closed)", async () => {
  // No middleware sets authRequired at all — requireScopes must still deny rather
  // than fall through if requireAuth was somehow not wired ahead of it.
  const app = new Hono();
  app.get("/guarded", requireScopes("read:knowledge"), (c) => c.json({ ok: true }));
  const res = await app.request("/guarded");
  assert.equal(res.status, 401);
});

test("requireScopes allows a principal-absent request only when auth is explicitly disabled", async () => {
  const app = appWithScope(false);
  const res = await app.request("/guarded");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("requireAuth marks the context as auth-disabled when settings.required is false", async () => {
  const app = new Hono();
  app.use("*", requireAuth({ auth: { required: false, issuer: "", audience: "" } }));
  app.get("/guarded", requireScopes("read:knowledge"), (c) => c.json({ ok: true }));

  // The disabled requireAuth branch sets authRequired=false, so requireScopes
  // lets the unauthenticated request through — the intended local-dev story.
  const res = await app.request("/guarded");
  assert.equal(res.status, 200);
});
