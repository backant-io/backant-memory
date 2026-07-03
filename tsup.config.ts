import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: ["src/cli.ts", "src/hooks/session-start-recall.ts", "src/postinstall.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    mkdirSync("dist/hooks", { recursive: true });
    copyFileSync("src/memory/schema.sql", "dist/schema.sql");
    copyFileSync("src/memory/schema.sql", "dist/hooks/schema.sql");
  },
});
