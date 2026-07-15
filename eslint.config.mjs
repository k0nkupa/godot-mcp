import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".worktrees/**",
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
);
