// Shared by the tenant, roles and auth specs: the logins scripts/e2e-setup.ts makes, signing in, and the database the
// app under test runs on (the specs run on the same PC as the dev Postgres in .env), so a spec can make the rows it
// needs, check that a refused action changed nothing, and take its rows away again. Plain SQL through `pg`: the
// generated Prisma client is an ES module (import.meta), which Playwright's CommonJS test loader can't compile.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { expect, type Browser, type Page, type Route } from "@playwright/test";

export type Login = { email: string; password: string };

/** The E2E shop's owner: the user every other spec signs in as. */
export const OWNER: Login = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
/** A tech in the E2E shop. */
export const TECH: Login = { email: process.env.E2E_TECH_EMAIL ?? "e2e-tech@stitchbench.test", password: process.env.E2E_TECH_PASSWORD ?? "e2e-password-1" };
/** The owner of the second company, "E2E Other Shop". */
export const OTHER: Login = { email: process.env.E2E_OTHER_EMAIL ?? "e2e-other@stitchbench.test", password: process.env.E2E_OTHER_PASSWORD ?? "e2e-password-1" };

/** A tag for this run's rows, so runs don't collide and leftovers say where they came from. */
export const RUN = Date.now().toString(36).toUpperCase();

// 1x1 PNG
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// ---------- the database ----------

let pool: Pool | null = null;
function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (the specs read .env for the dev database).");
  return (pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
}

/** Rows of a query. Column and table names are Prisma's (quoted, camelCase). */
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)).rows as T[];
}

/** The first row, or null. */
export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await sql<T>(text, params))[0] ?? null;
}

/** A row id the way Prisma makes them (25 characters starting with c). */
export function newId() {
  return "c" + randomBytes(18).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24).padEnd(24, "0");
}

/** Inserts a row (an id is made when none is given) and returns it. */
export async function insert<T = Record<string, unknown>>(table: string, data: Record<string, unknown>): Promise<T> {
  const row = { id: newId(), ...data };
  const cols = Object.keys(row);
  const text = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
  return (await sql<T>(text, Object.values(row)))[0];
}

export async function remove(table: string, id: string) {
  await sql(`DELETE FROM "${table}" WHERE id = $1`, [id]);
}

/** Closes the connection; call from afterAll. */
export async function disconnect() {
  await pool?.end();
  pool = null;
}

/** The shop a login belongs to. */
export async function shopOf(who: Login) {
  const u = await one<{ id: string; shopId: string; role: string }>(`SELECT id, "shopId", role FROM "User" WHERE email = $1`, [who.email.toLowerCase()]);
  if (!u) throw new Error(`${who.email} is not in the database: run npm run e2e:setup`);
  return u;
}

// ---------- the browser ----------

/** On the sign-in page: fill it in and submit (no waiting; the test decides what should happen). */
export async function fillIn(page: Page, who: Login) {
  await page.getByLabel("Email", { exact: true }).fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Sign in from the sign-in page and wait until the page has moved on. */
export async function signIn(page: Page, who: Login) {
  await page.goto("/login");
  await fillIn(page, who);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** A fresh browser context signed in as `who`. */
export async function login(browser: Browser, who: Login) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, who);
  return page;
}

/** A red toast with this text (a server action's UserError, shown by ActionForm / ActionButton). */
export async function expectRefused(page: Page, text: string | RegExp) {
  // first(): the same refusal twice in a row shows two toasts at once.
  await expect(page.locator("[data-sonner-toast][data-type='error']").filter({ hasText: text }).first()).toBeVisible();
}

/**
 * Runs `act` (a click or submit on the page) with every occurrence of `own` in the server action's request body swapped
 * for `foreign`: the page's own action, replayed with another shop's id, the way a crafted request would. Exactly one
 * request must have carried the id.
 */
export async function withSwappedId(page: Page, own: string, foreign: string, act: () => Promise<void>) {
  let swapped = 0;
  let seen!: () => void;
  const first = new Promise<void>((r) => (seen = r));
  const handler = async (route: Route) => {
    const req = route.request();
    const body = req.method() === "POST" && req.headers()["next-action"] ? (req.postData() ?? "") : "";
    if (body.includes(own)) {
      swapped++;
      seen();
      await route.continue({ postData: body.split(own).join(foreign) });
    } else await route.continue();
  };
  await page.route("**/*", handler);
  try {
    await act();
    // The click returns before the action's request goes out: wait for it, so it can't leave with the real id.
    await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error("no server action carried the id within 30 s")), 30_000))]);
  } finally {
    await page.unroute("**/*", handler);
  }
  expect(swapped, "one server action carried the swapped id").toBe(1);
}
