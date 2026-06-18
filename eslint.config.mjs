import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.next-*/**",
      "**/node_modules/**",
      // Runtime data: knowledge-base source repos the app clones at runtime.
      ".magpie/**",
      "apps/web/next-env.d.ts",
      "scripts/**",
      "**/*.config.mjs",
      "eslint.config.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // The mock/test fakes and a few provider shims legitimately need `any`; keep
      // it visible as a warning rather than failing the build.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow intentionally-unused args prefixed with _ (e.g. discarded callback params).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
