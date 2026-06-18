import { ConfiguredKnowledgeFlow, PromptSummary } from "../lib/types";

// Mirrors withPersona() in @magpie/prompts: the base instructions, then a fixed
// "Persona" header, then the flow's persona text — sent as the system prompt.
const ASSEMBLY_EXAMPLE = [
  "<base answer prompt>",
  "",
  "Persona (how to look and respond):",
  "<this flow's persona>"
].join("\n");

// Read-only catalog view: renders the exact instruction text and usage of every
// AI prompt served by GET /api/prompts, so the wording sent to the model is
// inspectable from the console without reading the source. Also lists each
// configured flow's persona — the snippet appended to the base answer prompt when
// that flow answers a question (configured in KNOWLEDGE_FLOWS, read-only here).
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

  return (
    <div className="promptList">
      {flows.length > 0 ? (
        <article className="promptCard">
          <div className="promptCardHead">
            <h2>Flow personas</h2>
            <code>KNOWLEDGE_FLOWS</code>
          </div>
          <p className="promptDescription">
            Questions are routed to the best-matching flow; that flow scopes retrieval to its
            knowledge and appends the persona below to the base answer prompt.
          </p>
          <div className="personaAssembly">
            <span className="personaAssemblyLabel">How the prompt is assembled</span>
            <pre className="promptInstructions">{ASSEMBLY_EXAMPLE}</pre>
            <p className="promptOutput">
              The base prompt is <code>answer-question-direct</code> (direct mode) or{" "}
              <code>answer-question-queue</code> (queue mode), shown below. The persona is appended
              verbatim by <code>withPersona()</code> — no other text changes — so the same base
              instructions are reused for every flow.
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
      ) : null}
      {prompts.map((prompt) => (
        <article className="promptCard" key={prompt.id}>
          <div className="promptCardHead">
            <h2>{prompt.title}</h2>
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
      ))}
    </div>
  );
}
