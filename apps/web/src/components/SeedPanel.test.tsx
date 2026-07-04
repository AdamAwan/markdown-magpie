import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../test/render";
import { SeedPanel } from "./SeedPanel";

const flows = [
  { id: "billing", name: "Billing" },
  { id: "support", name: "Support" }
];

test("renders the flow picker, topic field and a disabled Generate button", () => {
  const html = renderMarkup(
    <SeedPanel flows={flows} loading={false} onGenerate={async () => undefined} onSeed={async () => undefined} />
  );

  assert.match(html, /Generate outline/);
  assert.match(html, /<option value="billing">Billing<\/option>/);
  assert.match(html, /<option value="support">Support<\/option>/);
  assert.match(html, /Topic/);
  // No flow/topic chosen yet, so Generate is disabled.
  assert.match(html, /Generate outline<\/button>/);
  assert.match(html, /disabled=""/);
});

test("shows the empty-outline prompt with a manual add before any generation", () => {
  const html = renderMarkup(
    <SeedPanel flows={flows} loading={false} onGenerate={async () => undefined} onSeed={async () => undefined} />
  );

  assert.match(html, /Generate an outline to propose documents/);
  assert.match(html, /Add document manually/);
});
