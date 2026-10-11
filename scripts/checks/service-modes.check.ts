// Test modes (handoff item 15), against the dev database: the shipped set loads through the seed's reference path
// (prisma/seed.ts --if-empty) and the Windows program's (desktop/reference.mjs), all 136 rows, a stale or extra row put
// right; a machine matches by model key alone, twins of other brands included (an Elna 7200 is in a Janome row), and a
// bare number shared with another brand doesn't pull that brand's row in; a factory setting's "test mode 36" resolves to
// test 36 of the model's test mode (and the card's link to it); the card's data for a model with two modes; the
// "test mode NN" parser and the test-code comparison.
//   npm run check scripts/checks/service-modes.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { db } from "@/lib/db";
import { figureId } from "@/lib/figures";
import { settingsFor } from "@/lib/model-info";
import { codeNumber, findTestLink, modeAnchor, modesFor, modesSharing, withTestLinks, type ModeTest } from "@/lib/service-modes";
import { loadReference } from "../../desktop/reference.mjs";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const SEED_DIR = path.join(process.cwd(), "prisma", "seed-data");
const FILE = path.join(SEED_DIR, "service_modes.json");
const RUN = Date.now().toString(36);

type Shipped = { id: string; brand: string; models: string; modelKeys: string[]; mode: string; tests: ModeTest[]; page: number | null; figurePage: number | null; figureBox: number[] };

async function mark() {
  const [row] = await db.$queryRawUnsafe<{ c: string | null }[]>(`SELECT obj_description('"ServiceMode"'::regclass, 'pg_class') AS c`);
  return row?.c ?? null;
}

/** Spoils the loaded set the way an older release or a cut-off load would leave it: a stale mark, a changed row, an extra row. */
async function spoil(first: Shipped) {
  await db.$executeRawUnsafe(`COMMENT ON TABLE "ServiceMode" IS 'seed:stale'`);
  await db.serviceMode.update({ where: { id: first.id }, data: { mode: `changed ${RUN}` } });
  await db.serviceMode.create({
    data: { id: `chk-${RUN}`, brand: "Check", models: "CHK1", modelKeys: ["CHK1"], mode: "Test mode", enterSteps: ["x"], exitSteps: [], tests: [], sourceFile: "chk.pdf" },
  });
}

async function expectShipped(rows: Shipped[], want: string, how: string) {
  assert.equal(await db.serviceMode.count(), rows.length, `${how}: ${rows.length} rows`);
  assert.equal(await db.serviceMode.count({ where: { id: `chk-${RUN}` } }), 0, `${how}: a row the file doesn't have is removed`);
  assert.equal((await db.serviceMode.findUniqueOrThrow({ where: { id: rows[0].id } })).mode, rows[0].mode, `${how}: a changed row is put back`);
  assert.equal(await mark(), want, `${how}: the file's hash is recorded`);
}

