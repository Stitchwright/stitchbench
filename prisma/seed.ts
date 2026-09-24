// Seed: the reference tension specs (all shops) plus, on an empty database,
// the first shop, its owner account and a starter service menu.
// Run: npm run db:seed   (safe to re-run; specs are upserted by id)
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

async function main() {
  await seedSpecs();
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
