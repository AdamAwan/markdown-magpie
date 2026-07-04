import type { SeedItem } from "@magpie/core";
import { useState } from "react";
import styled from "@emotion/styled";
import { Actions, Button, Chip, EmptyState, Field, Input, Row, Select, Textarea } from "./ui";

// The seed workflow is two steps in one form:
//   1. pick a flow + describe a topic, hit "Generate outline" → the outline_flow_seed
//      job proposes a list of documents (title + coverage);
//   2. edit that list, then hit "Seed" → the v1 seed endpoint drafts one doc per item
//      into the proposal → PR pipeline.
// Coverage/questions are edited as one point per line; blank lines are tolerated while
// typing and dropped on submit.

const SeedPanelRoot = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xxl
}));

const SeedForm = styled.form(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.space.lg,
  maxWidth: "640px"
}));

const SeedOutline = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xl
}));

const OutlineList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md
}));

const SeedItemCard = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xl
}));

const Hint = styled.p(({ theme }) => ({
  margin: `0 0 ${theme.space.md}`,
  color: theme.color.status.running.fg,
  fontSize: theme.font.size.sm
}));

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
    <SeedPanelRoot>
      <SeedForm onSubmit={(event) => event.preventDefault()}>
        <Field label="Flow">
          <Select onChange={(event) => setFlowId(event.target.value)} value={flowId}>
            <option value="">Select a flow…</option>
            {flows.map((flow) => (
              <option key={flow.id} value={flow.id}>
                {flow.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Topic">
          <Input
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Refund handling"
            type="text"
            value={topic}
          />
        </Field>
        <Field label="Notes (optional)">
          <Textarea
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Scope, audience, must-haves — anything to steer the outline."
            rows={3}
            value={notes}
          />
        </Field>
        <Button variant="primary" disabled={loading || !canGenerate} onClick={() => void generate()} type="button">
          {generating ? "Generating outline…" : "Generate outline"}
        </Button>
        <Hint>
          Generating grounds the plan in this flow&rsquo;s existing docs, then proposes a list of documents to author.
          Edit the list below before seeding.
        </Hint>
      </SeedForm>

      {items.length > 0 ? (
        <SeedOutline>
          <Row justify="between" gap="lg">
            <h3>Proposed documents</h3>
            <Chip onClick={addItem} type="button">
              Add document
            </Chip>
          </Row>
          <OutlineList>
            {items.map((item, index) => (
              <SeedItemCard key={index}>
                <Field label="Title">
                  <Input
                    onChange={(event) => updateItem(index, { title: event.target.value })}
                    placeholder="Document title (optional — derived if blank)"
                    type="text"
                    value={item.title}
                  />
                </Field>
                <Field label="Target path (optional)">
                  <Input
                    onChange={(event) => updateItem(index, { targetPath: event.target.value })}
                    placeholder="kebab-case/path.md"
                    type="text"
                    value={item.targetPath}
                  />
                </Field>
                <Field label="Coverage — one point per line">
                  <Textarea
                    onChange={(event) => updateItem(index, { coverage: event.target.value })}
                    placeholder="What this document should cover…"
                    rows={4}
                    value={item.coverage}
                  />
                </Field>
                <Field label="Motivating questions (optional) — one per line">
                  <Textarea
                    onChange={(event) => updateItem(index, { questions: event.target.value })}
                    rows={2}
                    value={item.questions}
                  />
                </Field>
                <Actions>
                  <Chip onClick={() => removeItem(index)} type="button">
                    Remove document
                  </Chip>
                </Actions>
              </SeedItemCard>
            ))}
          </OutlineList>
          <Button variant="primary" disabled={loading || !canSeed} onClick={() => void seed()} type="button">
            {seeding ? "Seeding…" : `Seed ${seedItems.length} document${seedItems.length === 1 ? "" : "s"}`}
          </Button>
          {seededCount !== undefined ? (
            <Hint>
              Enqueued {seededCount} draft job{seededCount === 1 ? "" : "s"}. Drafts will land in the Proposals queue as
              pull requests to review.
            </Hint>
          ) : null}
        </SeedOutline>
      ) : (
        <SeedOutline>
          <EmptyState>Generate an outline to propose documents, or add one manually.</EmptyState>
          <Button variant="secondary" onClick={addItem} type="button">
            Add document manually
          </Button>
        </SeedOutline>
      )}
    </SeedPanelRoot>
  );
}
