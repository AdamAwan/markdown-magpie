import styled from "@emotion/styled";

/** Card container: white surface, hairline border, soft radius and a whisper of shadow. */
const SurfaceRoot = styled.section(({ theme }) => ({
  minWidth: 0,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.card,
  background: theme.color.surface,
  boxShadow: theme.shadow.card,
  overflow: "hidden"
}));

const SurfaceHeader = styled.div(({ theme }) => ({
  display: "flex",
  minHeight: "56px",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space.lg,
  borderBottom: `1px solid ${theme.color.border}`,
  padding: `${theme.space.lg} ${theme.space.xl}`
}));

const SurfaceBody = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.lg,
  padding: theme.space.xl
}));

export const Surface = Object.assign(SurfaceRoot, {
  Header: SurfaceHeader,
  Body: SurfaceBody
});
