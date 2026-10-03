import "server-only";
// The hub's part of moving a company (company-move-design.md section 5, package move-hub). The company keeps its id,
// which is how StitchHub knows it (shop_ref); what changes is the install that speaks for it. So:
//   - the install the company leaves asks its hub for a move token when the owner confirms the move (and again at a
//     download if it couldn't then); the token goes in the file's header (meta.hub) with the install's places in the
//     hub's feeds, and is kept sealed on the move's row so every download carries the same one; Cancel takes it back;
//   - the install the company comes to redeems it once the import has committed (POST /v1/shops/move): with its own
//     install key when it is on that hub, or without one when it is on no hub yet (the hub makes it an install and
//     answers the key, as starting a StitchHub account does); then it catches up on the company's partner messages
//     from the old install's place in the partner feed (one sequence for every install). A hub that can't be reached
//     never undoes the import: the token stays sealed on the import's row and "Re-point the hub" (Settings → Company,
//     or Companies) tries again;
//   - the old install learns it at its next sync (the hub answers its claim 410 moved: hub.ts claimShops,
//     hub-standing.ts applyMovedOut).
// An install on another hub than the file's, or a file made while the hub was down (no token), gets the reason in
// words: the hub admin's "Move this shop" is the door then.
import { db } from "@/lib/db";
import { isUserError, UserError } from "@/lib/user-error";
import { seal, unseal } from "@/lib/messaging/secrets";
import { adoptInstall, checkHubUrl, hubDefaultUrl, hubFetch, hubId, hubRequest, hubScope, hubState, hubStatus } from "@/lib/hub";
import { applyStanding, type StandingAnswer } from "@/lib/hub-standing";
import { catchUpPartnerMessages } from "@/lib/partners";
import { appName, isPlatformAdmin, programVersion, shopKindOf } from "@/lib/shops";
import { MOVE_CANCEL_PENDING, type MoveMeta } from "./format";

const field = (moveId: string) => `moveToken:${moveId}` as const;
const TOKEN = /^shm_[A-Za-z0-9_-]{20,200}$/;

type Cursors = { cursor: string | null; orderCursor: string | null; partnerCursor: string | null };
const cursorText = (v: unknown) => (typeof v === "string" && /^\d{1,20}$/.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : null);
function cursorsOf(v: unknown): Cursors {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { cursor: cursorText(o.cursor), orderCursor: cursorText(o.orderCursor), partnerCursor: cursorText(o.partnerCursor) };
}

/** A hub's address the way the program stores it, or null for one it wouldn't use. */
function hubAddress(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return checkHubUrl(url);
  } catch {
    return null;
  }
}

function why(e: unknown): string {
  if (hubStatus(e) === 404) return "this hub is too old to move a company (it doesn't know move tokens yet)";
  if (isUserError(e)) return e.message.replace(/\.$/, "");
  console.error("company move, the hub step:", e);
  return "something went wrong on the way to the hub";
}

// ---------- the install the company leaves ----------

/**
 * A move token for this company from the hub this install is on, for the move's row (moveId) or for one file (a
 * snapshot made from the command line has none, and mints none: it isn't a move). The token already sealed on the row
 * when there is one, so the owner can download the file again and get the same token; otherwise a fresh one, sealed
 * there. Null when this install is on no hub (`error` null: nothing to re-point) or the hub couldn't be asked (`error`
 * says why, and is kept on the row for the Settings card).
 */
export async function moveTokenFor(shopId: string, moveId: string): Promise<{ token: string | null; error: string | null }> {
  const st = await hubState();
  if (!st?.url || !st.installKey) return { token: null, error: null };
  const row = await db.companyMove.findFirst({ where: { id: moveId, shopId, direction: "export" }, select: { hubTokenSealed: true } });
  if (!row) return { token: null, error: null };
  const kept = unseal(row.hubTokenSealed, shopId, field(moveId));
  if (kept && TOKEN.test(kept.plain)) return { token: kept.plain, error: null };
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { name: true, doesRepair: true, sellsRetail: true } });
  if (!shop) return { token: null, error: null };
  try {
    const r = (await (
      await hubFetch(`/v1/shops/${hubId(shopId)}/move-token`, {
        method: "POST",
        json: { shopName: shop.name, kind: shopKindOf(shop), program: appName(), version: programVersion() },
        shopRef: shopId,
      })
    ).json()) as { token?: unknown };
    const token = typeof r.token === "string" && TOKEN.test(r.token) ? r.token : null;
    if (!token) throw new UserError("the hub didn't answer with a move token");
    let sealed: string | null = null;
    try {
      sealed = seal(token, shopId, field(moveId));
    } catch {
      // No key to seal it with here (a hosted server without SETTINGS_KEY): this download carries the token; another
      // download asks for a new one, which replaces it.
    }
    await db.companyMove.update({ where: { id: moveId }, data: { hubUrl: st.url, hubTokenSealed: sealed, hubError: null } });
    // A new token cancels every older one on the hub: an earlier cancel still waiting to be told is told.
    await db.companyMove.updateMany({ where: { shopId, direction: "export", hubError: MOVE_CANCEL_PENDING }, data: { hubError: null } });
    return { token, error: null };
  } catch (e) {
    const error = why(e);
    await db.companyMove.update({ where: { id: moveId }, data: { hubUrl: st.url, hubError: error.slice(0, 500) } }).catch(() => {});
    return { token: null, error };
  }
}

