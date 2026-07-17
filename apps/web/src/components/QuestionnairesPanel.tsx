import type { Questionnaire, QuestionnaireItem, QuestionnaireSummary } from "@magpie/core";
import { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { Actions, Badge, Button, EmptyState, Field, Input, Row, Select, Stack, Textarea } from "./ui";
import type { StatusTone } from "../theme/theme";

interface QuestionnairesPanelProps {
  flows: Array<{ id: string; name: string }>;
  loading: boolean;
  onList: () => Promise<QuestionnaireSummary[] | undefined>;
  onGet: (id: string) => Promise<Questionnaire | undefined>;
  onCreate: (name: string, flowId: string, questions: string[]) => Promise<Questionnaire | undefined>;
  onApproveItem: (questionnaireId: string, itemId: string) => Promise<boolean>;
  onApproveReused: (questionnaireId: string) => Promise<number | undefined>;
  onExport: (id: string, format: "md" | "csv") => Promise<void>;
}

const POLL_INTERVAL_MS = 5_000;

// Worksheet UI for questionnaire mode (docs/questionnaires.md): create a batch,
// watch items resolve (reused / fresh / changed / unanswerable), review the
// change explanations, approve answers into the future match corpus, export.
export function QuestionnairesPanel({
  flows,
  loading,
  onList,
  onGet,
  onCreate,
  onApproveItem,
  onApproveReused,
  onExport
}: QuestionnairesPanelProps) {
  const [summaries, setSummaries] = useState<QuestionnaireSummary[]>([]);
  const [selected, setSelected] = useState<Questionnaire | undefined>(undefined);
  const [name, setName] = useState("");
  const [flowId, setFlowId] = useState("");
  const [questionsText, setQuestionsText] = useState("");
  const [creating, setCreating] = useState(false);

  // ConsoleProvider hands down fresh handler identities on every poll
  // re-render; pin them behind refs so the effects below stay stable (the
  // SeedPanel pattern — load-bearing, not stylistic).
  const onListRef = useRef(onList);
  onListRef.current = onList;
  const onGetRef = useRef(onGet);
  onGetRef.current = onGet;
  const refreshList = useCallback(async () => {
    const next = await onListRef.current();
    if (next) {
      setSummaries(next);
    }
  }, []);
  const refreshSelected = useCallback(async (id: string) => {
    const next = await onGetRef.current(id);
    if (next) {
      setSelected(next);
    }
    return next;
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Poll the open worksheet while any item is still moving; the server-side
  // read also resumes a stalled drip, so this doubles as restart recovery.
  const selectedId = selected?.id;
  const selectedActive = selected?.items.some((item) => item.status === "pending" || item.status === "answering");
  useEffect(() => {
    if (!selectedId || !selectedActive) return;
    const interval = window.setInterval(() => {
      void refreshSelected(selectedId).then(() => refreshList());
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [selectedId, selectedActive, refreshSelected, refreshList]);

  async function submitCreate() {
    const questions = questionsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!name.trim() || !flowId || questions.length === 0) return;
    setCreating(true);
    try {
      const created = await onCreate(name.trim(), flowId, questions);
      if (created) {
        setName("");
        setQuestionsText("");
        setSelected(created);
        await refreshList();
      }
    } finally {
      setCreating(false);
    }
  }

  async function approveItem(itemId: string) {
    if (!selected) return;
    if (await onApproveItem(selected.id, itemId)) {
      await refreshSelected(selected.id);
      await refreshList();
    }
  }

  async function approveAllReused() {
    if (!selected) return;
    if ((await onApproveReused(selected.id)) !== undefined) {
      await refreshSelected(selected.id);
      await refreshList();
    }
  }

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme SIG Q3 2026" />
        </Field>
        <Field label="Flow">
          <Select value={flowId} onChange={(event) => setFlowId(event.target.value)}>
            <option value="">Select a flow…</option>
            {flows.map((flow) => (
              <option key={flow.id} value={flow.id}>
                {flow.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Questions (one per line)">
          <Textarea
            rows={6}
            value={questionsText}
            onChange={(event) => setQuestionsText(event.target.value)}
            placeholder={"What certifications does the product hold?\nWhere is customer data stored?"}
          />
        </Field>
        <Actions>
          <Button variant="primary" disabled={creating || loading} onClick={() => void submitCreate()}>
            {creating ? "Creating…" : "Create questionnaire"}
          </Button>
        </Actions>
      </Stack>

      {summaries.length > 0 ? (
        <QuestionnaireList>
          {summaries.map((summary) => (
            <QuestionnaireRow
              key={summary.id}
              type="button"
              $selected={summary.id === selected?.id}
              onClick={() => void refreshSelected(summary.id)}
            >
              <strong>{summary.name}</strong>
              <Badge tone="neutral">{summary.flowId}</Badge>
              <span>
                {summary.counts.reused} reused / {summary.counts.total} total
              </span>
              <Badge tone={summary.counts.pending > 0 ? "running" : "completed"}>
                {summary.counts.pending > 0 ? `${summary.counts.pending} in progress` : "complete"}
              </Badge>
            </QuestionnaireRow>
          ))}
        </QuestionnaireList>
      ) : (
        <EmptyState>No questionnaires yet. Paste one above to get started.</EmptyState>
      )}

      {selected ? (
        <Stack gap="md">
          <Row gap="sm" justify="between">
            <h3>{selected.name}</h3>
            <Row gap="sm">
              <Button variant="secondary" onClick={() => void approveAllReused()}>
                Approve all reused
              </Button>
              <ExportButton type="button" onClick={() => void onExport(selected.id, "md")}>
                Export .md
              </ExportButton>
              <ExportButton type="button" onClick={() => void onExport(selected.id, "csv")}>
                Export .csv
              </ExportButton>
            </Row>
          </Row>
          <Stack gap="md">
            {selected.items.map((item) => (
              <ItemCard key={item.id}>
                <Row gap="sm">
                  <Badge tone={itemTone(item)}>{itemLabel(item)}</Badge>
                  <strong>
                    {item.position + 1}. {item.question}
                  </strong>
                </Row>
                {item.answer && item.status !== "unanswerable" ? <AnswerText>{item.answer}</AnswerText> : null}
                {item.status === "unanswerable" ? (
                  <ReasonText>
                    {item.error
                      ? `Failed: ${item.error}`
                      : "The knowledge base could not answer this — it has been logged as a knowledge gap."}
                  </ReasonText>
                ) : null}
                {item.changeReason ? <ReasonText>{changeReasonText(item)}</ReasonText> : null}
                {item.citations.length > 0 ? (
                  <CitationList>
                    {item.citations.map((citation) => (
                      <li key={citation.sectionId}>
                        {citation.path} — {citation.heading}
                      </li>
                    ))}
                  </CitationList>
                ) : null}
                {item.status === "answered" ? (
                  <Actions>
                    <Button variant="secondary" onClick={() => void approveItem(item.id)}>
                      Approve
                    </Button>
                  </Actions>
                ) : null}
                {item.status === "approved" ? (
                  <Badge tone="completed" dot>
                    approved{item.staleAtApproval ? " (stale sources — will re-answer next time)" : ""}
                  </Badge>
                ) : null}
              </ItemCard>
            ))}
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}

function itemTone(item: QuestionnaireItem): StatusTone {
  if (item.status === "unanswerable") return "failed";
  if (item.status === "pending" || item.status === "answering") return "pending";
  if (item.outcome === "reused") return "completed";
  if (item.outcome === "changed") return "running";
  return "neutral";
}

function itemLabel(item: QuestionnaireItem): string {
  if (item.status === "pending") return "queued";
  if (item.status === "answering") return "answering";
  if (item.status === "unanswerable") return "unanswerable";
  if (item.status === "approved") return "approved";
  return item.outcome ?? "answered";
}

function changeReasonText(item: QuestionnaireItem): string {
  const reason = item.changeReason;
  if (!reason) return "";
  const where = reason.heading || reason.path;
  const when = reason.changedAt ? ` on ${reason.changedAt.slice(0, 10)}` : "";
  if (reason.kind === "new_content") {
    return `Re-answered: new relevant content appeared${where ? ` — ${where}` : ""}${when}.`;
  }
  if (reason.kind === "section_changed") {
    return `Re-answered: cited section “${where}” changed${when}.`;
  }
  return `Re-answered: cited section “${where}” no longer exists.`;
}

const QuestionnaireList = styled.div(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  borderTop: `1px solid ${theme.color.border}`
}));

const QuestionnaireRow = styled.button<{ $selected: boolean }>(({ theme, $selected }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  padding: `${theme.space.md} ${theme.space.sm}`,
  border: "none",
  borderBottom: `1px solid ${theme.color.border}`,
  background: $selected ? theme.color.surfaceMuted : "transparent",
  color: theme.color.text,
  cursor: "pointer",
  textAlign: "left",
  fontSize: theme.font.size.md
}));

const ItemCard = styled.article(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  padding: theme.space.lg
}));

const AnswerText = styled.p(({ theme }) => ({
  margin: 0,
  whiteSpace: "pre-wrap",
  color: theme.color.text
}));

const ReasonText = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const CitationList = styled.ul(({ theme }) => ({
  margin: 0,
  paddingLeft: theme.space.lg,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const ExportButton = styled.button(({ theme }) => ({
  alignSelf: "center",
  border: "none",
  background: "transparent",
  padding: 0,
  color: theme.color.accent,
  fontSize: theme.font.size.sm,
  cursor: "pointer",
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" }
}));
