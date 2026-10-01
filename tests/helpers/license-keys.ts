// Development license keys for Playwright specs: devKey() makes one (the same options as devLicenseKey in
// scripts/license/dev.ts), pasteKey() adds it on Settings -> Modules. Self-contained on purpose: Playwright's CommonJS
// loader can't import scripts/license/dev.ts (import.meta), so the ten signing lines are repeated here and the key
// file is read with fs. Such keys count only where devKeysAllowed() is true (a test build against a local database).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { encodeLicense, newKeyId, planLastDay, type LicensePayload } from "../../src/lib/license";
import type { DevKeyOpts } from "../../scripts/license/dev";

export type { DevKeyOpts };

const devKeyFile = path.resolve(__dirname, "..", "..", "scripts", "license", "dev-key.json");
let cached: { kid: string; privateKeyPem: string } | null = null;
function devSigner() {
  return (cached ??= JSON.parse(fs.readFileSync(devKeyFile, "utf8")) as { kid: string; privateKeyPem: string });
}

/** A key signed with the development key (= devLicenseKey in scripts/license/dev.ts). */
export function devKey(o: DevKeyOpts): string {
  const dev = devSigner();
  const from = o.from ?? new Date().toISOString().slice(0, 10);
  const plan = o.plan ?? "y";
  const until = o.until ?? planLastDay(from, plan === "m" || plan === "t" ? plan : "y");
  const payload: LicensePayload = {
    v: 1,
    k: dev.kid,
    id: o.id ?? newKeyId(),
    s: o.shopId,
    n: o.name ?? "Development key",
    m: o.modules,
    p: plan,
    f: from,
    u: until,
    g: o.grace ?? 14,
    t: (o.issuedAt ? new Date(o.issuedAt) : new Date()).toISOString(),
  };
  return encodeLicense(payload, crypto.createPrivateKey({ key: dev.privateKeyPem, format: "pem" }));
}

/** On Settings -> Modules: paste `key` (a key, or a whole email holding one), press Add key, and wait for "Key added". */
export async function pasteKey(page: Page, key: string) {
  await page.goto("/settings/modules");
  await page.getByLabel("Paste the key from your email (or the whole email)").fill(key);
  await page.getByRole("button", { name: "Add key" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Key added" }).first()).toBeVisible();
}
