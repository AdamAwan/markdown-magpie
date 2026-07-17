import type { Questionnaire, QuestionnaireItem } from "@magpie/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { Actions, Badge, Button, EmptyState, Row, Stack } from "./ui";
import { StatBanner, type Stat } from "./StatBanner";
import { changeReasonText, itemLabel, itemTone } from "./questionnaireItems";

interface QuestionnaireDetailProps {
  id: string;
  backHref: string;
  onGet: (id: string) => Promise<Questionnaire | undefined>;
  onApproveItem: (questionnaireId: string, itemId: string) => Promise<boolean>;
  onApproveReused: (questionnaireId: string) => Promise<number | undefined>;
  exportHref: (id: string, format: "md" | "csv") => string;
}

const POLL_INTERVAL_MS = 5_000;

// Full-page worksheet for a single questionnaire: a back link to the list, a
// strong name/flow header, a stat banner of item states, the export/approve
// actions, and the item cards. Owns its own fetch + polling so the detail URL
// works on direct navigation and refresh, independent of the list.
export function QuestionnaireDetail({
  id,
  backHref,
  onGet,
  onApproveItem,
  onApproveReused,
  exportHref
}: QuestionnaireDetailProps) {
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | undefined>(undefined);
  // Distinguishes "still loading" from "loaded, but no such questionnaire" so a
  // bad/unknown id shows a not-found state instead of a permanent blank.
  const [loaded, setLoaded] = useState(false);

  // ConsoleProvider hands down fresh handler identities on every poll
  // re-render; pin onGet behind a ref so the effects below stay stable.
  const onGetRef = useRef(onGet);
  onGetRef.current = onGet;
  const refresh = useCallback(async () => {
    const next = await onGetRef.current(id);
    setQuestionnaire(next);
    setLoaded(true);
    return next;
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any item is still moving; the server-side read also resumes a
  // stalled answer drip, so this doubles as restart recovery.
  const active = questionnaire?.items.some((item) => item.status === "pending" || item.status === "answering");
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, refresh]);

  async function approveItem(itemId: string) {
    if (!questionnaire) return;
    if (await onApproveItem(questionnaire.id, itemId)) {
      await refresh();
    }
  }

  async function approveAllReused() {
    if (!questionnaire) return;
    if ((await onApproveReused(questionnaire.id)) !== undefined) {
      await refresh();
    }
  }

  if (!loaded) {
    return <EmptyState>Loading…</EmptyState>;
  }

  if (!questionnaire) {
    return (
      <Stack gap="md">
        <BackLink href={backHref}>← Questionnaires</BackLink>
        <EmptyState>Questionnaire not found.</EmptyState>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <BackLink href={backHref}>← Questionnaires</BackLink>
      <Row gap="sm" justify="between" wrap>
        <Row gap="sm" wrap>
          <h2>{questionnaire.name}</h2>
          <Badge tone="neutral">{questionnaire.flowId}</Badge>
        </Row>
        <Row gap="sm">
          <Button variant="secondary" onClick={() => void approveAllReused()}>
            Approve all reused
          </Button>
          <ExportLink href={exportHref(questionnaire.id, "md")}>Export .md</ExportLink>
          <ExportLink href={exportHref(questionnaire.id, "csv")}>Export .csv</ExportLink>
        </Row>
      </Row>

      <StatBanner stats={itemStats(questionnaire.items)} />

      <Stack gap="md">
        {questionnaire.items.map((item) => (
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
  );
}

// The stat banner's six tiles, derived live from the items (not the summary
// counts, which fold `answering` into `pending`). "Reused" is an outcome, so it
// deliberately overlaps the answered/approved buckets.
function itemStats(items: QuestionnaireItem[]): Stat[] {
  const count = (predicate: (item: QuestionnaireItem) => boolean) => items.filter(predicate).length;
  return [
    { label: "Total", value: items.length },
    { label: "Approved", value: count((item) => item.status === "approved") },
    { label: "Awaiting approval", value: count((item) => item.status === "answered") },
    { label: "In progress", value: count((item) => item.status === "pending" || item.status === "answering") },
    { label: "Unanswerable", value: count((item) => item.status === "unanswerable") },
    { label: "Reused", value: count((item) => item.outcome === "reused") }
  ];
}

const BackLink = styled(Link)(({ theme }) => ({
  alignSelf: "start",
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.medium,
  textDecoration: "none",
  "&:hover": { color: theme.color.text, textDecoration: "underline" }
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

const ExportLink = styled.a(({ theme }) => ({
  alignSelf: "center",
  color: theme.color.accent,
  fontSize: theme.font.size.sm,
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" }
}));
