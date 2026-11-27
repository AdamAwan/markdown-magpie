import type { ReactElement } from "react";
import { act } from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ThemeProvider } from "@emotion/react";
import { theme } from "../theme/theme";

// Register a happy-dom document once per test process so react-dom/client can
// mount for real: unlike `renderMarkup`, this runs effects, so it's the harness
// for behaviour that only exists across renders (polling, state resets,
// selection persistence). `act` needs the flag to silence its environment guard.
if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Close the happy-dom window, cancelling its outstanding timers. A test file
 * whose components call lib/api must run this from an `after` hook: every
 * request arms happy-dom's `AbortSignal.timeout(30s)`, a ref'd timer that would
 * otherwise hold the test process open for 30 seconds after the last test.
 */
export async function closeDom(): Promise<void> {
  await GlobalRegistrator.unregister();
}

/**
 * Mount a component in the happy-dom document inside the app's ThemeProvider.
 * Returns the container plus `rerender` (same root, new element — how a parent
 * re-render with new props reaches the component) and `unmount`. All three are
 * wrapped in `act`, and the async `act` flushes resolved promises, so effects
 * that await fetch-style callbacks settle before assertions run.
 */
export async function renderDom(ui: ReactElement): Promise<{
  container: HTMLElement;
  rerender: (next: ReactElement) => Promise<void>;
  unmount: () => void;
}> {
  // react-dom/client is imported lazily, never statically: it decides at module
  // load whether a DOM exists (`canUseDOM`) and only then wires up `input`-event
  // handling for text inputs and textareas. A static import is evaluated before
  // the registration above, which made typed edits silently never reach React.
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async (element: ReactElement) => {
    await act(async () => {
      root.render(<ThemeProvider theme={theme}>{element}</ThemeProvider>);
    });
  };

  await render(ui);

  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  };
}

/**
 * Set a controlled input/select/textarea's value the way a user would, so React
 * sees it: through the element's prototype setter (bypassing React's value
 * tracker on the instance) followed by the bubbling `input` (text fields) and
 * `change` (selects) events React listens for.
 */
export async function changeValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
): Promise<void> {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) {
    throw new Error(`No value setter on ${element.tagName}`);
  }
  await act(async () => {
    descriptor.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Every `<button>` under `root` whose trimmed text is exactly `text`. */
export function buttonsByText(root: ParentNode, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((button) => button.textContent?.trim() === text);
}

/** The first `<button>` under `root` labelled `text`; throws (listing what is there) when absent. */
export function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const [button] = buttonsByText(root, text);
  if (!button) {
    const labels = [...root.querySelectorAll("button")].map((candidate) => candidate.textContent?.trim());
    throw new Error(`No button labelled "${text}". Buttons present: ${JSON.stringify(labels)}`);
  }
  return button;
}

/** Click an element inside `act` so resulting state updates and effects flush. */
export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}
