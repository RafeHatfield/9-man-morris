import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// `eslint-config-next` already ignores .next/, out/, build/ and next-env.d.ts;
// re-declaring them here would be a second copy of a list we do not own.
const eslintConfig = defineConfig([...nextVitals, ...nextTs]);

export default eslintConfig;
