// Development license keys for check scripts and Playwright specs (modules-design.md section 4, dev.ts). Signed with
// scripts/license/dev-key.json, which is in the repo on purpose: such keys count only where devKeysAllowed() is true
// (next dev, check scripts, a local test build), never on the Windows program or a production server. Since 1.8 a key
// decides only the Assistant and the program itself; the five trade modules are switched on in Settings → Features
// (scripts/checks/lib.ts switchFeatures for the checks). A key for one of them still decides where the Features of a
// company from before 1.8 start (src/lib/modules.ts).
//
//   npx tsx --conditions=react-server scripts/license/dev.ts --grant <Company ID> --modules assistant --from 2025-08-01 --until 2026-09-06 [--grace 14]
//
// --grant inserts a License row straight into the database, so a spec can set up an ended key or one in its grace
// period.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addDaysYmd, encodeLicense, newKeyId, type LicensePayload } from "../../src/lib/license";

const here = path.dirname(fileURLToPath(import.meta.url));
const devKey = JSON.parse(fs.readFileSync(path.join(here, "dev-key.json"), "utf8")) as { kid: string; x: string; privateKeyPem: string };

export type DevKeyOpts = {
  shopId: string;
  modules: string[];
  from?: string; // YYYY-MM-DD, default yesterday (UTC)
  until?: string; // YYYY-MM-DD, default a year after from
  grace?: number; // default 14
  plan?: string; // default "y"
  issuedAt?: Date | string;
  name?: string;
  id?: string;
};

/** A key signed with the development key. */
export function devLicenseKey(o: DevKeyOpts): string {
  // Default: yesterday (UTC), so a key made late in the evening is already valid today in every US zone.
  const from = o.from ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const payload: LicensePayload = {
    v: 1,
    k: devKey.kid,
    id: o.id ?? newKeyId(),
    s: o.shopId,
    n: o.name ?? "Development key",
    m: o.modules,
    p: o.plan ?? "y",
    f: from,
    u: o.until ?? addDaysYmd(from, 364),
    g: o.grace ?? 14,
    t: (o.issuedAt ? new Date(o.issuedAt) : new Date()).toISOString(),
  };
  return encodeLicense(payload, crypto.createPrivateKey({ key: devKey.privateKeyPem, format: "pem" }));
}

/** Inserts a License row for the company through Prisma and returns the key text. */
export async function grantDevLicense(shopId: string, modules: string[], opts: Omit<DevKeyOpts, "shopId" | "modules"> = {}): Promise<string> {
  const { db } = await import("../../src/lib/db");
  const key = devLicenseKey({ shopId, modules, ...opts });
  const keyId = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).id as string;
  await db.license.create({ data: { shopId, keyId, key, addedBy: "dev.ts" } });
  return key;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shopId = arg("grant");
  const modules = arg("modules")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!shopId || !modules?.length) {
    console.error("usage: dev.ts --grant <Company ID> --modules assistant [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--grace 14] [--plan y]");
    process.exit(2);
  }
  const grace = arg("grace");
  grantDevLicense(shopId, modules, { from: arg("from"), until: arg("until"), grace: grace == null ? undefined : Number(grace), plan: arg("plan") })
    .then(async (key) => {
      console.log(key);
      const { db } = await import("../../src/lib/db");
      await db.$disconnect();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
