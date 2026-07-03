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
import { CacheProvider, ThemeProvider } from "@emotion/react";
import { theme } from "./theme";

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
    return (
      <style
        data-emotion={`${cache.key} ${names.join(" ")}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    );
  });

  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </CacheProvider>
  );
}
