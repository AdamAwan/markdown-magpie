# Dataflow Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `/dataflow` so the seven diagrams are grouped by reader intent instead of shown as one flat tab row.

**Architecture:** Keep the existing React Flow graph renderer and authored diagrams. Add flow grouping metadata beside the existing flow definitions, render grouped navigation in `DataFlowPanel`, and update styles/tests to preserve the current canvas behavior.

**Tech Stack:** Next.js client component, React, `@xyflow/react`, dagre layout, Node `node:test`, TypeScript via `tsx`, CSS modules via global `styles.css`.

---

## File Structure

- Modify `docs/superpowers/specs/2026-06-29-dataflow-organization-design.md` to include Mermaid mockups requested by the user.
- Modify `apps/web/src/components/dataflow/flows.ts` to rename flow titles and export navigation groups.
- Modify `apps/web/src/components/dataflow/flows.test.tsx` to assert the grouped navigation contract.
- Modify `apps/web/src/components/DataFlowPanel.tsx` to render grouped flow navigation.
- Modify `apps/web/src/app/styles.css` to style grouped navigation without changing the canvas.
- Run existing dataflow tests and, if feasible, launch the web app for a visual `/dataflow` check.

---

### Task 1: Add Flow Group Metadata And Tests

**Files:**
- Modify: `apps/web/src/components/dataflow/flows.ts`
- Modify: `apps/web/src/components/dataflow/flows.test.tsx`

- [ ] **Step 1: Update the expected flow titles test first**

In `apps/web/src/components/dataflow/flows.test.tsx`, add a grouped navigation assertion after the existing `ALL_KEYS` constant:

```ts
const EXPECTED_GROUPS = [
  { title: "Start here", keys: ["overview"] },
  { title: "Common workflows", keys: ["ask", "improvement", "automation"] },
  { title: "Deep dives", keys: ["reconcile", "gappr", "perflow"] }
];
```

Add this test:

```ts
test("groups flows by reader intent", () => {
  assert.deepEqual(
    FLOW_GROUPS.map((group) => ({ title: group.title, keys: group.flows.map((flow) => flow.key) })),
    EXPECTED_GROUPS
  );
  assert.deepEqual(
    FLOW_GROUPS.flatMap((group) => group.flows.map((flow) => flow.key)),
    ALL_KEYS
  );
});
```

Update the import:

```ts
import { FLOW_GROUPS, FLOWS, buildFlowGraph, type FlowKey } from "./flows";
```

- [ ] **Step 2: Run the focused flow test and confirm it fails**

Run:

```powershell
node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx"
```

Expected: FAIL because `FLOW_GROUPS` is not exported yet.

- [ ] **Step 3: Implement titles and group metadata**

In `apps/web/src/components/dataflow/flows.ts`, update `FlowDef` and add group exports:

```ts
export interface FlowDef {
  key: FlowKey;
  title: string;
  build: (modelInfo: ModelInfo) => FlowGraph;
}

export interface FlowGroupDef {
  title: string;
  flows: FlowDef[];
}
```

Rename the `FLOWS` titles:

```ts
export const FLOWS: FlowDef[] = [
  { key: "overview", title: "System Overview", build: overview },
  { key: "ask", title: "Ask a Question", build: ask },
  { key: "improvement", title: "Improve the Docs", build: improvement },
  { key: "automation", title: "Scheduled Maintenance", build: automation },
  { key: "reconcile", title: "Reconcile Gate", build: reconcile },
  { key: "gappr", title: "Gap-to-PR Pipeline", build: gappr },
  { key: "perflow", title: "Per-Flow Isolation", build: perflow }
];
```

Add the grouped export after `FLOWS`:

