// Round-3 L6 (batch E): how many marketplace listings and orders on a hosted database belong to no company.
// Read-only. The hosted databases have no public address, so it runs inside each app's container (after a deploy
// that carries this file), where the app's own DATABASE_URL reaches the database; nothing leaves Railway but counts:
//   railway ssh -p <project id> -e production -s <app service> -- node scripts/hosted/count-unassigned-market.mjs
// (On a database with a public address, `railway run ... -s Postgres -- node ...` works too.)
// It prints counts only. If both are 0 on both hosted databases, L6 is closed as moot.
import pg from "pg";

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("No database address: run this inside the app's container with `railway ssh` (see the top of this file).");
  process.exit(1);
}
const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
try {
  await c.connect();
  await c.query("SET TRANSACTION READ ONLY").catch(() => {});
  const companies = await c.query('SELECT count(*)::int AS n FROM "Shop"');
  console.log(`companies: ${companies.rows[0].n}`);
  for (const t of ["Listing", "MarketOrder"]) {
    const r = await c.query(`SELECT count(*) FILTER (WHERE "shopId" IS NULL)::int AS none, count(*)::int AS total FROM "${t}"`);
    console.log(`${t}: ${r.rows[0].none} with no company, of ${r.rows[0].total}`);
  }
} catch (e) {
  console.log(`Couldn't count: ${e.code || ""} ${String(e.message).split("://")[0]}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
