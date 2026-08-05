import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";

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
    // migrations/ is read via `import.meta.url` from src/memory/migrations.ts.
    // With splitting:false each entry inlines that module, so import.meta.url
    // resolves to whichever bundle the call landed in — copy the directory
    // adjacent to every entry that can open a store.
    for (const dir of ["dist", "dist/hooks"]) {
      mkdirSync(dir, { recursive: true });
      cpSync("src/memory/migrations", `${dir}/migrations`, { recursive: true });
    }
  },
});