async function main() {
  const text = fs.readFileSync(FILE, "utf8");
  const rows = JSON.parse(text) as Shipped[];
  const want = `seed:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!.replace("@localhost:", "@127.0.0.1:"), max: 2 });
  try {
    // ---------- 1. the shipped set ----------
    assert.equal(rows.length, 136, "service_modes.json has 136 procedures");
    for (const r of rows) {
      assert.ok(r.modelKeys.length, `${r.id} has model keys`);
      assert.ok("figurePage" in r && Array.isArray(r.figureBox), `${r.id} has figurePage and figureBox (the loader takes the first row's keys as the columns)`);
      assert.ok(r.figureBox.length === 0 || r.figureBox.length === 4, `${r.id}: figureBox is empty or four fractions`);
    }
    assert.ok(!/\b(password|passcode|PIN)\s*(is|:)\s*\d/i.test(text), "no password or PIN written into the steps");
    ok(`service_modes.json: ${rows.length} rows, each with model keys and a figure page / box`);

    // ---------- 2. the seed's reference path (deploys: prisma/seed.ts --if-empty) ----------
    await spoil(rows[0]);
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const out = execFileSync(process.execPath, [tsx, "prisma/seed.ts", "--if-empty"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    assert.match(out, /Test modes: 136/, "the seed says it loaded the test modes");
    await expectShipped(rows, want, "seed");
    const db0 = await db.serviceMode.findUniqueOrThrow({ where: { id: "9548d8dbeb956c09c234" } });
    assert.deepEqual(db0.enterSteps.length, 2, "steps load as a text array");
    assert.equal((db0.tests as ModeTest[])[0].code, "02", "tests load as JSON with their codes as written");
    assert.deepEqual(db0.figureBox, [], "an empty figure box loads as an empty list");
    ok("prisma/seed.ts --if-empty reloads a stale set: 136 rows, a changed row put back, an extra removed, the hash recorded");

    // ---------- 3. the Windows program's loader (desktop/reference.mjs, at every start) ----------
    await spoil(rows[0]);
    const logged: string[] = [];
    await loadReference(pool, SEED_DIR, { library: false, log: (...a: unknown[]) => logged.push(a.map(String).join(" ")) });
    assert.ok(
      logged.some((l) => l.includes("ServiceMode (136 rows) loaded")),
      `the program logs the load: ${logged.join(" / ")}`,
    );
    await expectShipped(rows, want, "desktop");
    const again: string[] = [];
    await loadReference(pool, SEED_DIR, { library: false, log: (...a: unknown[]) => again.push(a.map(String).join(" ")) });
    assert.ok(!again.some((l) => l.includes("ServiceMode")), "an unchanged set is skipped at the next start");
    assert.ok(fs.readFileSync(path.join(process.cwd(), "desktop", "prepare-app.mjs"), "utf8").includes('"service_modes.json"'), "prepare-app ships the file");
    assert.ok(fs.readFileSync(path.join(process.cwd(), "desktop", "backup.mjs"), "utf8").includes('"ServiceMode"'), "backups leave the reference set out");
    ok("desktop/reference.mjs loads the shipped file the same way and skips it once loaded; prepare-app ships it; backups skip it");

    // ---------- 4. matching a machine by model key alone ----------
    const elna = await modesFor("Elna", "7200");
    assert.ok(elna.length >= 1, "an Elna 7200 finds a procedure");
    assert.ok(
      elna.every((m) => m.brand === "Janome" && m.modelKeys.includes("7200")),
      "it is the Janome row that lists the Elna 7200 as a twin",
    );
    const kenmore = await modesFor("Kenmore", "NV1500D");
    assert.deepEqual(
      kenmore.map((m) => m.brand),
      ["Brother", "Brother"],
      "a brand no row names still matches by the model key",
    );
    const janome9000 = await modesFor("Janome", "9000");
    const brother9000 = await modesFor("Brother", "9000");
    assert.ok(janome9000.length && janome9000.every((m) => m.brand === "Janome"), "a Janome 9000 doesn't get the Brother row that shares the bare number");
    assert.ok(brother9000.length && brother9000.every((m) => m.brand === "Brother"), "and a Brother 9000 doesn't get the Janome one");
    assert.deepEqual(await modesFor("Brother", "!!"), [], "a model with no key matches nothing");
    // Every shipped key finds its row for a machine of that row's brand.
    for (const r of rows) {
      const k = r.modelKeys[0];
      const found = await db.serviceMode.findMany({ where: { modelKeys: { has: k } }, select: { id: true } });
      assert.ok(
        found.some((f) => f.id === r.id),
        `${r.brand} ${k} finds ${r.id}`,
      );
    }
    ok("matching by model key: twin rows of another brand (Elna 7200 -> Janome), an unnamed brand, a bare number not crossing brands");

    // ---------- 5. the card's data for a model with two modes ----------
    const nv = await modesFor("Brother", "NV1500D");
    assert.deepEqual(
      nv.map((m) => m.mode),
      ["Test mode", "Touch panel calibration"],
      "both modes, the test mode first",
    );
    for (const m of nv) {
      assert.ok(m.enterSteps.length > 0 && m.exitSteps.length > 0, `${m.mode}: steps to enter and leave`);
      assert.ok(Array.isArray(m.tests) && m.tests.every((t) => typeof t.code === "string" && typeof t.purpose === "string"), `${m.mode}: tests as code -> purpose`);
      assert.ok(m.page && m.figurePage === m.page && m.figureBox.length === 0, `${m.mode}: the whole first page as its picture for now`);
      assert.equal(m.figureId, figureId(m.sourcePath ?? m.sourceFile, m.page!, []), `${m.mode}: the figure id the figure route stores it under`);
      assert.equal(typeof m.figureStored, "boolean");
    }
    const test = nv[0];
    assert.ok(
      test.tests.some((t) => codeNumber(t.code) === "36"),
      "the NV1500D test mode lists test 36",
    );
    assert.ok(["high", "medium", "low"].includes(test.confidence ?? ""), "a confidence to show (medium and low say: check on the machine)");
    ok(`card data for the NV1500D: ${nv.length} modes in order, steps, ${test.tests.length} tests, page ${test.page} with its picture`);

    // ---------- 6. a factory setting's "test mode 36" ----------
    // The factory settings are among the manufacturers' reference data, which isn't in the public code: a checkout
    // without factory_settings.json has no settings to link from.
    if (!fs.existsSync(path.join(SEED_DIR, "factory_settings.json"))) {
      console.log("  --  a factory setting's \"test mode 36\": skipped, prisma/seed-data/factory_settings.json isn't here (the manufacturers' reference data)");
    } else {
      const s36 = await db.factorySetting.findFirstOrThrow({ where: { modelKeys: { has: "NV1500D" }, conditions: { contains: "test mode 36", mode: "insensitive" } } });
      const link = findTestLink(s36.conditions, s36, await modesSharing(s36.modelKeys));
      assert.ok(link, "the setting's text links");
      assert.equal(s36.conditions!.slice(link.start, link.end).toLowerCase(), "test mode 36", "the link covers the words 'test mode 36'");
      assert.equal(link.modeId, test.id, "to the NV1500D test mode");
      assert.equal(codeNumber(test.tests[link.test!].code), "36", "at test 36");
      assert.ok(link.title.includes(test.tests[link.test!].purpose), "its title says what test 36 does");
      // On the machine page: settingsFor + modesFor, linked to the card's anchors on the same page.
      const panel = withTestLinks(await settingsFor("Brother", "NV1500D"), nv, (l) => `#${modeAnchor(l.modeId, l.test)}`);
      const linked = panel.find((p) => p.id === s36.id);
      assert.equal(linked?.testLinks.conditions?.href, `#sm-${test.id}-t${link.test}`, "the machine page links it to the test's row in the card");
      // The /specs list: every numbered reference whose model has a test mode with that number resolves to it.
      const mentions = await db.factorySetting.findMany({ where: { conditions: { contains: "test mode", mode: "insensitive" } } });
      const pool2 = await modesSharing(mentions.flatMap((m) => m.modelKeys));
      let numbered = 0;
      let resolved = 0;
      for (const m of mentions) {
        const l = findTestLink(m.conditions, m, pool2);
        const n = /test\s+mode\s+(?:pattern\s+)?["'[#(]?(\d{1,3})\b/i.exec(m.conditions ?? "");
        if (!l || !n) continue;
        numbered += 1;
        if (l.test != null) resolved += 1;
      }
      assert.ok(numbered > 100 && resolved / numbered > 0.95, `numbered references resolve to a test: ${resolved} of ${numbered}`);
      ok(`"test mode 36" on an NV1500D setting links to test 36 (machine page anchor and /specs); ${resolved} of ${numbered} numbered references with a mode resolve to a test`);
    }

    // ---------- 7. the parser and the code comparison ----------
    const parse = (t: string) => {
      const l = findTestLink(t, { brand: "Brother", modelKeys: ["NV1500D"] }, nv);
      return l ? { words: t.slice(l.start, l.end), code: l.test == null ? null : nv.find((m) => m.id === l.modeId)!.tests[l.test].code } : null;
    };
    assert.equal(parse("Measure in test mode 36 at the needle")?.words, "test mode 36");
    assert.equal(codeNumber(parse('In test mode "36" the needle stops')!.code!), "36");
    assert.equal(codeNumber(parse("Test mode [36]")!.code!), "36");
    assert.equal(codeNumber(parse("test mode #36, then")!.code!), "36");
    assert.equal(codeNumber(parse("test mode pattern 036")!.code!), "36");
    assert.deepEqual(parse("Enter test mode and press start"), { words: "test mode", code: null }, "no number: the mode itself");
    assert.equal(parse("test mode 3.5 mm")?.code, null, "a measurement is not a test number");
    assert.equal(parse("no mode here"), null);
    assert.equal(findTestLink("test mode 36", { brand: "Brother", modelKeys: ["NOSUCH1"] }, nv), null, "no link when no mode shares a key");
    assert.deepEqual(["02", "2", "#2", "No.2", "NO. 2", "00", "Bobbin", "1-3"].map(codeNumber), ["2", "2", "2", "2", "2", "0", null, null]);
    ok("'test mode NN' read in its usual spellings; 02, #2 and No.2 are the same test; words and ranges are not numbers");
  } finally {
    await db.serviceMode.deleteMany({ where: { id: `chk-${RUN}` } });
    // Leave the set as shipped even when a step failed halfway.
    if ((await mark()) !== want) await loadReference(pool, SEED_DIR, { library: false, log: () => {} }).catch(() => {});
    await pool.end();
  }
  console.log(`service-modes.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