```ts
function flowsByKey(keys: FlowKey[]): FlowDef[] {
  return keys.map((key) => {
    const flow = FLOWS.find((candidate) => candidate.key === key);
    if (!flow) {
      throw new Error(`Unknown flow in navigation group: ${key}`);
    }
    return flow;
  });
}

export const FLOW_GROUPS: FlowGroupDef[] = [
  { title: "Start here", flows: flowsByKey(["overview"]) },
  { title: "Common workflows", flows: flowsByKey(["ask", "improvement", "automation"]) },
  { title: "Deep dives", flows: flowsByKey(["reconcile", "gappr", "perflow"]) }
];
```

- [ ] **Step 4: Run the focused flow test and confirm it passes**

Run:

```powershell
node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx"
```

Expected: PASS.

---

### Task 2: Render Grouped Navigation

**Files:**
- Modify: `apps/web/src/components/DataFlowPanel.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Replace flat flow import and tab rendering**

In `apps/web/src/components/DataFlowPanel.tsx`, change the import:

```ts
import { FLOW_GROUPS, buildFlowGraph, type FlowKey } from "./dataflow/flows";
```

Replace the flat `flowTabs` block with:

```tsx
<div className="flowTabs" aria-label="Data flow diagrams">
  {FLOW_GROUPS.map((group) => (
    <div className="flowTabGroup" key={group.title}>
      <div className="flowTabGroupTitle">{group.title}</div>
      <div className="flowTabGroupItems">
        {group.flows.map((flow) => (
          <button
            key={flow.key}
            className={activeFlow === flow.key ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow(flow.key)}
            type="button"
          >
            {flow.title}
          </button>
        ))}
      </div>
    </div>
  ))}
</div>
```

- [ ] **Step 2: Style grouped navigation**

In `apps/web/src/app/styles.css`, replace or extend the existing `.flowTabs` and `.flowTab` area with:

```css
.flowTabs {
  display: grid;
  grid-template-columns: minmax(160px, 0.75fr) repeat(2, minmax(220px, 1fr));
  gap: 14px;
  align-items: start;
}

.flowTabGroup {
  display: grid;
  gap: 8px;
  align-content: start;
}

.flowTabGroupTitle {
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.flowTabGroupItems {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

Keep the existing `.flowTab`, `.flowTab:hover`, and `.flowTab.active` declarations unless they need minor spacing compatibility.

Add the responsive adjustment near the existing mobile section:

```css
@media (max-width: 900px) {
  .flowTabs {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Run dataflow tests**

Run:

```powershell
node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx" "apps/web/src/components/dataflow/layout.test.tsx"
```

Expected: PASS.

---

### Task 3: Verify, Commit, Push, And Open PR

**Files:**
- Verify: changed files from Tasks 1-2 plus the updated design spec and this plan.

- [ ] **Step 1: Inspect the diff**

Run:

```powershell
git diff --stat
```

Expected: only the dataflow spec, plan, flow metadata/test, panel, and CSS files are changed.

- [ ] **Step 2: Run final focused tests**

Run:

```powershell
node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx" "apps/web/src/components/dataflow/layout.test.tsx"
```

Expected: PASS.

- [ ] **Step 3: Commit the work**

Run:

```powershell
git add docs/superpowers/specs/2026-06-29-dataflow-organization-design.md docs/superpowers/plans/2026-06-29-dataflow-organization.md apps/web/src/components/dataflow/flows.ts apps/web/src/components/dataflow/flows.test.tsx apps/web/src/components/DataFlowPanel.tsx apps/web/src/app/styles.css
git commit -m "Organize dataflow diagrams by reader intent"
```

Expected: commit succeeds.

- [ ] **Step 4: Push branch and open PR**

Run:

```powershell
git push -u origin codex/dataflow-organization
```

Then create a draft PR titled:

```text
Organize dataflow diagrams by reader intent
```

PR body should include:

```markdown
## Summary
- group dataflow diagrams into Start here, Common workflows, and Deep dives
- rename diagram tabs for reader intent
- add Mermaid mockups to the design spec

## Tests
- node --import tsx --test "apps/web/src/components/dataflow/flows.test.tsx" "apps/web/src/components/dataflow/layout.test.tsx"
```
