import type { AssertedClaim, ImportVerdict, QuestionnaireItem } from "@magpie/core";
import styled from "@emotion/styled";
import { Actions, Badge, Button, Row, Stack } from "./ui";
import type { StatusTone } from "../theme/theme";

export type ApproveUse = "imported" | "magpie";

interface ImportedAnswerPanelProps {
  item: QuestionnaireItem;
  // Live findings against this item. A non-empty list forbids approving the
  // IMPORTED wording (ingestion spec D7) — the server enforces it too (409); the
  // disabled button is so a reviewer is not invited to try.
  findings: AssertedClaim[];
  onApprove: (use: ApproveUse) => void;
}

// Side-by-side review of an imported questionnaire answer: the previously-given
// wording against the answer Magpie derived from the knowledge base, plus the
// stage-1 verdict and any findings the source-grounded check raised. The
// reviewer chooses which wording enters the match corpus.
export function ImportedAnswerPanel({ item, findings, onApprove }: ImportedAnswerPanelProps) {
  const blocked = findings.length > 0;
  return (
    <Stack gap="sm">
      {item.importVerdict ? (
        <Row gap="sm" wrap>
          <Badge tone={verdictTone(item.importVerdict)}>{verdictLabel(item.importVerdict)}</Badge>
          <VerdictNote>{verdictExplanation(item.importVerdict)}</VerdictNote>
        </Row>
      ) : null}

      <Columns>
        <Column>
          <ColumnHeading>Previously given</ColumnHeading>
          <AnswerText>{item.importedAnswer}</AnswerText>
        </Column>
        <Column>
          <ColumnHeading>Magpie, from the knowledge base</ColumnHeading>
          {item.answer && item.status !== "unanswerable" ? (
            <AnswerText>{item.answer}</AnswerText>
          ) : (
            <MutedText>No grounded answer — the knowledge base does not cover this.</MutedText>
          )}
        </Column>
      </Columns>

      {blocked ? (
        <FindingList>
          {findings.map((finding) => (
            <FindingItem key={finding.id}>
              <Badge tone="failed">{finding.kind}</Badge> {finding.claim}
              {finding.positions.length > 0 ? (
                <PositionList>
                  {finding.positions.map((position, index) => (
                    <li key={`${position.sourceId}-${position.path}-${index}`}>
                      {position.path} — {position.statement}
                    </li>
                  ))}
                </PositionList>
              ) : null}
            </FindingItem>
          ))}
        </FindingList>
      ) : null}

      {item.status === "answered" ? (
        <Actions>
          <Button
            variant="secondary"
            disabled={blocked || !item.importedAnswer}
            title={
              blocked
                ? "The sources do not support this answer — resolve the finding first, or approve Magpie's answer."
                : undefined
            }
            onClick={() => onApprove("imported")}
          >
            Approve imported
          </Button>
          <Button variant="secondary" onClick={() => onApprove("magpie")}>
            Approve Magpie&apos;s
          </Button>
        </Actions>
      ) : null}
    </Stack>
  );
}

function verdictTone(verdict: ImportVerdict): StatusTone {
  if (verdict === "confirmed") return "completed";
  if (verdict === "divergent") return "running";
  return "failed";
}

function verdictLabel(verdict: ImportVerdict): string {
  return verdict;
}

function verdictExplanation(verdict: ImportVerdict): string {
  if (verdict === "confirmed") {
    return "The knowledge base agrees with the answer previously given.";
  }
  if (verdict === "divergent") {
    return "Both are grounded, but they differ on a material point.";
  }
  return "The knowledge base does not cover this question.";
}

const Columns = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  gridTemplateColumns: "1fr",
  "@media (min-width: 900px)": { gridTemplateColumns: "1fr 1fr" }
}));

const Column = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xs,
  alignContent: "start",
  padding: theme.space.md,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted
}));

const ColumnHeading = styled.h4(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.medium
}));

const AnswerText = styled.p(({ theme }) => ({
  margin: 0,
  whiteSpace: "pre-wrap",
  color: theme.color.text
}));

const MutedText = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const VerdictNote = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));

const FindingList = styled.ul(({ theme }) => ({
  margin: 0,
  padding: theme.space.md,
  paddingLeft: theme.space.lg,
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  display: "grid",
  gap: theme.space.sm,
  color: theme.color.text,
  fontSize: theme.font.size.sm
}));

const FindingItem = styled.li({ margin: 0 });

const PositionList = styled.ul(({ theme }) => ({
  margin: 0,
  paddingLeft: theme.space.lg,
  color: theme.color.textMuted
}));
