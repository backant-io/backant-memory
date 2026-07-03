import { existsSync } from "node:fs";
import { plistPath, installService } from "./daemon/launchd.js";

// Never fail `npm install`: only refresh the launchd service when it was already
// installed (upgrade path, spec §8a), and swallow every error to stderr.
if (existsSync(plistPath())) {
  installService({}).then(
    () => process.stderr.write("[backant-memory] service refreshed after upgrade\n"),
    (e) => process.stderr.write(`[backant-memory] service refresh failed: ${e}\n`)
  );
}
