// Restore a company from an off-site backup, from the command line (later-round-1-design.md 1.5): for a shop that left the
// hub, or the operator restoring by hand. The backups are in a folder (the folder target, or a copy of the store);
// the recovery key is the 52 characters on the sheet.
//   npm run check scripts/offsite/restore.ts --folder D:\Backups\StitchBench --list
//   npm run check scripts/offsite/restore.ts --folder D:\Backups\StitchBench --key ABCD-EFGH-... [--backup data/2026-10-06-020000.sbob] [--to out.stitchmove.ndjson.gz] [--import]
//   npm run check scripts/offsite/restore.ts --hub https://stitchhub.example --code shr_... --key ABCD-EFGH-...   (a restore code from the StitchHub account)
// Without --import the decrypted move file is written to --to; with it the company is imported into the database in .env
// as the StitchBench administrator would (every refusal of the importer applies: the company must not already be here).
import "dotenv/config";
import { db } from "@/lib/db";
import { importCompany } from "@/lib/move/import";
import { MOVE_SUFFIX } from "@/lib/move/format";
import { keyFromText } from "@/lib/offsite/crypto";
import { listBackups, restoreToFile } from "@/lib/offsite/restore";
import { folderStore } from "@/lib/offsite/store";
import { hubCodeStore } from "@/lib/offsite/hub-store";
import { isUserError } from "@/lib/user-error";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const folder = arg("--folder");
  const hub = arg("--hub");
  const code = arg("--code");
  if (!folder && !(hub && code)) {
    console.error("usage: restore.ts (--folder <folder> | --hub <hub address> --code <restore code>) (--list | --key <recovery key> [--backup <name>] [--to <file>] [--import])");
    process.exit(2);
  }
  const store = folder ? folderStore(folder) : (await hubCodeStore(hub!, code!)).store;
  const backups = await listBackups(store);
  if (process.argv.includes("--list")) {
    for (const b of backups) console.log(`${b.name}  ${b.at?.toISOString() ?? "?"}  ${(b.size / 1024 / 1024).toFixed(1)} MB`);
    if (!backups.length) console.log("No backups in that folder.");
    return;
  }
  const keyText = arg("--key");
  if (!keyText) {
    console.error("The recovery key is needed: --key ABCD-EFGH-...");
    process.exit(2);
  }
  const name = arg("--backup") ?? backups[0]?.name;
  if (!name) {
    console.error("No backups in that folder.");
    process.exit(1);
  }
  const file = arg("--to") ?? `restored-${new Date().toISOString().slice(0, 10)}${MOVE_SUFFIX}`;
  const r = await restoreToFile(store, keyFromText(keyText), name, file, { moveToken: folder ? undefined : code });
  console.log(`Opened ${name}: ${r.shopName} (${r.shopId}), ${r.rows.toLocaleString("en-US")} rows, ${r.photos} pictures, taken ${r.exportedAt}. Written to ${file}.`);
  if (process.argv.includes("--import")) {
    const s = await importCompany(file, { by: "operator" });
    console.log(`Imported ${s.shopName}: ${s.rows} rows.`);
    for (const x of s.reenter) console.log(`  to do: ${x}`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error(isUserError(e) ? (e as Error).message : e);
    process.exit(1);
  });
