// The nightly demo reset's guard, through the real script (scripts/demo/reset.ts, src/lib/demo-reset.ts): it must refuse
// on a server that is not in demo mode, and refuse when the database also holds a company that is not a demo company, and
// in both cases leave every company exactly as it was. (Its allowed path runs a seed script that deletes and rebuilds the
// demo companies; that is run on a scratch database by hand, see docs/demo.md, because this check shares the dev database.)
//   npm run check scripts/checks/demo-reset.check.ts
// Shares the dev database: a throwaway company "Check <run>" (removed at the end).
import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db";
import { checkShop, cleanup } from "./lib";

const ok = (what: string) => console.log(`  ok  ${what}`);

function reset(env: Record<string, string>) {
  const r = spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/demo/reset.ts", "--check"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
}

async function main() {
  const real = await checkShop({ retail: true }); // a company that is not a demo company, in the same database
  try {
    const shops = async () => (await db.shop.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } })).map((s) => `${s.id}:${s.name}`);
    const before = await shops();

    const off = reset({ DEMO_MODE: "off" });
    assert.equal(off.code, 1, off.text);
    assert.match(off.text, /DEMO_MODE is not on/);
    ok("a server that is not in demo mode refuses the reset");

    const mixed = reset({ DEMO_MODE: "on" });
    assert.equal(mixed.code, 1, mixed.text);
    assert.match(mixed.text, /not a demo company/);
    assert.match(mixed.text, /Nothing was touched/);
    ok("a demo server whose database also holds a real company refuses it, naming the company");

    assert.deepEqual(await shops(), before, "every company is exactly as it was");
    assert.ok(await db.shop.findUnique({ where: { id: real.shopId } }), "the real company is still there");
    ok("and nothing was deleted");
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log("demo-reset.check: 3 steps passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
