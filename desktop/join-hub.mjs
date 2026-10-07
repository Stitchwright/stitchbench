// Join the program's StitchBench to a community hub from the command line (same as Settings → StitchHub → Join).
// usage: node join-hub.mjs <hub url> <join key>        (the program picks it up at its next sync, within 10 minutes)
// SB_FLAVOR=stitchshop for StitchShop. Settings → StitchHub is the better way: it also upgrades a partner-only
// install on the same hub without breaking its partnerships, which this script refuses to touch.
import pg from "pg";
import { programConfig } from "./cli-config.mjs";

/** The same rule as Settings → StitchHub (checkHubUrl in src/lib/hub.ts, which a script can't import): https, or http only for this computer. */
function checkHubUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("The hub address starts with https://");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("The hub address starts with https://");
  if (u.username || u.password || u.search || u.hash) throw new Error("That hub address doesn't look right.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

const [url, joinKey] = process.argv.slice(2);
if (!url || !joinKey) throw new Error("usage: node join-hub.mjs <hub url> <join key>");
// Before anything is sent: the join key, and after it the install key and every partner message, go to this address.
const base = checkHubUrl(url.trim());
const cfg = programConfig();
const db = new pg.Client({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench" });
await db.connect();
try {
  const cur = (await db.query(`SELECT url, "installKey" FROM "HubState" WHERE id = 1`)).rows[0];
  const active = Number((await db.query(`SELECT count(*) AS n FROM "PartnerLink" WHERE status = 'ACTIVE'`)).rows[0].n);
  // Partner links live on the current hub, under this install's id: a new registration would cut them off.
  if (cur?.installKey && active) {
    throw new Error(`This install has ${active} active partner shop(s) on ${cur.url}. Join from Settings → StitchHub, or end those partnerships first.`);
  }
  const shop = (await db.query(`SELECT name, email FROM "Shop" ORDER BY "createdAt" LIMIT 1`)).rows[0];
  const r = await fetch(`${base}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinKey, name: shop.name, contact: shop.email }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `hub answered ${r.status}`);
  // A new registration numbers changes, orders and partner messages afresh: every cursor starts over.
  await db.query(
    `INSERT INTO "HubState" (id, url, "hubName", "installId", "installKey", "joinedAt", cursor, "orderCursor", "partnerCursor", scope, "lastError")
     VALUES (1, $1, $2, $3, $4, now(), '0', NULL, NULL, 'member', NULL)
     ON CONFLICT (id) DO UPDATE SET url = $1, "hubName" = $2, "installId" = $3, "installKey" = $4, "joinedAt" = now(), cursor = '0',
       "orderCursor" = NULL, "partnerCursor" = NULL, scope = 'member', "lastError" = NULL`,
    [base, j.hubName, j.installId, j.installKey],
  );
  console.log(`joined ${j.hubName} as "${shop.name}"`);
} finally {
  await db.end();
}
