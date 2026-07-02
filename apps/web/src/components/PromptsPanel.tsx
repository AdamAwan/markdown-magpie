import { ConfiguredKnowledgeFlow, PromptSummary } from "../lib/types";

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
    blurb: "Patrols check existing documents and fix, de-duplicate, split, or expand them so the base stays correct and tidy as it grows.",
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

// Read-only catalog view: renders the exact instruction text and usage of every
// AI prompt served by GET /api/prompts, so the wording sent to the model is
// inspectable from the console without reading the source. Prompts are grouped
// into the pipeline stages above to make the flow of a question legible. Also
// lists each configured flow's persona — the snippet appended to the base answer
// prompt when that flow answers a question (configured in KNOWLEDGE_FLOWS).
export function PromptsPanel({
  prompts,
  flows
}: {
  prompts: PromptSummary[];
  flows: ConfiguredKnowledgeFlow[];
}) {
  if (prompts.length === 0) {
    return <p className="promptEmpty">No prompts are registered.</p>;
  }

  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const stagedIds = new Set(STAGES.flatMap((stage) => stage.promptIds));
  const leftovers = prompts.filter((prompt) => !stagedIds.has(prompt.id));

  return (
    <div className="promptFlow">
      {STAGES.map((stage) => {
        const stagePrompts = stage.promptIds
          .map((id) => byId.get(id))
          .filter((prompt): prompt is PromptSummary => Boolean(prompt));
        if (stagePrompts.length === 0 && !(stage.id === "answer" && flows.length > 0)) {
          return null;
        }

        return (
          <section className="promptStage" key={stage.id}>
            <header className="promptStageHead">
              <span className="promptStageStep" aria-hidden>
                {stage.step}
              </span>
              <div>
                <h2 className="promptStageTitle">{stage.title}</h2>
                <p className="promptStageBlurb">{stage.blurb}</p>
              </div>
            </header>
            <div className="promptList">
              {stage.id === "answer" ? <FlowPersonasCard flows={flows} /> : null}
              {stagePrompts.map((prompt) => (
                <PromptCard prompt={prompt} key={prompt.id} />
              ))}
            </div>
          </section>
        );
      })}

      {leftovers.length > 0 ? (
        <section className="promptStage">
          <header className="promptStageHead">
            <span className="promptStageStep" aria-hidden>
              +
            </span>
            <div>
              <h2 className="promptStageTitle">Other prompts</h2>
              <p className="promptStageBlurb">Registered in the catalog but not yet placed in the pipeline view.</p>
            </div>
          </header>
          <div className="promptList">
            {leftovers.map((prompt) => (
              <PromptCard prompt={prompt} key={prompt.id} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PromptCard({ prompt }: { prompt: PromptSummary }) {
  return (
    <article className="promptCard">
      <div className="promptCardHead">
        <h3>{prompt.title}</h3>
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
  );
}

function FlowPersonasCard({ flows }: { flows: ConfiguredKnowledgeFlow[] }) {
  if (flows.length === 0) {
    return null;
  }

  return (
    <article className="promptCard">
      <div className="promptCardHead">
        <h3>Flow personas</h3>
        <code>KNOWLEDGE_FLOWS</code>
      </div>
      <p className="promptDescription">
        Routing scopes retrieval to one flow&apos;s knowledge and appends that flow&apos;s persona to the base{" "}
        <code>answer-question</code> prompt below.
      </p>
      <div className="personaAssembly">
        <span className="personaAssemblyLabel">How the prompt is assembled</span>
        <pre className="promptInstructions">{ASSEMBLY_EXAMPLE}</pre>
        <p className="promptOutput">
          The persona is appended verbatim by <code>withPersona()</code>, followed by a fixed grounding guard
          (a persona shapes tone and framing only — it never adds facts the context does not contain) — so the
          same base instructions are reused for every flow.
        </p>
      </div>
      <div className="flowPersonaList">
        {flows.map((flow) => (
          <div className="flowPersona" key={flow.id}>
            <div className="promptCardHead">
              <h3>{flow.name}</h3>
              <code>{flow.id}</code>
            </div>
            {flow.persona ? (
              <pre className="promptInstructions">{flow.persona}</pre>
            ) : (
              <p className="promptOutput">No persona — uses the base prompt unchanged.</p>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}
