import styled from "@emotion/styled";
import { ConfiguredKnowledgeFlow, PromptSummary } from "../lib/types";
import { Badge, Row } from "./ui";

// Mirrors withPersona() in @magpie/prompts: the base instructions, then a fixed
// "Persona" header, then the flow's persona text, then a grounding guard reminding
// the model that a persona never licenses facts the context does not contain —
// sent together as the system prompt.
const ASSEMBLY_EXAMPLE = [
  "<base answer prompt>",
  "",
  "Persona (how to look and respond):",
  "<this flow's persona>",
  "",
  "<grounding guard: the persona changes tone only, never adds facts>"
].join("\n");

// The prompts ordered as the "direction of travel" of a question through the
// system: answer it, find what's missing, propose new knowledge, then keep the
// base tidy. Runtime plumbing sits last because it isn't part of that journey.
// promptIds set the order within a stage; any catalog prompt not listed here
// falls into the "Other prompts" group so nothing is silently hidden.
const STAGES: { id: string; step: string; title: string; blurb: string; promptIds: string[] }[] = [
  {
    id: "answer",
    step: "1",
    title: "Answer a question",
    blurb:
      "A question is routed to the best-matching flow, answered from retrieved Markdown with citations, then the drafted answer is verified against that context before it is returned.",
    promptIds: ["route-question-to-flow", "answer-question", "verify-answer"]
  },
  {
    id: "gaps",
    step: "2",
    title: "Find the gaps",
    blurb: "Questions the knowledge base couldn't answer are summarised into prioritised gaps.",
    promptIds: ["summarize-gap"]
  },
  {
    id: "propose",
    step: "3",
    title: "Propose new knowledge",
    blurb: "Each gap (or cluster of related gaps) becomes a draft Markdown article proposed for review.",
    promptIds: ["draft-markdown-proposal"]
  },
  {
    id: "maintain",
    step: "4",
    title: "Maintain the knowledge base",
    blurb:
      "Patrols check existing documents and fix, de-duplicate, split, or expand them so the base stays correct and tidy as it grows.",
    promptIds: ["verify-document", "correct-document", "dedupe-documents", "split-document", "improve-document"]
  },
  {
    id: "plumbing",
    step: "·",
    title: "Runtime plumbing",
    blurb: "Provider-level prompts that support the jobs above but aren't a stage of the knowledge journey.",
    promptIds: ["generic-job", "job-runner-system"]
  }
];

const PromptFlow = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.xxl
}));

// Each stage is a step in the question's journey. A connector line runs down the
// left edge from one step badge to the next so the pipeline reads top-to-bottom.
const PromptStage = styled.section(({ theme }) => ({
  position: "relative",
  display: "grid",
  gap: theme.space.lg,
  "&:not(:last-child)::before": {
    content: '""',
    position: "absolute",
    left: "15px",
    top: "34px",
    bottom: `calc(-1 * ${theme.space.xxl})`,
    width: "2px",
    background: `linear-gradient(${theme.color.status.completed.border}, ${theme.color.border})`
  }
}));

const PromptStageHead = styled.header(({ theme }) => ({
  display: "flex",
  alignItems: "flex-start",
  gap: theme.space.lg
}));

const PromptStageStep = styled.span(({ theme }) => ({
  position: "relative",
  zIndex: 1,
  flex: "0 0 auto",
  width: "32px",
  height: "32px",
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: theme.color.status.completed.fg,
  color: theme.color.page,
  fontWeight: theme.font.weight.semibold,
  fontSize: theme.font.size.base
}));

const PromptStageTitle = styled.h2(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.xl,
  fontWeight: theme.font.weight.semibold
}));

const PromptStageBlurb = styled.p(({ theme }) => ({
  margin: `${theme.space.xs} 0 0`,
  maxWidth: "60ch",
  color: theme.color.textMuted,
  fontSize: theme.font.size.md,
  lineHeight: 1.45
}));

const PromptList = styled.div<{ $indented?: boolean }>(({ theme, $indented = false }) => ({
  display: "grid",
  gap: theme.space.xl,
  marginLeft: $indented ? "46px" : undefined
}));

const PromptCardRoot = styled.article(({ theme }) => ({
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  padding: theme.space.xl,
  background: theme.color.surface,
  display: "grid",
  gap: theme.space.lg
}));

const PromptCardHead = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: theme.space.lg,
  "& h3": {
    margin: 0,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.semibold
  },
  "& code": {
    color: theme.color.textMuted,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs
  }
}));

const PromptDescription = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.textMuted
}));

const PromptOutput = styled.p(({ theme }) => ({
  margin: 0,
  fontSize: theme.font.size.md,
  color: theme.color.textMuted
}));

const PromptInstructions = styled.pre(({ theme }) => ({
  margin: 0,
  padding: theme.space.lg,
  background: theme.color.text,
  color: theme.color.page,
  borderRadius: theme.radius.md,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: theme.font.size.sm,
  lineHeight: 1.45,
  overflowX: "auto"
}));

const PromptEmpty = styled.p(({ theme }) => ({
  color: theme.color.textMuted
}));

