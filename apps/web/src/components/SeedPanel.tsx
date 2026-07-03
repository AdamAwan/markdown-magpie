import type { SeedItem } from "@magpie/core";
import { useState } from "react";

// The seed workflow is two steps in one form:
//   1. pick a flow + describe a topic, hit "Generate outline" → the outline_flow_seed
//      job proposes a list of documents (title + coverage);
//   2. edit that list, then hit "Seed" → the v1 seed endpoint drafts one doc per item
//      into the proposal → PR pipeline.
// Coverage/questions are edited as one point per line; blank lines are tolerated while
// typing and dropped on submit.

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// A row of the editable outline. Coverage/questions are held as raw multiline text so
// editing is natural; they're normalised to arrays only when seeding.
interface DraftSeedItem {
  title: string;
  targetPath: string;
  coverage: string;
  questions: string;
}

function toDraft(item: SeedItem): DraftSeedItem {
  return {
    title: item.title ?? "",
    targetPath: item.targetPath ?? "",
    coverage: item.coverage.join("\n"),
    questions: (item.questions ?? []).join("\n")
  };
}

// Normalises an edited row into a SeedItem, or undefined when it has no coverage
// (an empty row is dropped rather than sent — the endpoint requires coverage).
function toSeedItem(draft: DraftSeedItem): SeedItem | undefined {
  const coverage = linesToArray(draft.coverage);
  if (coverage.length === 0) {
    return undefined;
  }
  const questions = linesToArray(draft.questions);
  const title = draft.title.trim();
  const targetPath = draft.targetPath.trim();
  return {
    ...(title ? { title } : {}),
    ...(targetPath ? { targetPath } : {}),
    coverage,
    ...(questions.length > 0 ? { questions } : {})
  };
}

const EMPTY_DRAFT: DraftSeedItem = { title: "", targetPath: "", coverage: "", questions: "" };

export function SeedPanel({
  flows,
  loading,
  onGenerate,
  onSeed
}: {
  flows: Array<{ id: string; name: string }>;
  loading: boolean;
  onGenerate: (flowId: string, topic: string, notes: string) => Promise<SeedItem[] | undefined>;
  onSeed: (flowId: string, items: SeedItem[]) => Promise<string[] | undefined>;
}) {
  const [flowId, setFlowId] = useState("");
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftSeedItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seededCount, setSeededCount] = useState<number | undefined>(undefined);

  const seedItems = items.map(toSeedItem).filter((item): item is SeedItem => item !== undefined);
  const canGenerate = Boolean(flowId) && topic.trim().length > 0 && !generating && !seeding;
  const canSeed = Boolean(flowId) && seedItems.length > 0 && !generating && !seeding;

  function updateItem(index: number, patch: Partial<DraftSeedItem>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  }

  function addItem() {
    setItems((current) => [...current, { ...EMPTY_DRAFT }]);
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  async function generate() {
    setGenerating(true);
    setSeededCount(undefined);
    try {
      const proposed = await onGenerate(flowId, topic, notes);
      if (proposed) {
        setItems(proposed.length > 0 ? proposed.map(toDraft) : [{ ...EMPTY_DRAFT }]);
      }
    } finally {
      setGenerating(false);
    }
  }

  async function seed() {
    setSeeding(true);
    try {
      const jobIds = await onSeed(flowId, seedItems);
      if (jobIds) {
        setSeededCount(jobIds.length);
      }
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="seedPanel">
      <form className="stack seedForm" onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span>Flow</span>
          <select onChange={(event) => setFlowId(event.target.value)} value={flowId}>
            <option value="">Select a flow…</option>
            {flows.map((flow) => (
              <option key={flow.id} value={flow.id}>
                {flow.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Topic</span>
          <input
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Refund handling"
            type="text"
            value={topic}
          />
        </label>
        <label className="field">
          <span>Notes (optional)</span>
          <textarea
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Scope, audience, must-haves — anything to steer the outline."
            rows={3}
            value={notes}
          />
        </label>
        <button className="button" disabled={loading || !canGenerate} onClick={() => void generate()} type="button">
          {generating ? "Generating outline…" : "Generate outline"}
        </button>
        <p className="hint">
          Generating grounds the plan in this flow&rsquo;s existing docs, then proposes a list of documents to author.
          Edit the list below before seeding.
        </p>
      </form>

      {items.length > 0 ? (
        <div className="seedOutline">
          <div className="resultHeader">
            <h3>Proposed documents</h3>
            <button className="chip" onClick={addItem} type="button">
              Add document
            </button>
          </div>
          <div className="list">
            {items.map((item, index) => (
              <article className="row seedItem" key={index}>
                <label className="field">
                  <span>Title</span>
                  <input
                    onChange={(event) => updateItem(index, { title: event.target.value })}
                    placeholder="Document title (optional — derived if blank)"
                    type="text"
                    value={item.title}
                  />
                </label>
                <label className="field">
                  <span>Target path (optional)</span>
                  <input
                    onChange={(event) => updateItem(index, { targetPath: event.target.value })}
                    placeholder="kebab-case/path.md"
                    type="text"
                    value={item.targetPath}
                  />
                </label>
                <label className="field">
                  <span>Coverage — one point per line</span>
                  <textarea
                    onChange={(event) => updateItem(index, { coverage: event.target.value })}
                    placeholder="What this document should cover…"
                    rows={4}
                    value={item.coverage}
                  />
                </label>
                <label className="field">
                  <span>Motivating questions (optional) — one per line</span>
                  <textarea
                    onChange={(event) => updateItem(index, { questions: event.target.value })}
                    rows={2}
                    value={item.questions}
                  />
                </label>
                <div className="rowActions">
                  <button className="chip" onClick={() => removeItem(index)} type="button">
                    Remove document
                  </button>
                </div>
              </article>
            ))}
          </div>
          <button className="button" disabled={loading || !canSeed} onClick={() => void seed()} type="button">
            {seeding ? "Seeding…" : `Seed ${seedItems.length} document${seedItems.length === 1 ? "" : "s"}`}
          </button>
          {seededCount !== undefined ? (
            <p className="hint">
              Enqueued {seededCount} draft job{seededCount === 1 ? "" : "s"}. Drafts will land in the Proposals queue as
              pull requests to review.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="seedOutline">
          <p className="empty">Generate an outline to propose documents, or add one manually.</p>
          <button className="button secondary" onClick={addItem} type="button">
            Add document manually
          </button>
        </div>
      )}
    </div>
  );
}
