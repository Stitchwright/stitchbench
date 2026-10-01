// Re-signs the hosted app's Companies-switch rows after a hosting key rotation (modules-design.md section 3.3, "Hosting
// key rotation"). With LICENSE_HOSTED_KEY / LICENSE_HOSTED_KID already pointing at the new key (h2), the newest "on" row
// of every company and module that another kid signed gets a new "on" row signed by h2, with the same last day, grace
// and module, note "re-signed h1→h2" and byEmail "system". Rows the current kid signed, and rows whose last day has
// passed, are left alone, so running it twice changes nothing.
//   railway run npx tsx --conditions=react-server scripts/license/resign-grants.ts [--dry-run]
// (--conditions=react-server makes "server-only" importable outside Next.)
import "dotenv/config";
import { db } from "../../src/lib/db";
import type { LicensePayload } from "../../src/lib/license";
import { hostedSigner, signGrant } from "../../src/lib/license-signing";
import { isModuleId } from "../../src/lib/module-info";
import { todayIn } from "../../src/lib/time-zone";
import { fail, parseArgs } from "./cli";

function decodePayload(key: string): LicensePayload | null {
  try {
    const p = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
    return p && typeof p === "object" && typeof p.k === "string" && typeof p.u === "string" ? (p as LicensePayload) : null;
  } catch {
    return null;
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["dry-run", "help"], ["dry-run", "help"]);
  if (flags.help) return console.log("usage: npx tsx --conditions=react-server scripts/license/resign-grants.ts [--dry-run]");
  const dry = flags["dry-run"] === true;
  const signer = hostedSigner();
  if (!signer || signer.scope !== "hosted") {
    fail("This server holds no hosting key. Set LICENSE_HOSTED_KEY and LICENSE_HOSTED_KID to the new key first (the log says when they don't match src/lib/license-keys.ts).");
  }
  const shops = await db.shop.findMany({ select: { id: true, name: true, timeZone: true } });
  const grants = await db.moduleGrant.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, shopId: true, module: true, mode: true, key: true, createdAt: true } });
  const seen = new Set<string>();
  let resigned = 0;
  let same = 0;
  let ended = 0;
  for (const g of grants) {
    // The first row for a company and module is its newest: the only one the switch reads (adminPosition in license.ts).
    const pair = `${g.shopId}\n${g.module}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    if (g.mode !== "on" || !g.key) continue;
    const shop = shops.find((s) => s.id === g.shopId);
    if (!shop) continue;
    if (!isModuleId(g.module)) {
      console.warn(`${shop.name} ${g.module}: this version doesn't know that module; left alone.`);
      continue;
    }
    const p = decodePayload(g.key);
    if (!p) {
      console.warn(`${shop.name} ${g.module}: row ${g.id} holds no readable key; left alone.`);
      continue;
    }
    if (p.k === signer.kid) {
      same++;
      continue;
    }
    if (p.u < todayIn(shop.timeZone)) {
      ended++;
      continue;
    }
    console.log(`${dry ? "would re-sign" : "re-signing"} ${shop.name} (${shop.id}) ${g.module}: ${p.k} → ${signer.kid}, last day ${p.u}, grace ${p.g}`);
    if (!dry) {
      const key = signGrant({ shopId: shop.id, shopName: shop.name, module: g.module, lastDay: p.u, graceDays: p.g, timeZone: shop.timeZone, signer });
      await db.moduleGrant.create({ data: { shopId: shop.id, module: g.module, mode: "on", key, byEmail: "system", note: `re-signed ${p.k}→${signer.kid}` } });
    }
    resigned++;
  }
  console.log(`${dry ? "Would re-sign" : "Re-signed"} ${resigned} row(s) with ${signer.kid}; ${same} already signed with it; ${ended} ended and left alone.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await db.$disconnect().catch(() => undefined);
    process.exit(1);
  });
