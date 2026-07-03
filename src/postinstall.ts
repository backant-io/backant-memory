import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plistPath, installService } from "./daemon/launchd.js";

// This entry is bundled to dist/postinstall.js, so bundleDir === <pkgroot>/dist
// and the plist must point at dist/cli.js — NOT argv[1], which here would be
// postinstall.js itself and would put launchd in a crash loop after upgrade.
const bundleDir = dirname(fileURLToPath(import.meta.url));

// Never fail `npm install`: only refresh the launchd service when it was already
// installed (upgrade path, spec §8a), and swallow every error to stderr.
try {
  if (existsSync(plistPath())) {
    installService({ cliPath: join(bundleDir, "cli.js") }).then(
      () => process.stderr.write("[backant-memory] service refreshed after upgrade\n"),
      (e) => process.stderr.write(`[backant-memory] service refresh failed: ${e}\n`)
    );
  }
} catch (e) {
  process.stderr.write(`[backant-memory] postinstall skipped: ${e}\n`);
}
