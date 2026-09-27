// Creates (or resets the password of) a throwaway shop + user for the Playwright smoke test.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { normalizeEmail } from "../src/lib/email";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "../src/lib/service-menu";

async function main() {
  const email = normalizeEmail(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  const password = process.env.E2E_PASSWORD ?? "e2e-password-1";
  const hash = await bcrypt.hash(password, 10);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.user.update({ where: { email }, data: { passwordHash: hash, active: true } });
  } else {
    await db.shop.create({
      data: {
        name: "E2E Test Shop",
        checklistItems: DEFAULT_CHECKLIST,
        users: { create: { email, name: "E2E Tech", role: "OWNER", passwordHash: hash } },
        serviceItems: { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: s.priceCents, sortOrder: i })) },
      },
    });
  }
  console.log(`E2E user ready: ${email}`);
}
main().finally(() => db.$disconnect());
