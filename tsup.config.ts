import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/hooks/session-start-recall.ts",
    "src/postinstall.ts",
    // Library surface consumed by backant-kairos (package.json "exports").
    "src/index.ts",
    "src/tools/index.ts",
    "src/docker/index.ts",
    "src/ollama/index.ts",
  ],
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: false,
  // Consumers typecheck against these; the server-only build never emitted any.
  dts: true,
  // Unchanged. Node strips a leading hash-bang from any ESM module it loads, so
  // the banner on the library bundles is inert — leaving it alone keeps this
  // change surgical and the executables' shebang exactly as it is today.
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    // migrations/ is read via `import.meta.url` from src/memory/migrations.ts.
    // With splitting:false each entry inlines that module, so import.meta.url
    // resolves to whichever bundle the call landed in — copy the directory
    // adjacent to every entry that can open a store.
    for (const dir of ["dist", "dist/hooks", "dist/tools"]) {
      mkdirSync(dir, { recursive: true });
      cpSync("src/memory/migrations", `${dir}/migrations`, { recursive: true });
    }
  },
});
