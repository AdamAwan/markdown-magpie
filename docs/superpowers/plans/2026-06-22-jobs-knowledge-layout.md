# Jobs Knowledge-Style Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jobs use the same compact-master/flexible-detail page structure as Knowledge.

**Architecture:** `JobsPanel` will split only the job browser into two columns. A compact list is the master pane, `JobDetail` is the flexible detail pane, and workers/schedules remain full-width siblings below the workspace. Existing provider state and callbacks remain unchanged.

**Tech Stack:** React 19, TypeScript, Next.js CSS, Node test runner, `react-dom/server`

---

### Task 1: Jobs master/detail workspace

**Files:**
- Create: `apps/web/src/components/JobsPanel.test.tsx`
- Modify: `apps/web/src/components/JobsPanel.tsx`
- Modify: `apps/web/src/app/styles.css`
- Modify: `apps/web/package.json`

- [x] **Step 1: Write the failing component test**

Render `JobsPanel` with two `JobView` fixtures using `renderToStaticMarkup`. Assert that the result includes `jobsWorkspace`, `jobList`, `jobDetailPanel`, that the first job is previewed when `selectedJob` is absent, and that `jobWorkers`/`jobSchedules` appear after the workspace closes.

```tsx
test("renders a compact job master list and a flexible detail workspace", () => {
  const html = renderToStaticMarkup(<JobsPanel jobs={jobs} schedules={[]} workers={[]} {...callbacks} />);
  assert.match(html, /class="jobsWorkspace"/);
  assert.match(html, /class="jobList"/);
  assert.match(html, /class="jobDetailPanel"/);
  assert.ok(html.indexOf('class="jobWorkers"') > html.indexOf('class="jobDetailPanel"'));
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -w @magpie/web`

Expected: FAIL because `JobsPanel.test.tsx` expects `jobsWorkspace` and `jobList`, which do not exist yet.

- [x] **Step 3: Implement the minimal layout**

In `JobsPanel.tsx`, derive `displayedJob = selectedJob ?? visibleJobs[0]`, render filters above a `jobsWorkspace`, render compact buttons in `jobList`, render `JobDetail` in the right pane, and move `WorkersTable` and `SchedulesTable` after the workspace. Only explicit selections use the existing `onSelect` callback.

```tsx
const displayedJob = selectedJob ?? visibleJobs[0];

<div className="jobsWorkspace">
  <div className="jobList">{/* compact selectable job rows */}</div>
  <aside className="jobDetailPanel" ref={detailRef}>
    {displayedJob ? <JobDetail job={displayedJob} {...detailCallbacks} /> : <p className="empty">No job selected.</p>}
  </aside>
</div>
<WorkersTable workers={workers} onSelect={onSelect} />
<SchedulesTable schedules={schedules} />
```

In `styles.css`, give `.jobsWorkspace` the same `minmax(220px, 0.32fr) minmax(0, 1fr)` columns as Knowledge, make `.jobList` the bordered scrolling rail, remove sticky/narrow detail constraints, and stack `.jobsWorkspace` below 1050px.

- [x] **Step 4: Run focused verification and verify GREEN**

Run: `npm test -w @magpie/web && npm run typecheck -w @magpie/web`

Expected: component tests PASS and TypeScript exits 0.

- [x] **Step 5: Run repository checks**

Run: `npm run lint && npm run typecheck && npm test`

Expected: all commands exit 0, with only pre-existing non-fatal warnings if any.

- [x] **Step 6: Commit and push**

```bash
git add apps/web/src/components/JobsPanel.test.tsx apps/web/src/components/JobsPanel.tsx apps/web/src/app/styles.css apps/web/package.json docs/superpowers/plans/2026-06-22-jobs-knowledge-layout.md
git commit -m "fix(web): align jobs layout with knowledge"
git push origin main
```
