// Design tokens for the web console. Values are the "Refined sage" refresh of the
// original palette that used to live hardcoded across src/app/styles.css. This is the
// single source of truth for colour, spacing, radius, typography and elevation; consume it
// through Emotion's themed `styled`/`css` (the theme is augmented in ./emotion.d.ts so
// `p => p.theme.color.text` is fully typed).

interface StatusColors {
  fg: string;
  bg: string;
  border: string;
  dot: string;
}

export type StatusTone = "completed" | "failed" | "running" | "pending" | "neutral";

export interface AppTheme {
  color: {
    text: string;
    textMuted: string;
    textSubtle: string;
    page: string;
    surface: string;
    surfaceMuted: string;
    border: string;
    borderStrong: string;
    accent: string;
    accentBg: string;
    accentBorder: string;
    brandAccent: string;
    primary: string;
    primaryHover: string;
    primaryText: string;
    danger: string;
    dangerText: string;
    dangerBg: string;
    dangerBorder: string;
    status: Record<StatusTone, StatusColors>;
  };
  space: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    xxl: string;
  };
  radius: {
    sm: string;
    md: string;
    card: string;
  };
  font: {
    sans: string;
    mono: string;
    size: {
      xs: string;
      sm: string;
      md: string;
      base: string;
      lg: string;
      xl: string;
      xxl: string;
      title: string;
    };
    weight: {
      regular: number;
      medium: number;
      semibold: number;
      bold: number;
    };
  };
  shadow: {
    card: string;
  };
}

export const theme: AppTheme = {
  color: {
    text: "#17211d",
    textMuted: "#5b6962",
    textSubtle: "#8a948f",
    page: "#f5f7f2",
    surface: "#ffffff",
    surfaceMuted: "#f6f8f3",
    border: "#e4e8e0",
    borderStrong: "#cbd3cb",
    accent: "#285f74",
    accentBg: "#e5f1f4",
    accentBorder: "#b7d0d8",
    brandAccent: "#62702f",
    primary: "#20322b",
    primaryHover: "#2a4137",
    primaryText: "#ffffff",
    danger: "#b3261e",
    dangerText: "#9a3a2d",
    dangerBg: "#fdf2ee",
    dangerBorder: "#e0b3a4",
    status: {
      completed: { fg: "#3d6b43", bg: "#eef6ec", border: "#bcd6bd", dot: "#3d6b43" },
      failed: { fg: "#9a3a2d", bg: "#fdf2ee", border: "#e0b3a4", dot: "#9a3a2d" },
      running: { fg: "#7a5d24", bg: "#faf5e9", border: "#d8c496", dot: "#a9812f" },
      pending: { fg: "#2d5775", bg: "#f2f7fb", border: "#c4d3e0", dot: "#2d5775" },
      neutral: { fg: "#5b6962", bg: "#f6f8f3", border: "#e0e5db", dot: "#8a948f" }
    }
  },
  space: {
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "12px",
    xl: "16px",
    xxl: "24px"
  },
  radius: {
    sm: "6px",
    md: "8px",
    card: "12px"
  },
  font: {
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    size: {
      xs: "11px",
      sm: "12px",
      md: "13px",
      base: "14px",
      lg: "16px",
      xl: "17px",
      xxl: "21px",
      title: "28px"
    },
    weight: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700
    }
  },
  shadow: {
    card: "0 1px 2px rgba(23, 33, 29, 0.05)"
  }
};
