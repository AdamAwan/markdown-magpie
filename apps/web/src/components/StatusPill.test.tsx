import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderMarkup } from "../test/render";
import { click, renderDom } from "../test/dom";
import { StatusPill } from "./StatusPill";
import type { ConsoleNotice, UiNotification } from "../lib/types";

const at = "2026-07-14T12:00:00.000Z";

function notice(overrides: Partial<ConsoleNotice> & Pick<ConsoleNotice, "id">): ConsoleNotice {
  return { title: "Something is up", body: "Details here.", tone: "warning", ...overrides };
}

function notification(overrides: Partial<UiNotification> & Pick<UiNotification, "id">): UiNotification {
  return { text: "Proposal merged.", tone: "success", at, read: false, ...overrides };
}

const noop = () => undefined;
const handlers = { onOpen: noop, onDismissNotification: noop, onClearNotifications: noop };

test("StatusPill shows a neutral placeholder until the first refresh lands", () => {
  const html = renderMarkup(<StatusPill loaded={false} notices={[]} notifications={[]} {...handlers} />);
  assert.match(html, /Checking status/);
  assert.match(html, /data-tone="neutral"/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("StatusPill reads all clear when nothing is outstanding", () => {
  const html = renderMarkup(<StatusPill loaded notices={[]} notifications={[]} {...handlers} />);
  assert.match(html, /All clear/);
  assert.match(html, /data-tone="neutral"/);
});

test("StatusPill summarises severity and counts without opening", () => {
  const html = renderMarkup(
    <StatusPill
      loaded
      notices={[notice({ id: "a", tone: "danger" }), notice({ id: "b" })]}
      notifications={[notification({ id: 1 })]}
      {...handlers}
    />
  );
  assert.match(html, /2 issues · 1 new/);
  assert.match(html, /data-tone="danger"/);
  // Collapsed: the popover (and its content) is not in the document at all.
  assert.doesNotMatch(html, /Needs attention/);
});

test("StatusPill opens to both groups, marks read, and wires the notice action", async () => {
  let opened = 0;
  let actioned = 0;
  const { container, unmount } = await renderDom(
    <StatusPill
      loaded
      notices={[notice({ id: "failed-jobs", title: "2 AI jobs failed", tone: "danger", actionLabel: "Open Jobs", action: () => (actioned += 1) })]}
      notifications={[notification({ id: 1, text: "Draft Proposal completed." })]}
      onOpen={() => (opened += 1)}
      onDismissNotification={noop}
      onClearNotifications={noop}
    />
  );
  try {
    await click(container.querySelector("button[aria-haspopup]") as HTMLElement);

    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog, "popover opens");
    assert.equal(opened, 1, "opening marks notifications read via onOpen");
    assert.match(dialog!.textContent ?? "", /2 AI jobs failed/);
    assert.match(dialog!.textContent ?? "", /Draft Proposal completed\./);

    const chip = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Open Jobs");
    assert.ok(chip, "notice action chip renders");
    await click(chip!);
    assert.equal(actioned, 1);
  } finally {
    unmount();
  }
});

test("StatusPill dismisses and clears notifications, and closes on Escape", async () => {
  const dismissed: number[] = [];
  let cleared = 0;
  const { container, unmount } = await renderDom(
    <StatusPill
      loaded
      notices={[]}
      notifications={[notification({ id: 7, read: true })]}
      onOpen={noop}
      onDismissNotification={(id) => dismissed.push(id)}
      onClearNotifications={() => (cleared += 1)}
    />
  );
  try {
    await click(container.querySelector("button[aria-haspopup]") as HTMLElement);
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog!.textContent ?? "", /Nothing needs attention\./);

    await click(dialog!.querySelector('button[aria-label="Dismiss notification"]') as HTMLElement);
    assert.deepEqual(dismissed, [7]);

    const clear = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Clear");
    assert.ok(clear, "clear button renders while notifications exist");
    await click(clear!);
    assert.equal(cleared, 1);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    assert.equal(container.querySelector('[role="dialog"]'), null, "Escape closes the popover");
  } finally {
    unmount();
  }
});

test("StatusPill highlights unread rows as a data hook", async () => {
  const { container, unmount } = await renderDom(
    <StatusPill
      loaded
      notices={[]}
      notifications={[notification({ id: 1, read: false }), notification({ id: 2, read: true })]}
      onOpen={noop}
      onDismissNotification={noop}
      onClearNotifications={noop}
    />
  );
  try {
    await click(container.querySelector("button[aria-haspopup]") as HTMLElement);
    const rows = [...container.querySelectorAll("[data-unread]")];
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-unread")),
      ["true", "false"]
    );
  } finally {
    unmount();
  }
});
