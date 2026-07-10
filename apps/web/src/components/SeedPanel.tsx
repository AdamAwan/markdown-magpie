import type { SeedPlan, SeedPlanItem } from "@magpie/core";
import { useCallback, useEffect, useState } from "react";
import styled from "@emotion/styled";
import type { SeedPlanPatchBody } from "./ConsoleProvider";
import { Actions, Badge, Button, Chip, EmptyState, Field, Input, Row, Select, Textarea } from "./ui";

// The seed page is plan-centric:
//   1. pick a flow and hit "Propose seed plan" (optional steer notes; there is no
//      topic — the planning agent explores the flow's sources and plans the whole
//      flow, scoped by the flow's charter when configured);
//   2. the persisted plan appears in the list below when the planning job lands;
//   3. review it — edit the run-scoped charter/persona (proposed values carry a
//      copy-to-config hint), edit/approve/dismiss items — then approve: one
//      draft_seed_document per approved item goes into the proposal → PR pipeline.
// Coverage/questions are edited as one point per line; blank lines are tolerated
// while typing and dropped on save.

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

const PlanArea = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xl
}));

const PlanList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm
}));

const PlanRow = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  border: `1px solid ${$selected ? theme.color.accent : theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: `${theme.space.md} ${theme.space.lg}`,
  background: "none",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer"
}));

const ItemList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md
}));

const ItemCard = styled.article<{ $dismissed?: boolean }>(({ theme, $dismissed }) => ({
  display: "grid",
  gap: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xl,
  opacity: $dismissed ? 0.55 : 1
}));

const CharterBlock = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xl
}));

const Hint = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.status.running.fg,
  fontSize: theme.font.size.sm
}));

const ReadonlyPoints = styled.ul(({ theme }) => ({
  margin: 0,
  paddingLeft: theme.space.xl,
  display: "grid",
  gap: theme.space.xs
}));

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// A row of the editable plan. Coverage/questions are held as raw multiline text
// so editing is natural; they're normalised to arrays only when saving.
interface DraftSeedItem {
  id: string;
  status: SeedPlanItem["status"];
  draftJobId?: string;
  title: string;
  targetPath: string;
  coverage: string;
  questions: string;
}

function toDraft(item: SeedPlanItem): DraftSeedItem {
  return {
    id: item.id,
    status: item.status,
    draftJobId: item.draftJobId,
    title: item.title ?? "",
    targetPath: item.targetPath ?? "",
    coverage: item.coverage.join("\n"),
    questions: (item.questions ?? []).join("\n")
  };
}

function toItemPatch(draft: DraftSeedItem): NonNullable<SeedPlanPatchBody["items"]>[number] {
  return {
    id: draft.id,
    title: draft.title.trim(),
    targetPath: draft.targetPath.trim(),
    coverage: linesToArray(draft.coverage),
    questions: linesToArray(draft.questions),
    status: draft.status
  };
}

function planDate(plan: SeedPlan): string {
  return new Date(plan.createdAt).toLocaleString();
}

// Plan/item statuses mapped onto the theme's status tones.
function statusTone(status: SeedPlan["status"] | SeedPlanItem["status"]): "pending" | "completed" | "failed" | "neutral" {
  switch (status) {
    case "proposed":
      return "pending";
    case "approved":
      return "completed";
    case "dismissed":
      return "failed";
    default:
      return "neutral";
  }
}

const COPY_TO_CONFIG_HINT =
  "Proposed from the sources — to make this permanent, copy it into this flow's `charter`/`persona` in KNOWLEDGE_FLOWS.";

export function SeedPanel({
  flows,
  loading,
  onPropose,
  onListPlans,
  onPatch,
  onApprove,
  onDismiss
}: {
  flows: Array<{ id: string; name: string }>;
  loading: boolean;
  onPropose: (flowId: string, notes: string) => Promise<{ jobId: string; reused: boolean } | undefined>;
  onListPlans: (flowId: string) => Promise<SeedPlan[] | undefined>;
  onPatch: (planId: string, patch: SeedPlanPatchBody) => Promise<SeedPlan | undefined>;
  onApprove: (planId: string) => Promise<{ plan: SeedPlan; jobIds: string[] } | undefined>;
  onDismiss: (planId: string) => Promise<SeedPlan | undefined>;
}) {
  const [flowId, setFlowId] = useState("");
  const [notes, setNotes] = useState("");
  const [plans, setPlans] = useState<SeedPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>(undefined);
  const [planningJobId, setPlanningJobId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Review-screen edit state, hydrated from the selected plan.
  const [charter, setCharter] = useState("");
  const [persona, setPersona] = useState("");
  const [items, setItems] = useState<DraftSeedItem[]>([]);

  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId);

  const refreshPlans = useCallback(
    async (targetFlowId: string) => {
      const next = await onListPlans(targetFlowId);
      if (next) {
        setPlans(next);
      }
      return next;
    },
    [onListPlans]
  );

  function hydrate(plan: SeedPlan) {
    setSelectedPlanId(plan.id);
    setCharter(plan.charter ?? "");
    setPersona(plan.persona ?? "");
    setItems(plan.items.map(toDraft));
  }

  // Load the flow's plans when the flow changes.
  useEffect(() => {
    setPlans([]);
    setSelectedPlanId(undefined);
    setPlanningJobId(undefined);
    if (!flowId) {
      return;
    }
    void refreshPlans(flowId);
  }, [flowId, refreshPlans]);

  // While a planning run is in flight, poll for its persisted plan and select
  // it when it lands (the panel renders from the plan row, never the raw job).
  useEffect(() => {
    if (!flowId || !planningJobId) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshPlans(flowId).then((next) => {
        const landed = next?.find((plan) => plan.outlineJobId === planningJobId);
        if (landed) {
          setPlanningJobId(undefined);
          hydrate(landed);
        }
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [flowId, planningJobId, refreshPlans]);

  async function propose() {
    setBusy(true);
    try {
      const outcome = await onPropose(flowId, notes);
      if (outcome) {
        setPlanningJobId(outcome.jobId);
      }
    } finally {
      setBusy(false);
    }
  }

  function updateItem(id: string, patch: Partial<DraftSeedItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function saveEdits() {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      const updated = await onPatch(selectedPlan.id, {
        charter,
        persona,
        items: items.map(toItemPatch)
      });
      if (updated) {
        setPlans((current) => current.map((plan) => (plan.id === updated.id ? updated : plan)));
        hydrate(updated);
      }
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      const outcome = await onApprove(selectedPlan.id);
      if (outcome) {
        setPlans((current) => current.map((plan) => (plan.id === outcome.plan.id ? outcome.plan : plan)));
        hydrate(outcome.plan);
      }
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (!selectedPlan) return;
    setBusy(true);
    try {
      const updated = await onDismiss(selectedPlan.id);
      if (updated) {
        setPlans((current) => current.map((plan) => (plan.id === updated.id ? updated : plan)));
        hydrate(updated);
      }
    } finally {
      setBusy(false);
    }
  }

  const canPropose = Boolean(flowId) && !busy && !planningJobId;
  const reviewable = selectedPlan?.status === "proposed";

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
        <Field label="Steer notes (optional)">
          <Textarea
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Anything to steer this planning run — emphasis, exclusions, audience."
            rows={3}
            value={notes}
          />
        </Field>
        <Button variant="primary" disabled={loading || !canPropose} onClick={() => void propose()} type="button">
          {planningJobId ? "Planning…" : "Propose seed plan"}
        </Button>
        <Hint>
          The planning agent explores the flow&rsquo;s source repositories and proposes a complete document plan —
          no topic needed. The plan appears below for review; nothing is drafted until you approve it.
        </Hint>
      </SeedForm>

      {flowId ? (
        <PlanArea>
          <h3>Plans</h3>
          {plans.length > 0 ? (
            <PlanList>
              {plans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  $selected={plan.id === selectedPlanId}
                  onClick={() => hydrate(plan)}
                  type="button"
                >
                  <Badge tone={statusTone(plan.status)}>{plan.status}</Badge>
                  <Badge mono>{plan.origin}</Badge>
                  <span>
                    {plan.items.length} document{plan.items.length === 1 ? "" : "s"}
                  </span>
                  <span>{planDate(plan)}</span>
                </PlanRow>
              ))}
            </PlanList>
          ) : (
            <EmptyState>
              {planningJobId
                ? "Planning — exploring the flow's sources; the plan will appear here for review when ready."
                : "No plans yet. Propose one above, or let the hourly seed bootstrap propose one for a sparse flow."}
            </EmptyState>
          )}
        </PlanArea>
      ) : null}

      {selectedPlan ? (
        <PlanArea>
          <Row justify="between" gap="lg">
            <h3>Review plan</h3>
            <Badge tone={statusTone(selectedPlan.status)}>{selectedPlan.status}</Badge>
          </Row>

          <CharterBlock>
            <Field label="Charter — what this knowledge base should cover">
              {reviewable ? (
                <Textarea onChange={(event) => setCharter(event.target.value)} rows={3} value={charter} />
              ) : (
                <p>{selectedPlan.charter ?? "—"}</p>
              )}
            </Field>
            <Field label="Persona — audience and voice">
              {reviewable ? (
                <Input onChange={(event) => setPersona(event.target.value)} type="text" value={persona} />
              ) : (
                <p>{selectedPlan.persona ?? "—"}</p>
              )}
            </Field>
            {selectedPlan.charterProposed || selectedPlan.personaProposed ? (
              <Row gap="md">
                <Hint>{COPY_TO_CONFIG_HINT}</Hint>
                <Chip
                  onClick={() =>
                    void navigator.clipboard?.writeText(
                      JSON.stringify({ ...(charter ? { charter } : {}), ...(persona ? { persona } : {}) })
                    )
                  }
                  type="button"
                >
                  Copy to clipboard
                </Chip>
              </Row>
            ) : null}
            {selectedPlan.rationale ? <Hint>{selectedPlan.rationale}</Hint> : null}
          </CharterBlock>

          <ItemList>
            {items.map((item) => (
              <ItemCard key={item.id} $dismissed={item.status === "dismissed"}>
                {reviewable ? (
                  <>
                    <Row justify="between" gap="lg">
                      <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                      <Actions>
                        <Chip
                          onClick={() =>
                            updateItem(item.id, { status: item.status === "dismissed" ? "proposed" : "dismissed" })
                          }
                          type="button"
                        >
                          {item.status === "dismissed" ? "Restore" : "Dismiss document"}
                        </Chip>
                      </Actions>
                    </Row>
                    <Field label="Title">
                      <Input
                        onChange={(event) => updateItem(item.id, { title: event.target.value })}
                        placeholder="Document title (optional — derived if blank)"
                        type="text"
                        value={item.title}
                      />
                    </Field>
                    <Field label="Target path (optional)">
                      <Input
                        onChange={(event) => updateItem(item.id, { targetPath: event.target.value })}
                        placeholder="kebab-case/path.md"
                        type="text"
                        value={item.targetPath}
                      />
                    </Field>
                    <Field label="Coverage — one point per line">
                      <Textarea
                        onChange={(event) => updateItem(item.id, { coverage: event.target.value })}
                        placeholder="What this document should cover…"
                        rows={4}
                        value={item.coverage}
                      />
                    </Field>
                    <Field label="Motivating questions (optional) — one per line">
                      <Textarea
                        onChange={(event) => updateItem(item.id, { questions: event.target.value })}
                        rows={2}
                        value={item.questions}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Row justify="between" gap="lg">
                      <strong>{item.title || item.targetPath || "Untitled document"}</strong>
                      {item.status === "dismissed" ? (
                        <Badge tone="failed">dismissed</Badge>
                      ) : item.draftJobId ? (
                        <Badge tone="completed">drafting / proposed — see Proposals</Badge>
                      ) : (
                        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                      )}
                    </Row>
                    <ReadonlyPoints>
                      {linesToArray(item.coverage).map((point, index) => (
                        <li key={index}>{point}</li>
                      ))}
                    </ReadonlyPoints>
                  </>
                )}
              </ItemCard>
            ))}
          </ItemList>

          {reviewable ? (
            <Actions>
              <Button variant="secondary" disabled={busy} onClick={() => void saveEdits()} type="button">
                Save edits
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void approve()} type="button">
                Approve plan
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void dismiss()} type="button">
                Dismiss plan
              </Button>
            </Actions>
          ) : null}
        </PlanArea>
      ) : null}
    </SeedPanelRoot>
  );
}
