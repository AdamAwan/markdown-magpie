import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../test/render";
import { AnswerProse } from "./AnswerProse";

test("renders Markdown emphasis and lists as real elements, not raw markers", () => {
  const markup = renderMarkup(
    <AnswerProse
      text={
        "**Highlight these key points:**\n\n* **Your data stays on your infrastructure.** Runs locally.\n* **Encryption end to end.**"
      }
    />
  );

  // The bold markers become <strong>, not literal asterisks.
  assert.match(markup, /<strong>Your data stays on your infrastructure\.<\/strong>/);
  assert.match(markup, /<strong>Encryption end to end\.<\/strong>/);
  // The bullet list becomes a real <ul>/<li> structure.
  assert.match(markup, /<ul>/);
  assert.match(markup, /<li>/);
  // No raw Markdown markers leak into the rendered output.
  assert.doesNotMatch(markup, /\*\*/);
});

test("wraps output in a prose scope so styles can target it", () => {
  const markup = renderMarkup(<AnswerProse text="Plain answer." />);
  // The prose wrapper renders as a div carrying an Emotion-generated class, and
  // the paragraph survives inside it.
  assert.match(markup, /<div class="css-[^"]*"><p>Plain answer\.<\/p><\/div>/);
});

test("renders link text without an active anchor and drops images", () => {
  const markup = renderMarkup(
    <AnswerProse text={"See [the docs](https://example.com) and ![logo](https://example.com/logo.png)."} />
  );

  // Link text survives but no navigable anchor is emitted.
  assert.match(markup, /the docs/);
  assert.doesNotMatch(markup, /<a\b/);
  // Images are dropped entirely.
  assert.doesNotMatch(markup, /<img\b/);
});
