// The guard of the nightly demo reset (scripts/demo/reset.ts, docs/demo.md). Pure: no database, no "server-only", so the
// script, the check and the unit test share it. The reset deletes whole companies, so it refuses unless the database can
// be proven to hold nothing but demo companies:
//  - the server is in demo mode (DEMO_MODE=on), and
//  - every company in the database is a known demo company (DEMO_COMPANIES), and every person in it has a demo address
//    (an email on an invented domain: ".test", or example.com / example.org / example.net, which nobody can own).
// A real shop in the same database makes it refuse, whatever else is set.
import { isDemo } from "@/lib/demo-mode";

/** The companies the demo seeds make. Add a name here when a seed under scripts/demo/ is added (the reset runs SEED_SCRIPTS). */
export const DEMO_COMPANIES: readonly string[] = [
  "Bobbin & Bolt Quilt Co.",
  "Maple Street Quilt Co.",
  "Main Street Threadworks",
  "Maple Street Sewing & Vacuum Repair",
];

/** True for an email on an invented domain that cannot belong to a real person: ".test", or example.com, .org and .net (and anything under them). */
export function isDemoEmail(email: string): boolean {
  const domain = email.toLowerCase().slice(email.lastIndexOf("@") + 1);
  return /\.test$/.test(domain) || /(^|\.)example\.(com|org|net)$/.test(domain);
}

/** The seed scripts the reset runs, in order. Each one removes its own demo company first and makes it again. */
export const SEED_SCRIPTS: readonly string[] = ["scripts/demo/seed-demo.ts"];

export type DatabaseView = { shops: { name: string; userEmails: string[] }[] };

/** Why the reset must not run here, or null when it may. The first reason found. */
export function resetRefusal(view: DatabaseView, demo: boolean = isDemo()): string | null {
  if (!demo) return "DEMO_MODE is not on. The demo reset only runs on a demo server.";
  for (const shop of view.shops) {
    if (!DEMO_COMPANIES.includes(shop.name)) return `The database holds a company that is not a demo company ("${shop.name}"). Nothing was touched.`;
    const stranger = shop.userEmails.find((e) => !isDemoEmail(e));
    if (stranger) return `"${shop.name}" has a person who is not a demo person (${stranger}). Nothing was touched.`;
  }
  return null;
}
