// Another process (hook, session, service) holding the write lock for a while:
// node lock-holder.mjs <db> <holdMs>. Prints LOCKED once it holds the lock.
import { createClient } from "@libsql/client";

const [db, ms] = [process.argv[2], Number(process.argv[3] ?? 1000)];
const c = createClient({ url: `file:${db}` });
await c.execute("PRAGMA busy_timeout=10000");
await c.execute("BEGIN IMMEDIATE");
await c.execute({
  sql: "INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp) VALUES ('holder','write','{}','{}',?)",
  args: [new Date().toISOString()],
});
process.stdout.write("LOCKED\n");
await new Promise((r) => setTimeout(r, ms));
await c.execute("COMMIT");
c.close();