/** The owner cancelled the move: the hub forgets the token (best effort: a token kept there runs out in 14 days anyway). */
export async function dropMoveToken(shopId: string): Promise<void> {
  const rows = await db.companyMove.findMany({ where: { shopId, direction: "export", OR: [{ hubTokenSealed: { not: null } }, { hubUrl: { not: null } }] }, select: { id: true } });
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  await db.companyMove.updateMany({ where: { id: { in: ids } }, data: { hubTokenSealed: null } });
  const st = await hubState();
  if (!st?.url || !st.installKey) return;
  await hubFetch(`/v1/shops/${hubId(shopId)}/move-token`, { method: "DELETE", shopRef: shopId }).catch(async (e: unknown) => {
    if (hubStatus(e) === 404) return; // a hub without move tokens holds none
    // Out of reach: the next sync tells it (hub.ts claimShops), so a file made before the cancel can't take the company.
    await db.companyMove.updateMany({ where: { id: { in: ids } }, data: { hubError: MOVE_CANCEL_PENDING } });
  });
}

/**
 * The header's hub part (meta.hub), read in the export's snapshot transaction: the hub this install is on, its id there,
 * the token, and the install's places in the hub's feeds. Null for an install on no hub.
 */
export function hubPart(
  st: { url: string | null; installId: string | null; installKey: string | null; cursor: string | null; orderCursor: string | null; partnerCursor: string | null } | null,
  token: string | null,
): MoveMeta["hub"] {
  if (!st?.url || !st.installKey || !st.installId) return null;
  return { url: st.url, installId: st.installId, moveToken: token, cursor: st.cursor, orderCursor: st.orderCursor, partnerCursor: st.partnerCursor };
}

/** What the export says about the hub when the file carries no token. */
export function hubWarning(onHub: boolean, isMove: boolean, error: string | null): string | null {
  if (!onHub) return null;
  const after =
    "Until the hub is told, the company's partner links, marketplace listings and orders and shared notes stay with this install there: the StitchHub admin can move it by hand (Moves → Move this shop).";
  if (!isMove) return `This file is a copy, not a move, so it carries no StitchHub move token. ${after}`;
  return `StitchHub couldn't give a move token (${error ?? "the hub couldn't be reached"}). Download the file again once the hub answers to get one. ${after}`;
}

// ---------- the install the company comes to ----------

export type HubStep = {
  /** done: the hub has the company here; failed: try again ("Re-point the hub"); none: the company wasn't on a hub;
   * no-token: the file carries none; other-hub: this install is on another hub than the file's. */
  status: "done" | "failed" | "none" | "no-token" | "other-hub";
  message: string;
  /** Partner messages applied by the catch-up. */
  caughtUp: number;
};

type MoveAnswer = StandingAnswer & {
  ok?: boolean;
  partner?: { shopRef?: string; links?: string[] } | null;
  hubName?: string | null;
  installId?: string;
  installKey?: string;
  scope?: string;
};

async function failed(moveId: string, status: HubStep["status"], message: string, keepToken = true): Promise<HubStep> {
  await db.companyMove.update({ where: { id: moveId }, data: { hubError: message.slice(0, 1000), ...(keepToken ? {} : { hubTokenSealed: null }) } }).catch(() => {});
  return { status, message, caughtUp: 0 };
}

const AGAIN = 'press "Re-point the hub" (Settings → Company, or Companies) once it answers';

/**
 * The hub is told the company is here now, with the token; then the partner catch-up. Never throws: whatever goes
 * wrong is the step's message, and the import stands.
 */
