import type { AssertedClaim, Questionnaire, QuestionnaireItem } from "@magpie/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { Actions, Badge, Button, EmptyState, Row, Stack, statusTone } from "./ui";
import { StatBanner, type Stat } from "./StatBanner";
import { changeReasonText, itemLabel, itemTone } from "./questionnaireItems";
import { ImportedAnswerPanel, type ApproveUse } from "./ImportedAnswerPanel";

interface QuestionnaireDetailProps {
  id: string;
  backHref: string;
  onGet: (id: string) => Promise<Questionnaire | undefined>;
  onApproveItem: (questionnaireId: string, itemId: string, use?: ApproveUse) => Promise<boolean>;
  onApproveReused: (questionnaireId: string) => Promise<number | undefined>;
  // Downloads through the console's authed apiDownload (a plain <a href> omits
  // the bearer token and 401s under Auth0 — see ConsoleProvider.exportQuestionnaire).
  onExport: (id: string, format: "md" | "csv") => Promise<void>;
  // Live asserted-claim findings for this questionnaire's flow (questionnaire
  // ingestion). Absent for consoles that do not surface the register; the
  // worksheet then simply shows no findings and the server's 409 remains the
  // backstop on approving unbackable wording.
  onListAssertedClaims?: (flowId: string) => Promise<AssertedClaim[]>;
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
  onExport,
  onListAssertedClaims
}: QuestionnaireDetailProps) {
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | undefined>(undefined);
  // Distinguishes "still loading" from "loaded, but no such questionnaire" so a
  // bad/unknown id shows a not-found state instead of a permanent blank.
  const [loaded, setLoaded] = useState(false);
  const [findings, setFindings] = useState<AssertedClaim[]>([]);

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

  // Findings are fetched per flow and grouped by item, so the worksheet can grey
  // out "Approve imported" on exactly the items the sources cannot back.
  const claimsRef = useRef(onListAssertedClaims);
  claimsRef.current = onListAssertedClaims;
  const flowId = questionnaire?.flowId;
  const isImported = Boolean(questionnaire?.importOrigin);
  useEffect(() => {
    if (!isImported || !flowId || !claimsRef.current) return;
    void claimsRef.current(flowId).then(setFindings);
  }, [isImported, flowId, questionnaire?.items.length]);

  const findingsByItem = new Map<string, AssertedClaim[]>();
  for (const finding of findings) {
    if (finding.status !== "open" || !finding.itemId) continue;
    findingsByItem.set(finding.itemId, [...(findingsByItem.get(finding.itemId) ?? []), finding]);
  }

  async function approveItem(itemId: string, use?: ApproveUse) {
    if (!questionnaire) return;
    if (await onApproveItem(questionnaire.id, itemId, use)) {
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
          <ExportButton type="button" onClick={() => void onExport(questionnaire.id, "md")}>
            Export .md
          </ExportButton>
          <ExportButton type="button" onClick={() => void onExport(questionnaire.id, "csv")}>
            Export .csv
          </ExportButton>
        </Row>
      </Row>

      {questionnaire.direction ? <DirectionNote>Direction: {questionnaire.direction}</DirectionNote> : null}
      {questionnaire.importOrigin ? (
        <DirectionNote>
          Imported from {questionnaire.importOrigin}. Previously-given answers are adjudicated against the knowledge
          base and the sources — never trusted as answers.
        </DirectionNote>
      ) : null}

      <StatBanner stats={itemStats(questionnaire.items)} />

      <Stack gap="md">
        {questionnaire.items.map((item) => (
          <ItemCard key={item.id}>
            <Row gap="sm">
              <Badge tone={itemTone(item)}>{itemLabel(item)}</Badge>
              {item.confidence === "low" || item.confidence === "unknown" ? (
                <Badge tone={statusTone(item.confidence)}>low confidence</Badge>
              ) : null}
              <strong>
                {item.position + 1}. {item.question}
              </strong>
            </Row>
            {item.importedAnswer ? (
              <ImportedAnswerPanel
                item={item}
                findings={findingsByItem.get(item.id) ?? []}
                onApprove={(use) => void approveItem(item.id, use)}
              />
            ) : item.answer && item.status !== "unanswerable" ? (
              <AnswerText>{item.answer}</AnswerText>
            ) : null}
            {!item.importedAnswer && item.status === "unanswerable" ? (
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
            {!item.importedAnswer && item.status === "answered" ? (
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

// The answering direction these answers were written under. Read-only — it is
// set at creation and immutable, so there is nothing to edit here.
const DirectionNote = styled.p(({ theme }) => ({
  margin: 0,
  padding: theme.space.md,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  whiteSpace: "pre-wrap"
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
