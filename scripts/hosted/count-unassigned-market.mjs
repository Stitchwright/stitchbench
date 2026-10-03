// Round-3 L6 (batch E): how many marketplace listings and orders on a hosted database belong to no company.
// Read-only. The owner runs it through Railway so the database address never leaves the shell:
//   railway run -p <project id> -e production -s Postgres -- node scripts/hosted/count-unassigned-market.mjs
// It prints counts only. If both are 0 on both hosted databases, L6 is closed as moot.
import pg from "pg";

const url = process.env.DATABASE_PUBLIC_URL;
if (!url) {
  console.log("No DATABASE_PUBLIC_URL: run this through `railway run ... -s Postgres`.");
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
