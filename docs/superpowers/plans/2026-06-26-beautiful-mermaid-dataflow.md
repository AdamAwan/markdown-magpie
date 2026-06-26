# Beautiful Mermaid Dataflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Data Flow page diagrams consumable by `lukilabs/beautiful-mermaid-swift` and add a Swift Package Manager renderer that can export those diagrams as SVG.

**Architecture:** Move Mermaid source generation out of the React component into a focused module that can be tested and exported. Normalize current diagram syntax away from BeautifulMermaid's unsupported HTML labels and style directives while preserving the existing web rendering path. Add a small Swift CLI under `tools/beautiful-mermaid-dataflow` that depends on the upstream `BeautifulMermaid` product and renders `.mmd` source files into SVG assets.

**Tech Stack:** Next.js, React, TypeScript, Node test runner, Mermaid, Swift Package Manager, `BeautifulMermaid`.

---

### Task 1: Extract And Normalize Diagram Sources

**Files:**
- Create: `apps/web/src/components/data-flow-diagrams.ts`
- Modify: `apps/web/src/components/DataFlowPanel.tsx`
- Test: `apps/web/src/components/data-flow-diagrams.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that build every data-flow diagram and assert that the exported source avoids BeautifulMermaid parser limitations used by the current component: no HTML tags, no `<br>` line breaks, and no `style` directives.

- [ ] **Step 2: Run the focused test**

Run: `npm test -w @magpie/web -- data-flow-diagrams.test.ts`

Expected before implementation: the test fails because the module does not exist or the existing diagram strings still contain unsupported syntax.

- [ ] **Step 3: Move source generation into the module**

Export `FLOW_TABS`, `FlowKey`, and `buildDataFlowDiagram(flow, modelInfo)` from `data-flow-diagrams.ts`. Replace HTML label fragments with plain labels that BeautifulMermaid can parse.

- [ ] **Step 4: Update the React component**

Import the new helpers in `DataFlowPanel.tsx` and leave browser rendering through the existing `mermaid.run` path.

- [ ] **Step 5: Run the focused test again**

Run: `npm test -w @magpie/web -- data-flow-diagrams.test.ts`

Expected after implementation: the new compatibility tests pass.

### Task 2: Add Swift Renderer Tool

**Files:**
- Create: `tools/beautiful-mermaid-dataflow/Package.swift`
- Create: `tools/beautiful-mermaid-dataflow/Sources/DataFlowRenderer/main.swift`
- Create: `tools/beautiful-mermaid-dataflow/README.md`
- Modify: `package.json`

- [ ] **Step 1: Add the Swift package**

Create an SPM executable target named `DataFlowRenderer` with a dependency on `https://github.com/lukilabs/beautiful-mermaid-swift` from `1.0.0`.

- [ ] **Step 2: Add the renderer entry point**

Implement a CLI that accepts an input directory of `.mmd` files and an output directory, then calls `MermaidRenderer.renderSVG(source:theme:)` for each source file.

- [ ] **Step 3: Add npm script documentation**

Add a root script that shells into the Swift package and runs the renderer. Document that Swift 5.9+ is required.

- [ ] **Step 4: Verify TypeScript still builds**

Run: `npm run typecheck -w @magpie/web`.

Expected: exit 0.

### Task 3: Publish

**Files:**
- Modify only files from Tasks 1 and 2.

- [ ] **Step 1: Inspect diff**

Run: `git status -sb` and `git diff --stat`.

- [ ] **Step 2: Run available checks**

Run the focused web tests and web typecheck. If Swift is unavailable, record that `swift build` could not be run locally.

- [ ] **Step 3: Commit**

Commit message: `Add BeautifulMermaid dataflow renderer`.

- [ ] **Step 4: Push and open draft PR**

Push `codex/beautiful-mermaid-dataflow` and open a draft PR against `main`.
