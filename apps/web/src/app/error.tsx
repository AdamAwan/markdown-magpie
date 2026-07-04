"use client";

import { useEffect } from "react";
import Link from "next/link";
import styled from "@emotion/styled";
import { Actions, Button, Surface, Workbench } from "../components/ui";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

const ErrorMessage = styled.p(({ theme }) => ({
  color: theme.color.textMuted,
  fontFamily: theme.font.mono,
  fontSize: theme.font.size.sm
}));

const BackLink = styled(Link)(({ theme }) => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: "36px",
  padding: `8px ${theme.space.lg}`,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surface,
  color: theme.color.text,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.semibold,
  textDecoration: "none",
  "&:hover": { background: theme.color.surfaceMuted }
}));

// App Router error boundary: a render throw in any section is caught here so the
// whole console doesn't go blank. `reset` re-attempts to render the segment.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Something went wrong</h2>
        </Surface.Header>
        <Surface.Body>
          <p>This console section hit an unexpected error and couldn&apos;t render.</p>
          {error.message ? <ErrorMessage>{error.message}</ErrorMessage> : null}
          <Actions>
            <Button variant="primary" onClick={() => reset()}>
              Try again
            </Button>
            <BackLink href={DEFAULT_SECTION_PATH}>Back to Ask</BackLink>
          </Actions>
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
