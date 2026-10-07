// A company from a move file, from the command line (company-move-design.md section 4): for the operator of a server
// with no browser upload, and for the checks. The same importCompany as the Companies page and the Windows tray: every
// refusal before anything is written, then one transaction with every id kept.
//   npm run check scripts/move/import.ts <file.stitchmove.ndjson.gz> [--into <DATABASE_URL>]
// Without --into, DATABASE_URL (.env) is the install it goes into. Once the company is in, the install's StitchHub is
// told it is here (package move-hub; the summary's StitchHub line says how that went, and "Re-point the hub" in Settings
// → Company tries again).
import "dotenv/config";
import fs from "node:fs";

function usage(): never {
  console.error("usage: npm run check scripts/move/import.ts <file.stitchmove.ndjson.gz> [--into <DATABASE_URL>]");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--into");
  const into = at >= 0 ? args[at + 1] : null;
  if (at >= 0 && !into) usage();
  const [file] = args.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!file) usage();
  if (!fs.existsSync(file)) {
    console.error(`No file at ${file}.`);
    process.exit(1);
  }
  // Before the database module is loaded: it connects to DATABASE_URL as it loads.
  if (into) process.env.DATABASE_URL = into;
  const { db } = await import("@/lib/db");
  const { importCompany } = await import("@/lib/move/import");
  const { isUserError } = await import("@/lib/user-error");
  let last = "";
  try {
    const summary = await importCompany(file, {
      by: "operator",
      onProgress: (p) => {
        const line =
          p.phase === "checking"
            ? `checking: ${(p.bytesRead / 1024 / 1024).toFixed(1)} of ${(p.bytesTotal / 1024 / 1024).toFixed(1)} MB`
            : `importing ${p.table ?? ""}: ${p.rowsDone}/${p.rowsTotal} rows`;
        if (line !== last && process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
        last = line;
      },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`${summary.shopName} (${summary.shopId}) imported: ${summary.rows} rows, from ${summary.from}.`);
    if (summary.owners.length) console.log(`Sign in as ${summary.owners.join(" or ")}.`);
    for (const [title, list] of [
      ["Enter again", summary.reenter],
      ["What changed", summary.notes],
      ["From the old install", summary.warnings],
    ] as const) {
      if (!list.length) continue;
      console.log(`${title}:`);
      for (const l of list) console.log(`  - ${l}`);
    }
  } catch (e) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    if (!isUserError(e)) throw e;
    console.error(`Nothing was imported. ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
