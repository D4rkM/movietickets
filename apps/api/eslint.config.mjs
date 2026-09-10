import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "drizzle", "coverage"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