const PersonaAssembly = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  padding: theme.space.lg,
  border: `1px dashed ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted
}));

const PersonaAssemblyLabel = styled.span(({ theme }) => ({
  fontSize: theme.font.size.xs,
  letterSpacing: "0.02em",
  color: theme.color.textMuted,
  fontWeight: theme.font.weight.semibold
}));

const FlowPersonaList = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg
}));

const FlowPersona = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  padding: theme.space.lg,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceMuted,
  "& h3": {
    margin: 0,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold
  }
}));

// Read-only catalog view: renders the exact instruction text and usage of every
// AI prompt served by GET /api/prompts, so the wording sent to the model is
// inspectable from the console without reading the source. Prompts are grouped
// into the pipeline stages above to make the flow of a question legible. Also
// lists each configured flow's persona — the snippet appended to the base answer
// prompt when that flow answers a question (configured in KNOWLEDGE_FLOWS).
export function PromptsPanel({ prompts, flows }: { prompts: PromptSummary[]; flows: ConfiguredKnowledgeFlow[] }) {
  if (prompts.length === 0) {
    return <PromptEmpty>No prompts are registered.</PromptEmpty>;
  }

  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const stagedIds = new Set(STAGES.flatMap((stage) => stage.promptIds));
  const leftovers = prompts.filter((prompt) => !stagedIds.has(prompt.id));

  return (
    <PromptFlow>
      {STAGES.map((stage) => {
        const stagePrompts = stage.promptIds
          .map((id) => byId.get(id))
          .filter((prompt): prompt is PromptSummary => Boolean(prompt));
        if (stagePrompts.length === 0 && !(stage.id === "answer" && flows.length > 0)) {
          return null;
        }

        return (
          <PromptStage key={stage.id}>
            <PromptStageHead>
              <PromptStageStep aria-hidden>{stage.step}</PromptStageStep>
              <div>
                <PromptStageTitle>{stage.title}</PromptStageTitle>
                <PromptStageBlurb>{stage.blurb}</PromptStageBlurb>
              </div>
            </PromptStageHead>
            <PromptList $indented>
              {stage.id === "answer" ? <FlowPersonasCard flows={flows} /> : null}
              {stagePrompts.map((prompt) => (
                <PromptCard prompt={prompt} key={prompt.id} />
              ))}
            </PromptList>
          </PromptStage>
        );
      })}

      {leftovers.length > 0 ? (
        <PromptStage>
          <PromptStageHead>
            <PromptStageStep aria-hidden>+</PromptStageStep>
            <div>
              <PromptStageTitle>Other prompts</PromptStageTitle>
              <PromptStageBlurb>Registered in the catalog but not yet placed in the pipeline view.</PromptStageBlurb>
            </div>
          </PromptStageHead>
          <PromptList $indented>
            {leftovers.map((prompt) => (
              <PromptCard prompt={prompt} key={prompt.id} />
            ))}
          </PromptList>
        </PromptStage>
      ) : null}
    </PromptFlow>
  );
}

function PromptCard({ prompt }: { prompt: PromptSummary }) {
  return (
    <PromptCardRoot>
      <PromptCardHead>
        <h3>{prompt.title}</h3>
        <code>{prompt.id}</code>
      </PromptCardHead>
      <PromptDescription>{prompt.description}</PromptDescription>
      <Row gap="sm" wrap>
        {prompt.usedBy.map((usage) => (
          <Badge tone="neutral" key={usage}>
            {usage}
          </Badge>
        ))}
      </Row>
      <PromptOutput>
        <strong>Output:</strong> {prompt.outputShape}
      </PromptOutput>
      <PromptInstructions>{prompt.instructions}</PromptInstructions>
    </PromptCardRoot>
  );
}

function FlowPersonasCard({ flows }: { flows: ConfiguredKnowledgeFlow[] }) {
  if (flows.length === 0) {
    return null;
  }

  return (
    <PromptCardRoot>
      <PromptCardHead>
        <h3>Flow personas</h3>
        <code>KNOWLEDGE_FLOWS</code>
      </PromptCardHead>
      <PromptDescription>
        Routing scopes retrieval to one flow&apos;s knowledge and appends that flow&apos;s persona to the base{" "}
        <code>answer-question</code> prompt below.
      </PromptDescription>
      <PersonaAssembly>
        <PersonaAssemblyLabel>How the prompt is assembled</PersonaAssemblyLabel>
        <PromptInstructions>{ASSEMBLY_EXAMPLE}</PromptInstructions>
        <PromptOutput>
          The persona is appended verbatim by <code>withPersona()</code>, followed by a fixed grounding guard (a persona
          shapes tone and framing only — it never adds facts the context does not contain) — so the same base
          instructions are reused for every flow.
        </PromptOutput>
      </PersonaAssembly>
      <FlowPersonaList>
        {flows.map((flow) => (
          <FlowPersona key={flow.id}>
            <PromptCardHead>
              <h3>{flow.name}</h3>
              <code>{flow.id}</code>
            </PromptCardHead>
            {flow.persona ? (
              <PromptInstructions>{flow.persona}</PromptInstructions>
            ) : (
              <PromptOutput>No persona — uses the base prompt unchanged.</PromptOutput>
            )}
          </FlowPersona>
        ))}
      </FlowPersonaList>
    </PromptCardRoot>
  );
}
