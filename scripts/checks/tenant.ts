// Helpers for the tenant section every package's check script has (modules-design.md section 13.1): company B calls
// the package's lib bodies with company A's ids, every call answers "not found" (or null / false / []), and A's rows
// are unchanged. The check script loads dotenv first (`import "dotenv/config"` as its first line) and runs with
// `npx tsx --conditions=react-server`, which makes `import "server-only"` a no-op.
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { createShopWithOwner, type ShopKind } from "@/lib/shops";
import type { CurrentUser } from "@/lib/session";

/** One run's tag: throwaway companies are named "Check <run>" and their logins check-<run>-<n>@stitchbench.test. */
export const RUN = Date.now().toString(36);

/** What a cross-company call may say: the row isn't there as far as this company is concerned. */
export const NOT_FOUND = /not found|another company|isn't one of/i;

/**
 * fn() must either reject with a UserError whose message matches NOT_FOUND, or resolve to null, false or [] (a read
 * that simply finds nothing). Anything else (a row, true, another error, a different message) fails the check, so a
 * body that leaked another company's row, or crashed on it, is caught either way.
 */
export async function expectNotFound(label: string, fn: () => Promise<unknown>): Promise<void> {
  let value: unknown;
  try {
    value = await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: threw something other than a UserError: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, NOT_FOUND, `${label}: the UserError doesn't say "not found"`);
    return;
  }
  const empty = value === null || value === false || (Array.isArray(value) && value.length === 0);
  assert.ok(empty, `${label}: resolved with ${JSON.stringify(value)} instead of rejecting or returning null / false / []`);
}

/** Every row of `table` that belongs to the company (the Shop row itself for "Shop"), as JSON ordered by id, for a before / after comparison. */
export async function rowsOf(table: string, shopId: string): Promise<string> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(table)) throw new Error(`rowsOf: odd table name ${table}`);
  const column = table === "Shop" ? "id" : "shopId";
  const rows = await db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}" WHERE "${column}" = $1 ORDER BY id`, shopId);
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)); // BigInt columns (PartnerLink sequence numbers) don't serialize by themselves
}

/** A company's rows in each of `tables`, keyed by table, to compare with assertUnchanged after the other company's calls. */
export async function snapshot(shopId: string, tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = await rowsOf(t, shopId);
  return out;
}

/** Fails naming the first table whose rows differ. */
export function assertUnchanged(label: string, before: Record<string, string>, after: Record<string, string>): void {
  for (const t of Object.keys(before)) assert.equal(after[t], before[t], `${label}: ${t} rows changed`);
}

let made = 0;

export type CheckCompany = { shopId: string; user: CurrentUser };

/**
 * A throwaway company with an OWNER login, made the way sign-up and Companies make one (createShopWithOwner: the
 * default checklist, the starter menu, the server's time zone). Remove it with removeCompany when done.
 */
export async function makeCompany(name: string, opts: { kind?: ShopKind; timeZone?: string | null } = {}): Promise<CheckCompany> {
  made += 1;
  const email = `check-${RUN}-${made}@stitchbench.test`;
  const shop = await createShopWithOwner({ shopName: name, name: `Check owner ${made}`, email, password: "check-pass-1234", kind: opts.kind, timeZone: opts.timeZone }, { allowReserved: true });
  const u = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, shopId: true, role: true, name: true, email: true } });
  return { shopId: shop.id, user: { id: u.id, shopId: u.shopId, role: u.role, name: u.name, email: u.email } };
}

/** Deletes the company and everything of its own (Shop cascades; tickets and stock units first, since Machine restricts them). */
export async function removeCompany(shopId: string): Promise<void> {
  await db.$transaction([
    db.ticket.deleteMany({ where: { shopId } }),
    db.stockUnit.deleteMany({ where: { shopId } }),
    db.shop.deleteMany({ where: { id: shopId } }),
  ]);
}
