import { PromptSummary } from "../lib/types";

// Read-only catalog view: renders the exact instruction text and usage of every
// AI prompt served by GET /api/prompts, so the wording sent to the model is
// inspectable from the console without reading the source.
export function PromptsPanel({ prompts }: { prompts: PromptSummary[] }) {
  if (prompts.length === 0) {
    return <p className="promptEmpty">No prompts are registered.</p>;
  }

  return (
    <div className="promptList">
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