async function repoint(shopId: string, moveId: string, url: string, token: string, cursors: Cursors): Promise<HubStep> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, doesRepair: true, sellsRetail: true } });
  if (!shop) return { status: "failed", message: "Company not found.", caughtUp: 0 };
  const st = await hubState();
  const here = st?.url && st.installKey ? hubAddress(st.url) : null;
  if (here && here !== url) {
    return failed(
      moveId,
      "other-hub",
      `StitchHub: this install is on another hub (${here}) than the one the company was on (${url}), so that hub can't be told the company is here. Its partner links, marketplace listings and shared notes stay with the old install there. Ask that hub's admin to move it by hand (Moves → Move this shop), or join that hub here and press "Re-point the hub".`,
    );
  }
  // On no hub yet, a hub named by a move file is adopted only when it is this install's own default hub: a hostile file
  // must not point the install at some other hub. Anything else: skipped, and the administrator joins from Settings.
  if (!here && url !== hubAddress(hubDefaultUrl())) {
    return failed(
      moveId,
      "other-hub",
      `StitchHub: the move file names a hub (${url}) that isn't this install's hub, and this install is on no hub yet, so it wasn't joined. The company is in; join the hub from Settings → Account (the StitchBench administrator can do it), and ask that hub's admin to move the company by hand (Moves → Move this shop) if its partner links should follow.`,
      false,
    );
  }
  const body = { shopRef: shopId, token, shopName: shop.name, kind: shopKindOf(shop), program: appName(), version: programVersion() };
  let answer: MoveAnswer;
  let joined = false;
  try {
    if (here) answer = (await (await hubFetch("/v1/shops/move", { method: "POST", json: body, shopRef: shopId })).json()) as MoveAnswer;
    else {
      // On no hub yet: the hub makes this an install of its own and answers its key once.
      answer = await hubRequest<MoveAnswer>(url, "/v1/shops/move", { json: body, key: null, shopRef: shopId });
      if (typeof answer.installId !== "string" || typeof answer.installKey !== "string") throw new UserError("the hub didn't answer with an install key");
      await adoptInstall({ url, hubName: answer.hubName ?? null, installId: answer.installId, installKey: answer.installKey, scope: hubScope(answer.scope) });
      // The partner feed carries on from the old install's place: every message before it the company had applied
      // (its PartnerSeen rows came in the file), and a new install has no other company's to miss.
      await db.hubState.update({ where: { id: 1 }, data: { partnerCursor: cursors.partnerCursor ?? "0" } });
      joined = true;
    }
  } catch (e) {
    const status = hubStatus(e);
    const reason = why(e);
    // A token the hub won't take again (used by another install, replaced, cancelled, expired, wrong) isn't kept.
    const forGood = status === 404 || status === 409 || status === 410;
    return failed(
      moveId,
      "failed",
      forGood
        ? `StitchHub refused the move: ${reason}. The company is in; its partner links, listings and shared notes stay with the old install on the hub until the hub admin moves it by hand (Moves → Move this shop).`
        : `StitchHub couldn't be told the company is here yet: ${reason}. The company is in; its partner links, listings and shared notes stay with the old install on the hub until then: ${AGAIN}.`,
      !forGood,
    );
  }
  await applyStanding(shopId, answer);
  // The partner messages that came for the company after the move file was made, from the old install's place. A new
  // install's own sync starts there anyway.
  let caughtUp = 0;
  const links = Array.isArray(answer.partner?.links) ? answer.partner.links.length : 0;
  if (!joined && links && cursors.partnerCursor) {
    try {
      caughtUp = await catchUpPartnerMessages(shopId, cursors.partnerCursor);
    } catch (e) {
      // The hub has the company here; only the catch-up is left. The token stays: the hub answers the same install the
      // same way again, and the catch-up runs then.
      return failed(moveId, "failed", `StitchHub has the company here now, but its partners' messages since the move file was made couldn't be fetched yet (${why(e)}): ${AGAIN}.`);
    }
  }
  await db.companyMove.update({ where: { id: moveId }, data: { hubDoneAt: new Date(), hubError: null, hubTokenSealed: null } });
  const name = answer.hubName ?? st?.hubName ?? "StitchHub";
  return {
    status: "done",
    message: `StitchHub (${name}) has the company here now${joined ? ", and this install joined it" : ""}: its partner links, marketplace listings and orders, ratings and shared notes follow it, and its partner shops see nothing change.${caughtUp ? ` ${caughtUp === 1 ? "1 partner message" : `${caughtUp} partner messages`} sent after the move file was made ${caughtUp === 1 ? "was" : "were"} applied.` : ""} Listings and orders show here after the next sync.`,
    caughtUp,
  };
}

