import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../../test/render";
import { Badge, statusTone } from "./Badge";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { IconButton } from "./IconButton";

test("Button defaults to type=button and forwards disabled", () => {
  const html = renderMarkup(<Button disabled>Save</Button>);
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /disabled/);
  assert.match(html, />Save</);
});

test("IconButton exposes its label as accessible name", () => {
  const html = renderMarkup(
    <IconButton label="Close details">
      <span>x</span>
    </IconButton>
  );
  assert.match(html, /aria-label="Close details"/);
  assert.match(html, /title="Close details"/);
});

test("Badge carries its tone as a data hook and renders a dot when asked", () => {
  const plain = renderMarkup(<Badge tone="completed">Completed</Badge>);
  assert.match(plain, /data-tone="completed"/);
  assert.match(plain, />Completed</);

  const dotted = renderMarkup(
    <Badge tone="failed" dot>
      Failed
    </Badge>
  );
  assert.match(dotted, /data-tone="failed"/);
  assert.match(dotted, /aria-hidden/);
});

test("Chip reflects selected state via aria-pressed", () => {
  const on = renderMarkup(<Chip selected>Ready</Chip>);
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /data-selected="true"/);

  const off = renderMarkup(<Chip>Ready</Chip>);
  assert.match(off, /aria-pressed="false"/);
});

test("statusTone maps backend status strings onto the four semantic tones", () => {
  assert.equal(statusTone("completed"), "completed");
  assert.equal(statusTone("merged"), "completed");
  assert.equal(statusTone("succeeded"), "completed");
  assert.equal(statusTone("failed"), "failed");
  assert.equal(statusTone("rejected"), "failed");
  assert.equal(statusTone("running"), "running");
  assert.equal(statusTone("pending"), "pending");
  assert.equal(statusTone("claimed"), "pending");
  assert.equal(statusTone("PENDING"), "pending", "is case-insensitive");
  assert.equal(statusTone("something-else"), "neutral");
  assert.equal(statusTone(undefined), "neutral");
  assert.equal(statusTone(null), "neutral");
});
