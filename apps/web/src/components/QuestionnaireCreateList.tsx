import type { QuestionnaireSummary } from "@magpie/core";
import { parseTwoColumnPaste } from "./questionnaireItems";
import { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { Actions, Badge, Button, EmptyState, Field, Input, Select, Stack, Textarea } from "./ui";

interface QuestionnaireCreateListProps {
  flows: Array<{ id: string; name: string }>;
  loading: boolean;
  onList: () => Promise<QuestionnaireSummary[] | undefined>;
  onCreate: (
    name: string,
    flowId: string,
    // A bare string, or a question paired with the answer previously given to
    // it when ingesting a completed questionnaire.
    questions: Array<string | { question: string; importedAnswer?: string }>,
    direction?: string,
    importOrigin?: string
  ) => Promise<{ id: string } | undefined>;
  // Navigate to a questionnaire's detail page. Supplied by the page as a
  // router.push wrapper, so this component stays free of next/navigation and
  // tests without a router mock.
  onOpen: (id: string) => void;
}

// Index view for questionnaire mode (docs/questionnaires.md): create a batch and
// pick an existing one from the list. Opening a questionnaire navigates to its
// own detail page — the worksheet no longer renders inline here, so this view is
// just the form and the list.
export function QuestionnaireCreateList({ flows, loading, onList, onCreate, onOpen }: QuestionnaireCreateListProps) {
  const [summaries, setSummaries] = useState<QuestionnaireSummary[]>([]);
  const [name, setName] = useState("");
  const [flowId, setFlowId] = useState("");
  const [questionsText, setQuestionsText] = useState("");
  const [importOrigin, setImportOrigin] = useState("");
  const [direction, setDirection] = useState("");
  const [creating, setCreating] = useState(false);

  // ConsoleProvider hands down fresh handler identities on every poll
  // re-render; pin onList behind a ref so the mount effect stays stable (the
  // SeedPanel pattern — load-bearing, not stylistic).
  const onListRef = useRef(onList);
  onListRef.current = onList;
  const refreshList = useCallback(async () => {
    const next = await onListRef.current();
    if (next) {
      setSummaries(next);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  async function submitCreate() {
    // One question per line, or "question<TAB>previously-given answer" when a
    // completed questionnaire is being ingested — a two-column spreadsheet
    // selection pasted straight in already carries the tab.
    const questions = parseTwoColumnPaste(questionsText);
    if (!name.trim() || !flowId || questions.length === 0) return;
    const anyImported = questions.some((entry) => entry.importedAnswer);
    setCreating(true);
    try {
      const created = await onCreate(
        name.trim(),
        flowId,
        questions,
        direction.trim() || undefined,
        // Only an import needs an origin; without one the batch takes the
        // ordinary path, exactly as it did before ingestion existed.
        anyImported ? importOrigin.trim() || "pasted" : undefined
      );
      if (created) {
        setName("");
        setQuestionsText("");
        setImportOrigin("");
        setDirection("");
        onOpen(created.id);
      }
    } finally {
      setCreating(false);
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
        <Field label="Direction (optional) — how ambiguous questions should be read. Cannot be changed later.">
          <Textarea
            rows={2}
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="Where ambiguous, assume the question is about the company and not the product."
          />
        </Field>
        <Field label="Questions (one per line). To ingest a completed questionnaire, paste two columns — the question, a tab, then the answer previously given.">
          <Textarea
            rows={6}
            value={questionsText}
            onChange={(event) => setQuestionsText(event.target.value)}
            placeholder={"What certifications does the product hold?\nWhere is customer data stored?"}
          />
        </Field>
        <Field label="Import source (optional) — where a completed questionnaire came from, e.g. the file name.">
          <Input
            value={importOrigin}
            onChange={(event) => setImportOrigin(event.target.value)}
            placeholder="acme-sig-2025.xlsx"
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
            <QuestionnaireRow key={summary.id} type="button" onClick={() => onOpen(summary.id)}>
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
    </Stack>
  );
}

const QuestionnaireList = styled.div(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  borderTop: `1px solid ${theme.color.border}`
}));

const QuestionnaireRow = styled.button(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.md,
  padding: `${theme.space.md} ${theme.space.sm}`,
  border: "none",
  borderBottom: `1px solid ${theme.color.border}`,
  background: "transparent",
  color: theme.color.text,
  cursor: "pointer",
  textAlign: "left",
  fontSize: theme.font.size.md,
  "&:hover": { background: theme.color.surfaceMuted }
}));
