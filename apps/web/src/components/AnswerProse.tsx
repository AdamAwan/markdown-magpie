import ReactMarkdown from "react-markdown";
import styled from "@emotion/styled";

// Prose scope for rendered Markdown answers: ported from the old global
// `.answerProse` rules so the generated headings, lists, code, and quotes stay
// tight and readable within the console's cards.
const Prose = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  minWidth: 0,
  "& > :first-of-type": { marginTop: 0 },
  "& > :last-child": { marginBottom: 0 },
  "& p": { margin: 0, lineHeight: 1.5 },
  "& ul, & ol": {
    margin: 0,
    paddingLeft: "20px",
    display: "grid",
    gap: theme.space.xs
  },
  "& li": { lineHeight: 1.45 },
  "& h1, & h2, & h3, & h4, & h5, & h6": {
    margin: `${theme.space.xs} 0 0`,
    fontSize: theme.font.size.base,
    fontWeight: theme.font.weight.semibold,
    lineHeight: 1.35
  },
  "& strong": { fontWeight: theme.font.weight.semibold },
  "& code": {
    background: theme.color.surfaceMuted,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.sm,
    padding: "1px 4px",
    fontFamily: theme.font.mono,
    fontSize: "0.9em"
  },
  "& pre": {
    margin: 0,
    padding: `${theme.space.md} ${theme.space.lg}`,
    background: theme.color.surfaceMuted,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    overflowX: "auto"
  },
  "& pre code": { background: "none", border: "none", padding: 0 },
  "& blockquote": {
    margin: 0,
    paddingLeft: theme.space.lg,
    borderLeft: `3px solid ${theme.color.borderStrong}`,
    color: theme.color.textMuted
  }
}));

// Answers come back as Markdown (the model reaches for **bold**, bullet lists,
// and the occasional heading). Rendered as raw text those markers just add
// noise, so parse the Markdown and let the browser lay it out. When there is no
// answer yet we render the placeholder as plain text.
export function AnswerProse({ text }: { text: string }) {
  return (
    <Prose>
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
    </Prose>
  );
}
