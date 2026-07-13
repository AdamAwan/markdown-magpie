import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
 * Set a controlled input/select's value the way a user would, so React sees it:
 * through the element's prototype setter (bypassing React's value tracker on
 * the instance) followed by a bubbling change event.
 */
export async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.set) {
    throw new Error(`No value setter on ${element.tagName}`);
  }
  await act(async () => {
    descriptor.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Click an element inside `act` so resulting state updates and effects flush. */
export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}
