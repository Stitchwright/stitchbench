// Seed: the reference tension specs (all shops) plus, on an empty database,
// the first shop, its owner account and a starter service menu.
// Run: npm run db:seed   (safe to re-run; specs are upserted by id). Deploys run it with --if-empty.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "../src/lib/service-menu";

type SpecRow = {
  id: string;
  category: string;
  brand: string;
  models: string;
  modelKeys: string[];
  machineType: string | null;
  upperMinG: number | null;
  upperMaxG: number | null;
  bobbinMinG: number | null;
  bobbinMaxG: number | null;
  upperPrinted: string | null;
  bobbinPrinted: string | null;
  upperText: string | null;
  upperConditions: string | null;
  bobbinText: string | null;
  bobbinConditions: string | null;
  otherSpecs: string | null;
  sourceFile: string;
  sourcePath: string | null;
  pages: string | null;
  docType: string | null;
  confidence: string | null;
  notes: string | null;
};

async function seedSpecs() {
  const rows: SpecRow[] = JSON.parse(
    readFileSync(join(__dirname, "seed-data", "tension_specs.json"), "utf8"),
  );
  const ids = rows.map((r) => r.id);
  if ((await db.tensionSpec.count()) === 0) {
    // A new database: bulk insert (much faster than upserting row by row).
    for (let i = 0; i < rows.length; i += 1000) await db.tensionSpec.createMany({ data: rows.slice(i, i + 1000) });
    console.log(`Tension specs: ${rows.length}`);
    return;
  }
  // Replace the reference set wholesale so re-exports drop stale rows.
  await db.tensionSpec.deleteMany({ where: { id: { notIn: ids } } });
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.$transaction(
      chunk.map((r) =>
        db.tensionSpec.upsert({ where: { id: r.id }, create: r, update: r }),
      ),
    );
  }
  console.log(`Tension specs: ${rows.length}`);
}

type SettingRow = {
  id: string;
  category: string;
  brand: string;
  models: string;
  modelKeys: string[];
  machineType: string | null;
  adjustment: string;
  label: string;
  valueMin: number | null;
  valueMax: number | null;
  unit: string | null;
  valueText: string | null;
  conditions: string | null;
  reference: string | null;
  tools: string | null;
  sourceFile: string;
  sourcePath: string | null;
  pages: string | null;
  figurePage: number | null;
  figureBox: number[];
  docType: string | null;
  confidence: string | null;
  notes: string | null;
};

async function seedSettings() {
  const file = join(__dirname, "seed-data", "factory_settings.json");
  let rows: SettingRow[];
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.log("No factory_settings.json yet; skipping.");
    return;
  }
  const ids = rows.map((r) => r.id);
  if ((await db.factorySetting.count()) === 0) {
    for (let i = 0; i < rows.length; i += 1000) await db.factorySetting.createMany({ data: rows.slice(i, i + 1000) });
    console.log(`Factory settings: ${rows.length}`);
    return;
  }
  await db.factorySetting.deleteMany({ where: { id: { notIn: ids } } });
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.$transaction(chunk.map((r) => db.factorySetting.upsert({ where: { id: r.id }, create: r, update: r })));
  }
  console.log(`Factory settings: ${rows.length}`);
}

type LibRow = {
  id: string;
  path: string;
  category: string;
  brand: string;
  file: string;
  docType: string | null;
  title: string | null;
  pages: number | null;
  sizeBytes: number | null;
  modelKeys: string[];
};

async function seedLibrary() {
  let rows: LibRow[];
  try {
    rows = JSON.parse(readFileSync(join(__dirname, "seed-data", "library_docs.json"), "utf8"));
  } catch {
    console.log("No library_docs.json; skipping library.");
    return;
  }
  await db.libraryDoc.deleteMany({ where: { id: { notIn: rows.map((r) => r.id) } } });
  for (let i = 0; i < rows.length; i += 500) {
    await db.libraryDoc.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
  }
  console.log(`Library documents: ${rows.length}`);
}

async function seedFirstShop() {
  if ((await db.user.count()) > 0) {
    console.log("Users exist; skipping shop/owner seed.");
    return;
  }
  const email = (process.env.SEED_OWNER_EMAIL || "owner@example.com").toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD || randomBytes(9).toString("base64url");
  const shop = await db.shop.create({
    data: {
      name: process.env.SEED_SHOP_NAME || "My Repair Shop",
      users: {
        create: {
          email,
          name: process.env.SEED_OWNER_NAME || "Shop Owner",
          role: "OWNER",
          passwordHash: await bcrypt.hash(password, 10),
        },
      },
      serviceItems: {
        create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: s.priceCents, sortOrder: i })),
      },
    },
  });
  console.log(`Shop "${shop.name}" created. Owner login: ${email}`);
  if (!process.env.SEED_OWNER_PASSWORD) console.log(`Owner password (change it in Settings): ${password}`);
}

// --if-empty: only load reference data a table doesn't have yet (each deploy runs this; the first one loads it all).
const ifEmpty = process.argv.includes("--if-empty");

async function step(name: string, count: () => Promise<number>, run: () => Promise<void>) {
  if (ifEmpty && (await count()) > 0) {
    console.log(`${name}: already loaded`);
    return;
  }
  await run();
}

async function main() {
  await step("Tension specs", () => db.tensionSpec.count(), seedSpecs);
  await step("Factory settings", () => db.factorySetting.count(), seedSettings);
  // The manual-library listing describes one shop's own C:\Manuals; other shops don't load it.
  if (process.env.SEED_LIBRARY === "true") await step("Library documents", () => db.libraryDoc.count(), seedLibrary);
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
