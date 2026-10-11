// Seed: the reference tension specs (all shops) plus, on an empty database,
// the first shop, its owner account and a starter service menu.
// Run: npm run db:seed   (safe to re-run; specs are upserted by id). Deploys run it with --if-empty, which reloads a
// reference set only when its file changed.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU, starterKindFor } from "../src/lib/service-menu";

/**
 * The reference sets that ship with StitchBench. Loaded the same way as the Windows program's desktop/reference.mjs:
 * the whole set in one transaction (rows no longer shipped removed, the rest inserted or updated), and a hash of the
 * file recorded as the table's comment (seed:<hash>). Deploys (--if-empty) skip a set whose comment matches, so a
 * release with corrected or added specs reaches hosted installs, and a first load cut off halfway is finished. A set
 * whose file isn't here is left as it is, never emptied: the manufacturers' sets aren't in the public code (an official
 * build fetches them, scripts/data/fetch-reference-data.mjs), and a copy built without them keeps what it loaded before.
 */
const SETS = [
  { name: "Tension specs", table: "TensionSpec", file: "tension_specs.json" },
  { name: "Factory settings", table: "FactorySetting", file: "factory_settings.json" },
  { name: "Test modes", table: "ServiceMode", file: "service_modes.json" },
  { name: "Library documents", table: "LibraryDoc", file: "library_docs.json" },
] as const;

async function loadSet(s: (typeof SETS)[number], force: boolean) {
  let text: string;
  try {
    text = readFileSync(join(__dirname, "seed-data", s.file), "utf8");
  } catch {
    console.log(`${s.name}: no ${s.file} in this build; skipping (the table is left as it is).`);
    return;
  }
  const mark = `seed:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  const t = `"${s.table}"`;
  if (!force) {
    const [row] = await db.$queryRawUnsafe<{ c: string | null }[]>(`SELECT obj_description('${t}'::regclass, 'pg_class') AS c`);
    if (row?.c === mark) {
      console.log(`${s.name}: already loaded`);
      return;
    }
  }
  const data = JSON.parse(text) as Record<string, unknown>[];
  if (!Array.isArray(data) || !data.length) return;
  const cols = (
    await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${s.table}`
  )
    .map((r) => r.column_name)
    .filter((c) => c in data[0]);
  const list = cols.map((c) => `"${c}"`).join(", ");
  const update = cols.filter((c) => c !== "id").map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE NOT (id = ANY($1::text[]))`, data.map((r) => String(r.id)));
      for (let i = 0; i < data.length; i += 2000) {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${t} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb) ON CONFLICT (id) DO UPDATE SET ${update}`,
          JSON.stringify(data.slice(i, i + 2000)),
        );
      }
      // Written last, in the same transaction: a load cut off halfway leaves the old mark, so the next deploy retries.
      await tx.$executeRawUnsafe(`COMMENT ON TABLE ${t} IS '${mark}'`);
    },
    { maxWait: 60_000, timeout: 10 * 60_000 },
  );
  console.log(`${s.name}: ${data.length}`);
}

async function seedFirstShop() {
  if ((await db.user.count()) > 0) {
    console.log("Users exist; skipping shop/owner seed.");
    return;
  }
  const email = (process.env.SEED_OWNER_EMAIL || "owner@example.com").toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD || randomBytes(9).toString("base64url");
  // SEED_SHOP_KIND (or DEFAULT_SHOP_KIND): repair | retail (a sewing / quilt shop, StitchShop) | both
  const kind = process.env.SEED_SHOP_KIND || process.env.DEFAULT_SHOP_KIND || "repair";
  const doesRepair = kind !== "retail";
  const shop = await db.shop.create({
    data: {
      name: process.env.SEED_SHOP_NAME || (doesRepair ? "My Repair Shop" : "My Sewing Shop"),
      doesRepair,
      sellsRetail: kind === "retail" || kind === "both",
      users: {
        create: {
          email,
          name: process.env.SEED_OWNER_NAME || "Shop Owner",
          role: "OWNER",
          passwordHash: await bcrypt.hash(password, 10),
        },
      },
      serviceItems: doesRepair ? { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: s.priceCents, sortOrder: i, equipmentKind: starterKindFor(s.name) })) } : undefined,
    },
  });
  console.log(`Shop "${shop.name}" created. Owner login: ${email}`);
  if (!process.env.SEED_OWNER_PASSWORD) console.log(`Owner password (change it in Settings): ${password}`);
}

// --if-empty (every deploy): load a reference set only when the shipped file differs from what was loaded last.
// Without it (npm run db:seed) every set is loaded again.
const ifEmpty = process.argv.includes("--if-empty");

async function main() {
  for (const s of SETS) {
    // The manual-library listing describes one shop's own C:\Manuals; other shops don't load it.
    if (s.table === "LibraryDoc" && process.env.SEED_LIBRARY !== "true") continue;
    await loadSet(s, !ifEmpty);
  }
  await seedFirstShop();
  // Shops created before the checklist existed get the default one.
  const n = await db.$executeRaw`UPDATE "Shop" SET "checklistItems" = ${DEFAULT_CHECKLIST} WHERE "checklistItems" IS NULL OR cardinality("checklistItems") = 0`;
  if (n) console.log(`Checklist set on ${n} shop(s)`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
