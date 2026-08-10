import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  plistPath,
  installService,
  isGlobalNpmInstall,
  parsePlistProgramPath,
  shouldRewritePlist,
} from "./daemon/launchd.js";

// This entry is bundled to dist/postinstall.js, so bundleDir === <pkgroot>/dist
// and the plist must point at dist/cli.js — NOT argv[1], which here would be
// postinstall.js itself and would put launchd in a crash loop after upgrade.
const bundleDir = dirname(fileURLToPath(import.meta.url));

// Never fail `npm install`: only refresh the launchd service when it was already
// installed (upgrade path, spec §8a) AND this install owns it (issue #3), and
// swallow every error to stderr.
try {
  const plist = plistPath();
  const existing = existsSync(plist) ? readFileSync(plist, "utf8") : undefined;
  const rewrite = shouldRewritePlist({
    plistExists: existing !== undefined,
    isGlobalInstall: isGlobalNpmInstall(process.env),
    plistProgramPath: existing === undefined ? undefined : parsePlistProgramPath(existing),
    installPrefix: dirname(bundleDir),
  });
  if (rewrite) {
    installService({ cliPath: join(bundleDir, "cli.js") }).then(
      () => process.stderr.write("[backant-memory] service refreshed after upgrade\n"),
      (e) => process.stderr.write(`[backant-memory] service refresh failed: ${e}\n`)
    );
  } else if (existing !== undefined) {
    // Covers every skip reason: a dependency install, a copy nested inside
    // another package's global install, and a plist we cannot read.
    process.stderr.write(
      "[backant-memory] existing launchd service left untouched (this install does not own it)\n"
    );
  }
} catch (e) {
  process.stderr.write(`[backant-memory] postinstall skipped: ${e}\n`);
}
