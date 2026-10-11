// Switching an add-on on or off for a company, as its owner would in Settings → Features (free-software-design.md
// section 7, decision 6). The specs' companies are made from Companies by the e2e owner, who isn't signed in to them,
// so the switch is written to the database directly (tests/helpers.ts), as the Features page writes it.
import type { Page } from "@playwright/test";
import { one, sql } from "../helpers";

export type ModuleName = "Vac Shop" | "Small Appliance Repair" | "Scheduling" | "Marketing" | "Maker Shop";

const ID: Record<ModuleName, string> = { "Vac Shop": "vac", "Small Appliance Repair": "appliance", Scheduling: "scheduling", Marketing: "marketing", "Maker Shop": "maker" };

/**
 * `on` true: the feature switched on for the company; false: switched off (read-only from now, as the page does).
 * `company` is the company's name as the Companies page shows it. The page argument is kept so the specs read as they did.
 */
export async function setModule(_page: Page, company: string, key: ModuleName, on: boolean) {
  const shop = await one<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]);
  if (!shop) throw new Error(`no company named ${company}`);
  await sql(
    `INSERT INTO "ShopFeature" ("shopId", module, enabled, "changedAt", "byName") VALUES ($1, $2, $3, now(), 'e2e')
       ON CONFLICT ("shopId", module) DO UPDATE SET enabled = EXCLUDED.enabled, "changedAt" = now(), "byName" = 'e2e'`,
    [shop.id, ID[key], on],
  );
}
