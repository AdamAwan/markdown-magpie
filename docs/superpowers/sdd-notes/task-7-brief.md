### Task 7: Add the "Prompts" section to the web console

**Files:**
- Modify: `apps/web/src/app/page.tsx` (type, state, fetch, nav, render, panel, section title/subtitle)
- Modify: `apps/web/src/app/styles.css` (prompt card styles)

**Interfaces:**
- Consumes: `GET /api/prompts` via the existing `apiGet` helper.
- Produces: a new `"prompts"` `ConsoleSection`, a `PromptsPanel` component, and the local `PromptSummary` interface.

(The web app is not an npm dependency of `@magpie/prompts`; declare a local `PromptSummary` interface that matches the serialised shape rather than importing the package.)

- [ ] **Step 1: Add the `PromptSummary` interface and extend `ConsoleSection`**

In `apps/web/src/app/page.tsx`, immediately above the `type ConsoleSection = …` declaration (line 94), add:

```ts
interface PromptSummary {
  id: string;
  title: string;
  description: string;
  usedBy: string[];
  outputShape: string;
  instructions: string;
}
```

Then change the `ConsoleSection` union to include `"prompts"`:

```ts
type ConsoleSection = "ask" | "answered" | "knowledge" | "gaps" | "jobs" | "proposals" | "crunch" | "prompts" | "config" | "dataflow";
```

- [ ] **Step 2: Add the `prompts` state**

After the `const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);` line (line 387), add:

```ts
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
```

- [ ] **Step 3: Fetch the catalog inside `refresh()`**

In the `Promise.all` destructuring (line 481), append `promptsResult` to the array of names, and add the matching `apiGet` call as the last entry in the array (after the `/config` call on line 494):

The destructuring target becomes:
```ts
      const [healthResult, statsResult, repositoriesResult, documentsResult, questionsResult, gapsResult, clustersResult, jobsResult, proposalsResult, crunchRunsResult, crunchSettingsResult, scheduledTasksResult, configResult, promptsResult] = await Promise.all([
```

And add as the final array element (after `apiGet<RuntimeConfig>("/config")`, with a comma added to that line):
```ts
        apiGet<RuntimeConfig>("/config"),
        apiGet<{ prompts: PromptSummary[] }>("/prompts")
      ]);
```

Then, after `setConfig(configResult);` (line 509), add:
```ts
      setPrompts(promptsResult.prompts);
```

- [ ] **Step 4: Add the nav button**

In the sidebar `<nav>`, add a button after the Crunch button (line 872) and before the Data Flow button:

```tsx
          <NavButton active={activeSection === "prompts"} count={prompts.length} glyph="Pr" label="Prompts" onClick={() => openSection("prompts")} />
```

- [ ] **Step 5: Add the section render block**

After the Crunch render block (which ends at line 1117) and before the Data Flow block (line 1119), add:

```tsx
        {activeSection === "prompts" ? (
          <section className="workbench singlePane">
            <PromptsPanel prompts={prompts} />
          </section>
        ) : null}
```

- [ ] **Step 6: Add the `PromptsPanel` component**

Add this component next to the other panel components (e.g. immediately after the `AttentionPanel` function, around line 1158):

```tsx
function PromptsPanel({ prompts }: { prompts: PromptSummary[] }) {
  if (prompts.length === 0) {
    return <p className="promptEmpty">No prompts are registered.</p>;
  }

  return (
    <div className="promptList">
      {prompts.map((prompt) => (
        <article className="promptCard" key={prompt.id}>
          <div className="promptCardHead">
            <h2>{prompt.title}</h2>
            <code>{prompt.id}</code>
          </div>
          <p className="promptDescription">{prompt.description}</p>
          <div className="promptChips">
            {prompt.usedBy.map((usage) => (
              <span className="chip" key={usage}>
                {usage}
              </span>
            ))}
          </div>
          <p className="promptOutput">
            <strong>Output:</strong> {prompt.outputShape}
          </p>
          <pre className="promptInstructions">{prompt.instructions}</pre>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Add the section title and subtitle**

In `sectionTitle()`, add before the final `return "Ask and inspect cited answers";` (line 3119):

```ts
  if (section === "prompts") {
    return "Browse AI prompts";
  }
```

In `sectionSubtitle()`, add before its final `return "Ask and inspect cited answers";` (line 3152):

```ts
  if (section === "prompts") {
    return "Read the exact instruction text sent to the AI for each job type, and where each prompt is used.";
  }
```

- [ ] **Step 8: Add styles to `apps/web/src/app/styles.css`**

Append:

```css
.promptList {
  display: grid;
  gap: 16px;
}

.promptCard {
  border: 1px solid #d8e0d0;
  border-radius: 10px;
  padding: 16px;
  background: #ffffff;
  display: grid;
  gap: 10px;
}

.promptCardHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.promptCardHead h2 {
  margin: 0;
  font-size: 1.05rem;
}

.promptDescription {
  margin: 0;
  color: #45513f;
}

.promptChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.promptOutput {
  margin: 0;
  font-size: 0.9rem;
  color: #45513f;
}

.promptInstructions {
  margin: 0;
  padding: 12px;
  background: #17211d;
  color: #f5f7f2;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.82rem;
  line-height: 1.45;
  overflow-x: auto;
}

.promptEmpty {
  color: #45513f;
}
```

- [ ] **Step 9: Typecheck and build the web app (no unit test runner)**

Run: `npm run typecheck -w @magpie/web && npm run build -w @magpie/web`
Expected: type check passes; Next.js build succeeds.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/styles.css
git commit -m "feat(web): add read-only Prompts section to the console"
```

---

