// The move file from the command line, for the operator (company-move-design.md section 3 and 8): a server with no
// browser, or the hosted administrator moving a company out by hand. Same file as Settings → Company's download.
//   npm run check scripts/move/export.ts <Company ID> <file.stitchmove.ndjson.gz> [--freeze [--to "the shop PC"]]
//   npm run check scripts/move/export.ts --list                    the companies on this database, with their ids
// Without --freeze the file is a snapshot and the company carries on (a copy to keep); with it, the company is frozen
// as the owner's confirm would (Shop.movingAt set; Cancel in Settings → Company lifts it). Needs DATABASE_URL (.env).
import "dotenv/config";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadable } from "node:stream/web";
import { db } from "@/lib/db";
import { exportCompany, startMove, type Mover } from "@/lib/move/export";
import { MOVE_SUFFIX } from "@/lib/move/format";

function usage(): never {
  console.error('usage: npm run check scripts/move/export.ts <Company ID> <file.stitchmove.ndjson.gz> [--freeze [--to "where"]] | --list');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const shops = await db.shop.findMany({ select: { id: true, name: true, movingAt: true, movedOutAt: true }, orderBy: { name: "asc" } });
    for (const s of shops) console.log(`${s.id}  ${s.name}${s.movingAt ? "  (moving)" : ""}${s.movedOutAt ? "  (moved out)" : ""}`);
    return;
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--to");
  const [shopId, file] = positional;
  if (!shopId || !file) usage();
  const freeze = args.includes("--freeze");
  const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : null;
  if (!file.endsWith(MOVE_SUFFIX)) console.warn(`note: the file name usually ends with ${MOVE_SUFFIX}`);
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, movingAt: true } });
  if (!shop) {
    console.error(`No company with id ${shopId} (try --list).`);
    process.exit(1);
  }
  // The operator stands in for the owner: the database is open to whoever runs this, and the file is the credential.
  const operator: Mover = { id: "cli", shopId: shop.id, role: "OWNER", email: "", name: "operator" };
  if (freeze && !shop.movingAt) {
    await startMove(operator, shop.id, { to });
    console.log(`${shop.name} is now read-only (moving${to ? ` to ${to}` : ""}); Cancel in Settings → Company lifts it.`);
  }
  let last = "";
  const { stream } = await exportCompany(operator, shop.id, {
    onProgress: (p) => {
      const line = `${p.table ?? "done"}: ${p.rowsDone}/${p.rowsTotal} rows, ${(p.bytes / 1024 / 1024).toFixed(1)} MB`;
      if (line !== last && process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
      last = line;
    },
  });
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(stream as unknown as WebReadable), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  if (process.stdout.isTTY) process.stdout.write("\n");
  const size = fs.statSync(file).size;
  console.log(`${shop.name} exported to ${file} (${(size / 1024 / 1024).toFixed(1)} MB)${last ? `; ${last}` : ""}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
