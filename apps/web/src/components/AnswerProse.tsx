import ReactMarkdown from "react-markdown";

// Answers come back as Markdown (the model reaches for **bold**, bullet lists,
// and the occasional heading). Rendered as raw text those markers just add
// noise, so parse the Markdown and let the browser lay it out. When there is no
// answer yet we render the placeholder as plain text.
export function AnswerProse({ text }: { text: string }) {
  return (
    <div className="answerProse">
      <ReactMarkdown
        // The console never wants the model to inject clickable links or images
        // that navigate away; keep them as their visible text only.
        components={{
          a: ({ children }) => <>{children}</>,
          img: () => null
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
