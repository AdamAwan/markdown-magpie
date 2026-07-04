"use client";

import Link from "next/link";
import styled from "@emotion/styled";
import { Surface, Workbench } from "../components/ui";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

const BackLink = styled(Link)(({ theme }) => ({
  display: "inline-flex",
  alignItems: "center",
  width: "fit-content",
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

export default function NotFound() {
  return (
    <Workbench>
      <Surface>
        <Surface.Header>
          <h2>Page not found</h2>
        </Surface.Header>
        <Surface.Body>
          <p>That console section does not exist.</p>
          <BackLink href={DEFAULT_SECTION_PATH}>Back to Ask</BackLink>
        </Surface.Body>
      </Surface>
    </Workbench>
  );
}
