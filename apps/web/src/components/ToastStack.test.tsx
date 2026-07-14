import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkup } from "../test/render";
import { click, renderDom } from "../test/dom";
import { ToastStack } from "./ToastStack";
import type { UiNotification } from "../lib/types";

const at = "2026-07-14T12:00:00.000Z";

function toast(overrides: Partial<UiNotification> & Pick<UiNotification, "id">): UiNotification {
  return { text: "Proposal merged.", tone: "success", at, read: false, ...overrides };
}

test("ToastStack renders nothing when there are no toasts", () => {
  assert.equal(renderMarkup(<ToastStack toasts={[]} onDismiss={() => undefined} />), "");
});

test("ToastStack announces politely and carries tones as data hooks", () => {
  const html = renderMarkup(
    <ToastStack
      toasts={[toast({ id: 1 }), toast({ id: 2, tone: "danger", text: "Draft failed." })]}
      onDismiss={() => undefined}
    />
  );
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-tone="success"/);
  assert.match(html, /data-tone="danger"/);
  assert.match(html, />Draft failed\.</);
});

test("ToastStack dismisses the clicked toast only", async () => {
  const dismissed: number[] = [];
  const { container, unmount } = await renderDom(
    <ToastStack toasts={[toast({ id: 1 }), toast({ id: 2 })]} onDismiss={(id) => dismissed.push(id)} />
  );
  try {
    const buttons = container.querySelectorAll('button[aria-label="Dismiss"]');
    assert.equal(buttons.length, 2);
    await click(buttons[1] as HTMLElement);
    assert.deepEqual(dismissed, [2]);
  } finally {
    unmount();
  }
});
