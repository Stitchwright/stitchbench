// Upload machine pictures and manual figures cut by model_images.py / render_figures.py.
// usage: DATABASE_URL=... npx tsx scripts/library/upload-media.ts   (reads ~/stitchbench-media)
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db } from "../../src/lib/db";

const MEDIA = process.env.STITCHBENCH_MEDIA ?? join(homedir(), "stitchbench-media");

type ModelRow = { id: string; brand: string; models: string; modelKeys: string[]; sourcePath: string; page: number; width: number; height: number };
type FigRow = { id: string; sourcePath: string; page: number; box: number[]; width: number; height: number };

async function upload<T extends { id: string }>(kind: "models" | "figures", write: (r: T, data: Buffer) => Promise<unknown>, have: Set<string>) {
  const manifest = join(MEDIA, `${kind}.json`);
  if (!existsSync(manifest)) return console.log(`No ${kind}.json yet`);
  const rows: T[] = JSON.parse(readFileSync(manifest, "utf8"));
  let n = 0;
  for (const r of rows) {
    if (have.has(r.id)) continue;
    const file = join(MEDIA, kind, `${r.id}.jpg`);
    if (!existsSync(file)) continue;
    await write(r, readFileSync(file));
    if (++n % 250 === 0) console.log(`${kind}: ${n} uploaded`);
  }
  console.log(`${kind}: ${n} new, ${rows.length} in manifest`);
}

async function main() {
  const haveModels = new Set((await db.modelImage.findMany({ select: { id: true } })).map((r) => r.id));
  await upload<ModelRow>(
    "models",
    (r, data) =>
      db.modelImage.create({
        data: { id: r.id, brand: r.brand, models: r.models, modelKeys: r.modelKeys, sourcePath: r.sourcePath, page: r.page, width: r.width, height: r.height, mime: "image/jpeg", data: new Uint8Array(data) },
      }),
    haveModels,
  );
  const haveFigs = new Set((await db.figureImage.findMany({ select: { id: true } })).map((r) => r.id));
  await upload<FigRow>(
    "figures",
    (r, data) =>
      db.figureImage.create({
        data: { id: r.id, sourcePath: r.sourcePath, page: r.page, box: r.box, width: r.width, height: r.height, mime: "image/jpeg", data: new Uint8Array(data) },
      }),
    haveFigs,
  );
}

main().finally(() => db.$disconnect());
