import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow unused args/locals prefixed with _ (common for required
      // signatures where we don't care about a param).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The SDK and Sabha API shapes cross a lot of boundaries; narrow casts
      // are fine, but `any` should still be a deliberate choice.
      "@typescript-eslint/no-explicit-any": "warn",
      // We use empty catch blocks in a few places to swallow cleanup errors
      // (e.g. ws.close() during shutdown). Allow them when the binding is
      // omitted entirely.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      // Tests legitimately access private fields and construct partial
      // shapes; don't noise them up.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
