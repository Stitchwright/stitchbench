// Upload this StitchBench's manual figure snapshots to the community hub (skips ones the hub already has).
// usage: node push-figures.mjs      (the program must have joined a hub)
import pg from "pg";
import { programConfig } from "./cli-config.mjs";

const cfg = programConfig();
const db = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench", max: 3 });
const hub = (await db.query(`SELECT url, "installKey" FROM "HubState" WHERE id = 1`)).rows[0];
if (!hub?.url || !hub.installKey) throw new Error("Join a hub first.");

let after = "";
let sent = 0;
let failed = 0;
for (;;) {
  const { rows } = await db.query(
    `SELECT f.id, f.mime, f.data, f.width, f.height FROM "FigureImage" f
     WHERE f.id > $1 AND NOT EXISTS (SELECT 1 FROM "HubFigure" h WHERE h.id = f.id) ORDER BY f.id LIMIT 40`,
    [after],
  );
  if (!rows.length) break;
  after = rows[rows.length - 1].id;
  // four at a time
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(
      rows.slice(i, i + 4).map(async (f) => {
        try {
          const r = await fetch(`${hub.url}/v1/figures/${f.id}?w=${f.width ?? ""}&h=${f.height ?? ""}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${hub.installKey}`, "Content-Type": f.mime },
            body: f.data,
            signal: AbortSignal.timeout(60_000),
          });
          if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
          await db.query(`INSERT INTO "HubFigure" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [f.id]);
          sent++;
        } catch (e) {
          failed++;
          if (failed < 5) console.error(`figure ${f.id}: ${e.message}`);
        }
      }),
    );
  }
  if (sent % 400 < 40) console.log(`${sent} sent, ${failed} failed`);
}
console.log(`done: ${sent} sent, ${failed} failed`);
await db.end();
