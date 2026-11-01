// The nightly reset of a public demo server (docs/demo.md): removes the demo companies and everything in them (including
// every upload: files live in the database) and makes them again from their seed scripts, so every visitor starts
// from the same clean, believable shops.
//   npm run demo:reset                run it (the Railway scheduled job runs this around 3:30 a.m. Eastern)
//   npm run demo:reset -- --check     only say whether it would be allowed here; change nothing
// It REFUSES (exit 1, nothing touched) unless DEMO_MODE=on and the database holds only demo companies with demo people
// (src/lib/demo-reset.ts). A real shop in the same database stops it. The seed scripts need DEMO_ALLOW_REMOTE=yes and
// DEMO_PASSWORD when the database is not on this PC (see seed-demo.ts).
import "dotenv/config";
import { spawnSync } from "node:child_process";

async function main() {
  const { db } = await import("@/lib/db");
  const { resetRefusal, SEED_SCRIPTS } = await import("@/lib/demo-reset");
  const look = async () => ({ shops: (await db.shop.findMany({ select: { name: true, users: { select: { email: true } } } })).map((s) => ({ name: s.name, userEmails: s.users.map((u) => u.email) })) });
  try {
    const before = resetRefusal(await look());
    if (before) {
      console.error(`Demo reset refused: ${before}`);
      process.exitCode = 1;
      return;
    }
    if (process.argv.includes("--check")) {
      console.log("Demo reset would be allowed here (demo server, only demo companies). Nothing was changed.");
      return;
    }
    for (const script of SEED_SCRIPTS) {
      console.log(`Running ${script} ...`);
      const r = spawnSync("npx", ["tsx", script], { stdio: "inherit", env: process.env });
      if (r.status !== 0) {
        console.error(`Demo reset stopped: ${script} failed (exit ${r.status}).`);
        process.exitCode = 1;
        return;
      }
    }
    const after = resetRefusal(await look());
    if (after) {
      console.error(`Demo reset finished, but the database no longer passes the demo check: ${after}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Demo reset done at ${new Date().toISOString()}.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
