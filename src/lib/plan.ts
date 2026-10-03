import "server-only";
// The login plan (pricing-recommendation.md sections 12 and 13, decided 3 Oct 2026): Solo, up to two people signed in,
// or Shop, everyone; the same features on both. StitchHub names it in the key it signs for the program itself (payload
// `l`, and `fs` for a founding shop's price; the standing's `plan` says the same in words), so it holds offline and only
// the hub can set it. No plan known means no limit (fail open): no key at all (never joined a hub, offline from the
// start), a key from a hub before plans, an emailed key or the hosted administrator's switch.
//
// On Solo, adding a third active login, or restoring one, is refused with SOLO_FULL. A company already over two (it
// moved down from Shop) is never locked out: everyone keeps working, and the owner sees a notice on Settings → People.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { loginPlanOf, type LoginPlan } from "@/lib/license";
import { getModules, verifyFor } from "@/lib/modules";
import { isPlatformAdmin } from "@/lib/shops";
import { UserError } from "@/lib/user-error";

export const SOLO_LOGINS = 2;
export const SOLO_FULL = "The Solo plan includes two people signed in. Switch to the Shop plan on your StitchHub account to add more: Settings → Account.";

export type CompanyPlan = {
  plan: LoginPlan;
  /** The key's own plan letter: m monthly, y yearly, t trial, w free while partnered, c comped. */
  keyPlan: string;
  founding: boolean;
};

/**
 * The login plan of the key the company runs on (the one that decides the program's own standing), or null when that
 * key names none, or there is no key.
 */
export async function companyPlan(shopId: string): Promise<CompanyPlan | null> {
  const base = (await getModules(shopId)).states.base;
  if (base.status === "off" || base.source !== "key" || !base.keyId) return null;
  const row = await db.license.findUnique({ where: { shopId_keyId: { shopId, keyId: base.keyId } }, select: { key: true } });
  if (!row) return null;
  const v = verifyFor(row.key, "pasted");
  if (!v.ok || v.payload.s !== shopId) return null;
  const plan = loginPlanOf(v.payload);
  return plan ? { plan, keyPlan: v.payload.p, founding: v.payload.fs === true } : null;
}

/** "Solo (up to two people signed in), yearly, founding-shop price": the plan as Settings → Account shows it. */
export function planWords(p: CompanyPlan): string {
  const name = p.plan === "solo" ? "Solo (up to two people signed in)" : "Shop (everyone at the shop)";
  const how: Record<string, string> = { m: "monthly", y: "yearly", t: "free trial", w: "free while partnered", c: "free, with the hub admin's compliments" };
  return [name, how[p.keyPlan] ?? null, p.founding ? "founding-shop price" : null].filter(Boolean).join(", ");
}

type Client = Prisma.TransactionClient | typeof db;

/** The people who can sign in to the company: its active logins, not counting the StitchBench administrator's own. */
export async function activeLogins(shopId: string, client: Client = db): Promise<number> {
  const users = await client.user.findMany({ where: { shopId, active: true }, select: { email: true } });
  return users.filter((u) => !isPlatformAdmin(u.email)).length;
}

/**
 * Runs `write` (a login added, or one restored) where the plan allows it. On Solo it runs in a transaction that holds
 * the company's row first, so two people added at once can't both slip in, and refuses a third active login with
 * SOLO_FULL. On Shop, or with no plan known, it just runs.
 */
export async function withLoginRoom<T>(shopId: string, write: (tx: Client) => Promise<T>): Promise<T> {
  const plan = await companyPlan(shopId);
  if (plan?.plan !== "solo") return write(db);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Shop" WHERE id = ${shopId} FOR UPDATE`;
    if ((await activeLogins(shopId, tx)) >= SOLO_LOGINS) throw new UserError(SOLO_FULL);
    return write(tx);
  });
}

export type LoginNotice = {
  plan: CompanyPlan | null;
  /** Active logins now (the administrator's own not counted). */
  active: number;
  /** Solo with more than two: everyone keeps working, nobody else can be added or restored. */
  over: boolean;
  /** Solo with exactly two: the next one needs Shop. */
  full: boolean;
};

/** What Settings → People tells the owner about the plan's logins. */
export async function loginNotice(shopId: string): Promise<LoginNotice> {
  const [plan, active] = await Promise.all([companyPlan(shopId), activeLogins(shopId)]);
  const solo = plan?.plan === "solo";
  return { plan, active, over: solo && active > SOLO_LOGINS, full: solo && active === SOLO_LOGINS };
}
