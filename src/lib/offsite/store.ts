import "server-only";
// Where off-site backups are kept (later-round-1-design.md 1.1): a store takes named, already-encrypted objects. The
// folder target is here (and works with no hub: the checks use it); the hub target is src/lib/offsite/hub-store.ts.
// A store never sees a key or a clear byte.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UserError } from "@/lib/user-error";

export type StoredObject = { name: string; size: number };

export interface OffsiteStore {
  /** Writes the object, replacing one of the same name; resolves when it is all there. */
  put(name: string, body: Readable, size?: number): Promise<void>;
  get(name: string): Promise<Readable>;
  list(): Promise<StoredObject[]>;
  delete(name: string): Promise<void>;
}

/** Object names are `data/...` and `photo/<Table>/<id>-<hash>`: letters, digits and a few marks, never a path out of the folder. */
export const OBJECT_NAME = /^(data|photo)\/[A-Za-z0-9._/-]{1,200}$/;

export function checkName(name: string): string {
  if (!OBJECT_NAME.test(name) || name.includes("..") || name.includes("//")) throw new UserError("That isn't a backup object name.");
  return name;
}

/** A folder on this PC or a mounted drive (a USB disk, a synced OneDrive or Dropbox folder). */
export function folderStore(dir: string): OffsiteStore {
  const root = path.resolve(dir);
  const at = (name: string) => path.join(root, ...checkName(name).split("/"));
  return {
    async put(name, body) {
      const file = at(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written beside the final name and renamed, so a cut-off copy is never mistaken for a backup.
      const tmp = `${file}.part`;
      try {
        await pipeline(body, fs.createWriteStream(tmp));
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
    async get(name) {
      const file = at(name);
      if (!fs.existsSync(file)) throw new UserError("That backup file isn't in the folder.");
      return fs.createReadStream(file);
    },
    async list() {
      const out: StoredObject[] = [];
      const walk = (d: string, prefix: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
          else if (!e.name.endsWith(".part")) out.push({ name: `${prefix}${e.name}`, size: fs.statSync(path.join(d, e.name)).size });
        }
      };
      walk(root, "");
      return out.filter((o) => OBJECT_NAME.test(o.name));
    },
    async delete(name) {
      fs.rmSync(at(name), { force: true });
    },
  };
}

/** A whole object read into memory (a photo, or a small file in a check). */
export async function readAll(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}
