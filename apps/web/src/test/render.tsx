import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@emotion/react";
import { theme } from "../theme/theme";

/**
 * Render a component to static HTML inside the app's ThemeProvider. Themed styled/css
 * consumers read the theme from context, so tests must provide it (without a provider
 * `props.theme` is `{}` and token access throws). Use in place of a bare
 * `renderToStaticMarkup` for any component that uses `components/ui`.
 */
export function renderMarkup(ui: ReactElement): string {
  return renderToStaticMarkup(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}