/**
 * After the import has committed (import.ts): the file's hub part goes on the company's import row (the token sealed,
 * the old install's places in the feeds) and the hub is told. Never throws.
 */
export async function hubStepAfterImport(shopId: string, moveId: string, meta: MoveMeta): Promise<HubStep> {
  try {
    const hub = meta.hub && typeof meta.hub === "object" ? meta.hub : null;
    if (!hub) {
      await db.companyMove.update({ where: { id: moveId }, data: { hubCursors: {} } });
      return { status: "none", message: "StitchHub: the company wasn't on a hub where it came from, so there is nothing to re-point.", caughtUp: 0 };
    }
    const url = hubAddress(hub.url);
    const cursors = cursorsOf(hub);
    const token = typeof hub.moveToken === "string" && TOKEN.test(hub.moveToken) ? hub.moveToken : null;
    let sealed: string | null = null;
    if (token) {
      try {
        sealed = seal(token, shopId, field(moveId));
      } catch {
        // No key to keep it with (hosted without SETTINGS_KEY): this first try has it; a retry would need the hub admin.
      }
    }
    await db.companyMove.update({ where: { id: moveId }, data: { hubUrl: url, hubTokenSealed: sealed, hubCursors: cursors } });
    if (!url)
      return failed(moveId, "failed", `StitchHub: the move file names a hub address this program won't use (${String(hub.url).slice(0, 100)}); ask the hub admin to move the company by hand.`, false);
    if (!token) {
      return failed(
        moveId,
        "no-token",
        `StitchHub: the move file carries no move token (the hub couldn't give one when it was made, or the file is a copy rather than a move). Until the hub is told, the company's partner links, marketplace listings and shared notes stay with the old install there: ask the StitchHub admin to move it by hand (Moves → Move this shop).`,
        false,
      );
    }
    return await repoint(shopId, moveId, url, token, cursors);
  } catch (e) {
    return failed(moveId, "failed", `StitchHub couldn't be told the company is here yet: ${why(e)}. ${AGAIN[0].toUpperCase()}${AGAIN.slice(1)}.`);
  }
}

/** none: the company was on no hub where it came from (nothing to re-point, nothing to show). */
export type HubMoveView = { moveId: string; url: string | null; doneAt: Date | null; error: string | null; canRetry: boolean; none: boolean } | null;

/** The newest import of this company and how its hub step stands, for Settings → Company and Companies. */
export async function hubMoveView(shopId: string): Promise<HubMoveView> {
  const rows = await db.companyMove.findMany({ where: { shopId, direction: "import" }, orderBy: { startedAt: "desc" }, take: 5 });
  // The company's own import row (the one the hub step writes to), not an upload the administrator made from here.
  const row = rows.find((r) => r.hubCursors != null);
  if (!row) return null;
  return { moveId: row.id, url: row.hubUrl, doneAt: row.hubDoneAt, error: row.hubError, canRetry: !row.hubDoneAt && !!row.hubTokenSealed, none: !row.hubUrl && !row.hubError && !row.hubDoneAt };
}

/**
 * "Re-point the hub": the hub step again, with the token kept on the company's import row. The company's owner, or
 * the StitchBench administrator; anyone else gets "Company not found.".
 */
export async function repointHubFor(user: { shopId: string; role: string; email: string }, shopId: string): Promise<HubStep> {
  const allowed = (user.shopId === shopId && user.role === "OWNER") || isPlatformAdmin(user.email);
  const shop = allowed ? await db.shop.findUnique({ where: { id: shopId }, select: { id: true } }) : null;
  if (!shop) throw new UserError("Company not found.");
  const rows = await db.companyMove.findMany({ where: { shopId, direction: "import" }, orderBy: { startedAt: "desc" }, take: 5 });
  const row = rows.find((r) => r.hubCursors != null);
  if (!row) throw new UserError("This company didn't come here from a move file, so there is no hub step to do.");
  if (row.hubDoneAt) return { status: "done", message: "StitchHub already has the company here.", caughtUp: 0 };
  if (!row.hubUrl) throw new UserError("The move file named no hub, so there is nothing to re-point.");
  const token = unseal(row.hubTokenSealed, shopId, field(row.id));
  if (!token) {
    throw new UserError(row.hubError ?? "There is no move token to send: the file carried none, or the hub refused it. Ask the StitchHub admin to move the company by hand (Moves → Move this shop).");
  }
  const step = await repoint(shopId, row.id, row.hubUrl, token.plain, cursorsOf(row.hubCursors));
  if (step.status !== "done") throw new UserError(step.message);
  return step;
}
