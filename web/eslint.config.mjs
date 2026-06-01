import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "public/circuits/**",
    "src/**/__tests__/**",
    "src/**/*.test.*",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // React Compiler's lint currently flags common mount/hydration effects
      // used by Next client components. Keep the actionable hook rules on.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
