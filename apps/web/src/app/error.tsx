"use client";

import { useEffect } from "react";
import Link from "next/link";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

// App Router error boundary: a render throw in any section is caught here so the
// whole console doesn't go blank. `reset` re-attempts to render the segment.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="workbench singlePane">
      <div className="surface">
        <div className="surfaceHeader">
          <h2>Something went wrong</h2>
        </div>
        <div className="surfaceBody">
          <p>This console section hit an unexpected error and couldn&apos;t render.</p>
          {error.message ? <p className="path">{error.message}</p> : null}
          <div className="rowActions">
            <button className="button" onClick={() => reset()} type="button">
              Try again
            </button>
            <Link className="button secondary" href={DEFAULT_SECTION_PATH}>
              Back to Ask
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
