"use client";

// Emotion + App Router SSR glue. Next streams the RSC payload, so Emotion's client cache
// would otherwise miss styles inserted during server render (flash of unstyled content /
// hydration mismatch). We create one cache, track the style names it inserts, and flush
// them into <style> tags via useServerInsertedHTML — the documented App Router pattern.
// This component also provides the ThemeProvider so every styled/css consumer sees the
// theme in ./theme.

import { useState, type ReactNode } from "react";
import { useServerInsertedHTML } from "next/navigation";
import createCache from "@emotion/cache";
import { CacheProvider, Global, ThemeProvider, css } from "@emotion/react";
import { theme } from "./theme";

// The base reset + element typography that used to live at the top of the (now deleted)
// styles.css. Everything component-scoped is authored with styled/tokens; this is only the
// document-level baseline plus the one React Flow tweak (its component CSS is imported by
// DataFlowPanel from @xyflow/react/dist/style.css).
const globalStyles = css`
  :root {
    color-scheme: light;
    font-family: ${theme.font.sans};
    color: ${theme.color.text};
    background: ${theme.color.page};
  }
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  a {
    color: inherit;
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  h1 {
    font-size: ${theme.font.size.title};
    line-height: 1.1;
  }
  h2 {
    font-size: ${theme.font.size.xl};
    line-height: 1.2;
  }
  h3 {
    font-size: ${theme.font.size.base};
    line-height: 1.35;
  }
  p {
    color: ${theme.color.textMuted};
    font-size: ${theme.font.size.base};
    line-height: 1.5;
  }
  code {
    color: ${theme.color.textMuted};
    font-family: ${theme.font.mono};
    font-size: ${theme.font.size.xs};
  }
  pre {
    margin: 0;
    font-family: ${theme.font.mono};
    white-space: pre-wrap;
  }
  .react-flow__attribution {
    background: transparent;
    font-size: 10px;
  }
`;

export function EmotionRegistry({ children }: { children: ReactNode }) {
  const [{ cache, flush }] = useState(() => {
    const cache = createCache({ key: "mag" });
    cache.compat = true;

    const prevInsert = cache.insert;
    let inserted: string[] = [];
    cache.insert = (...args) => {
      const serialized = args[1];
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name);
      }
      return prevInsert(...args);
    };
    const flush = () => {
      const flushed = inserted;
      inserted = [];
      return flushed;
    };
    return { cache, flush };
  });

  useServerInsertedHTML(() => {
    const names = flush();
    if (names.length === 0) {
      return null;
    }
    let styles = "";
    for (const name of names) {
      const rules = cache.inserted[name];
      if (typeof rules === "string") {
        styles += rules;
      }
    }
    return <style data-emotion={`${cache.key} ${names.join(" ")}`} dangerouslySetInnerHTML={{ __html: styles }} />;
  });

  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <Global styles={globalStyles} />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
