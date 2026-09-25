// Join the program's StitchBench to a community hub from the command line (same as Settings → Community hub → Join).
// usage: node join-hub.mjs <hub url> <join key>        (the program picks it up at its next sync, within 10 minutes)
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const [url, joinKey] = process.argv.slice(2);
if (!url || !joinKey) throw new Error("usage: node join-hub.mjs <hub url> <join key>");
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "StitchBench", "config.json"), "utf8"));
const db = new pg.Client({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });
await db.connect();
const shop = (await db.query(`SELECT name, email FROM "Shop" ORDER BY "createdAt" LIMIT 1`)).rows[0];
const base = url.replace(/\/+$/, "");
const r = await fetch(`${base}/v1/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ joinKey, name: shop.name, contact: shop.email }),
});
const j = await r.json();
if (!r.ok) throw new Error(j.error ?? `hub answered ${r.status}`);
await db.query(
  `INSERT INTO "HubState" (id, url, "hubName", "installId", "installKey", "joinedAt", cursor, "lastError")
   VALUES (1, $1, $2, $3, $4, now(), '0', NULL)
   ON CONFLICT (id) DO UPDATE SET url = $1, "hubName" = $2, "installId" = $3, "installKey" = $4, "joinedAt" = now(), cursor = '0', "lastError" = NULL`,
  [base, j.hubName, j.installId, j.installKey],
);
await db.end();
console.log(`joined ${j.hubName} as "${shop.name}"`);
