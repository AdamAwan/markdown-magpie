// Teach Emotion about our theme shape so `p => p.theme.color.text` is typed everywhere
// styled/css is used. Without this, `props.theme` is an empty object type.
import "@emotion/react";
import type { AppTheme } from "./theme";

declare module "@emotion/react" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Theme extends AppTheme {}
}
