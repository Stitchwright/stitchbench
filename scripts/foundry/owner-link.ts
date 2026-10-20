// Make a one-time link (24 hours) that lets a login link its Foundry Account, for the way back in when nobody is signed in: the
// first owner whose seed link expired, or an owner who lost their Foundry Account (docs/plan.md FA-5). Needs FOUNDRY_SIGNIN=only.
// It clears the login's current link, like the Companies page's Reset link does. Printed once, not kept anywhere else.
//   railway run npm run foundry:owner-link -- owner@example.com [company name]
import "dotenv/config";
import { db } from "@/lib/db";
import { foundrySignInMode } from "@/lib/foundry/switches";
import { issueResetLink, SETUP_HOURS } from "@/lib/password-reset";
import { normalizeEmail } from "@/lib/email";

async function main() {
  if (foundrySignInMode() !== "only") throw new Error("Set FOUNDRY_SIGNIN=only first.");
  const email = normalizeEmail(process.argv[2]);
  const company = process.argv.slice(3).join(" ").trim();
  if (!email) throw new Error("Usage: npm run foundry:owner-link -- owner@example.com [company name]");
  const users = await db.user.findMany({ where: { email, role: "OWNER", active: true, ...(company ? { shop: { name: company } } : {}) }, select: { id: true, shop: { select: { name: true } } } });
  if (users.length === 0) throw new Error(`No active owner login for ${email}${company ? ` in ${company}` : ""}.`);
  if (users.length > 1) throw new Error(`${email} owns ${users.length} companies (${users.map((u) => u.shop.name).join(", ")}): add the company's name after the email.`);
  const [u] = users;
  await db.user.update({ where: { id: u.id }, data: { foundryId: null, sessionVersion: { increment: 1 } } });
  const { link } = await issueResetLink(u.id, "admin", SETUP_HOURS);
  console.log(`Link for ${email} (${u.shop.name}); it works once, for ${SETUP_HOURS} hours:\n  ${link}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
