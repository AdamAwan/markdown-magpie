import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../test/render";
import { SeedPanel } from "./SeedPanel";

const flows = [
  { id: "billing", name: "Billing" },
  { id: "support", name: "Support" }
];

function render() {
  return renderMarkup(
    <SeedPanel
      flows={flows}
      loading={false}
      onPropose={async () => undefined}
      onListPlans={async () => undefined}
      onPatch={async () => undefined}
      onApprove={async () => undefined}
      onDismiss={async () => undefined}
    />
  );
}

test("renders the flow picker and a disabled Propose button — and no topic field", () => {
  const html = render();

  assert.match(html, /Propose seed plan/);
  assert.match(html, /<option value="billing">Billing<\/option>/);
  assert.match(html, /<option value="support">Support<\/option>/);
  // The planner is source-grounded: there is no topic input, only optional steer notes.
  assert.doesNotMatch(html, /Topic/);
  assert.match(html, /Steer notes \(optional\)/);
  // No flow chosen yet, so Propose is disabled.
  assert.match(html, /disabled=""/);
});

test("explains the plan-review gate before any flow is selected", () => {
  const html = render();

  assert.match(html, /explores the flow.{1,7}s source repositories/);
  assert.match(html, /nothing is drafted until you approve it/);
  // The plans list only renders once a flow is picked.
  assert.doesNotMatch(html, /No plans yet/);
});
