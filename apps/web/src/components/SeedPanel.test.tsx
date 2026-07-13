import assert from "node:assert/strict";
import test from "node:test";
import type { SeedPlan } from "@magpie/core";
import { renderMarkup } from "../test/render";
import { changeValue, click, renderDom } from "../test/dom";
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

const plan: SeedPlan = {
  id: "plan-1",
  flowId: "billing",
  status: "proposed",
  origin: "manual",
  charterProposed: false,
  personaProposed: false,
  items: [{ id: "item-1", status: "proposed", title: "Overview", coverage: ["What billing covers"] }],
  rationale: "Covers the flow end to end.",
  outlineJobId: "job-1",
  sourceHash: "hash-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

// The ConsoleProvider re-renders on every poll tick (4s fast tier while jobs are
// active, 30s slow tier always) and its handler functions get new identities each
// time. The panel must not treat those new identities as "the flow changed" —
// that wiped the plan list and collapsed the open review pane mid-edit.
test("keeps the selected plan open when callback props change identity (provider poll re-render)", async () => {
  const props = {
    flows,
    loading: false,
    onPropose: async () => undefined,
    onListPlans: async () => [plan],
    onPatch: async () => undefined,
    onApprove: async () => undefined,
    onDismiss: async () => undefined
  };
  const { container, rerender, unmount } = await renderDom(<SeedPanel {...props} />);
  try {
    const select = container.querySelector("select");
    assert.ok(select, "flow select renders");
    await changeValue(select, "billing");

    const planRow = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("1 document")
    );
    assert.ok(planRow, "the flow's plan is listed after picking the flow");
    await click(planRow);
    assert.match(container.textContent ?? "", /Review plan/);

    // Same props, but every callback has a fresh identity — exactly what a
    // provider poll tick hands down.
    await rerender(
      <SeedPanel
        {...props}
        onPropose={async () => undefined}
        onListPlans={async () => [plan]}
        onPatch={async () => undefined}
        onApprove={async () => undefined}
        onDismiss={async () => undefined}
      />
    );

    assert.match(container.textContent ?? "", /Review plan/, "the open review pane survives the re-render");
  } finally {
    unmount();
  }
});
