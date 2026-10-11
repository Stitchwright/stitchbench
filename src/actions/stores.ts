"use server";

// More than one store (shop-features-round-2-design.md section 7): Settings -> Stores, the store this device is at, the
// manager's approval code, and approvals for a refund or discount over a store's limit (7.5).
import { revalidatePath } from "next/cache";
import { noted, safe, shownOnce, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { str } from "@/lib/format";
import { addStoreFor, pickStoreFor, saveDailySummaryFor, saveStoreFor, setHomeStoreFor, setOnlineStoreFor, setStoreOpenFor } from "@/lib/stores-admin";
import { approvalState, approveWithCodeFor, askOwnerFor, decideApprovalFor, setApproveCodeFor } from "@/lib/approvals";
import { currentStore } from "@/lib/stores";
import { claimShopNow } from "@/lib/hub";
import { joinCompanyFor, makeJoinCodeFor } from "@/lib/join-companies";

const refresh = () => revalidatePath("/", "layout");

/** The hub learns the new store count now (extra stores are billed); a hub that isn't there is told at the next sync. */
async function tellHub(shopId: string) {
  await Promise.race([claimShopNow(shopId).catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
}

export const addStore = safe(async function addStore(formData: FormData) {
  const user = await requireUser();
  const s = await addStoreFor(user, formData);
  await tellHub(user.shopId);
  refresh();
  return noted(`${s.name} added. Pick it on that store's computer (top of the menu), and give the people who work there their home store below.`);
});

export const saveStore = safe(async function saveStore(id: string, formData: FormData) {
  const user = await requireUser();
  await saveStoreFor(user, String(id), formData);
  refresh();
});

export const setStoreOpen = safe(async function setStoreOpen(id: string, open: boolean) {
  const user = await requireUser();
  await setStoreOpenFor(user, String(id), open === true);
  await tellHub(user.shopId);
  refresh();
});

export const setHomeStore = safe(async function setHomeStore(userId: string, formData: FormData) {
  const user = await requireUser();
  await setHomeStoreFor(user, String(userId), String(formData.get("locationId") ?? ""));
  refresh();
});

export const setOnlineStore = safe(async function setOnlineStore(formData: FormData) {
  const user = await requireUser();
  await setOnlineStoreFor(user, String(formData.get("locationId") ?? ""));
  refresh();
});

export const saveDailySummary = safe(async function saveDailySummary(formData: FormData) {
  const user = await requireUser();
  await saveDailySummaryFor(user, formData.get("on") === "on");
  refresh();
});

/** "This computer is at": the store this device works at. */
export const pickStore = safe(async function pickStore(formData: FormData) {
  const user = await requireUser();
  const name = await pickStoreFor(user, String(formData.get("locationId") ?? ""));
  refresh();
  return noted(`This computer is at ${name} now.`);
});

export const saveApproveCode = safe(async function saveApproveCode(formData: FormData) {
  const user = await requireUser();
  const code = str(formData.get("code"));
  if (formData.get("clear") === "on") await setApproveCodeFor(user, null);
  else if (!code) throw new UserError("Type the code: 4 to 8 numbers.");
  else await setApproveCodeFor(user, code);
  refresh();
});

/** The register: a manager there types her code. Returns the approval's id for the sale. */
export const approveWithCode = safe(async function approveWithCode(need: unknown, code: string, reason: string, draft: unknown) {
  const user = await requireUser();
  const id = await approveWithCodeFor(user, await currentStore(user), need, String(code ?? ""), str(reason), draft);
  return noted(id);
});

/** The register: "Ask the owner". Returns the approval's id; the register waits on approvalStatus. */
export const askOwner = safe(async function askOwner(need: unknown, reason: string, draft: unknown) {
  const user = await requireUser();
  const r = await askOwnerFor(user, await currentStore(user), need, str(reason), draft);
  return noted(`${r.id}|${r.told}`);
});

/** Where an asked approval stands (the register asks every few seconds): "APPROVED|by" and so on. */
export const approvalStatus = safe(async function approvalStatus(id: string) {
  const user = await requireUser();
  const s = await approvalState(user, String(id));
  return noted(`${s.status}|${s.by ?? ""}|${s.note ?? ""}`);
});

/** The owner's answer from her phone. */
export const decideApproval = safe(async function decideApproval(id: string, yes: boolean, formData?: FormData) {
  const user = await requireUser();
  await decideApprovalFor(user, String(id), yes === true, formData ? str(formData.get("note")) : null);
  refresh();
});

/** "Join this company into another of yours" (7.6): a one-time join code, shown once, to type into the other company. */
export const makeJoinCode = safe(async function makeJoinCode() {
  const r = await makeJoinCodeFor(await requireUser());
  return shownOnce(r.code);
});

/** "Join another company into this one" (7.6): the owner types the join code she made in the other company and its name. */
export const joinCompany = safe(async function joinCompany(formData: FormData) {
  const user = await requireUser();
  const r = await joinCompanyFor(user, String(formData.get("code") ?? ""), String(formData.get("confirm") ?? ""), str(formData.get("storeName")));
  await tellHub(user.shopId);
  refresh();
  const bits = [`Joined in as the ${r.storeName} store.`];
  if (r.renumbered) bits.push(`${r.renumbered} tickets, sales and orders were numbered on from this company's.`);
  if (r.renamedItems) bits.push(`${r.renamedItems} item numbers both used now end in (${r.storeName}).`);
  if (r.loginsOff) bits.push(`${r.loginsOff} ${r.loginsOff === 1 ? "login" : "logins"} both had were kept for the history and switched off.`);
  if (r.maybeSame.length) bits.push(`${r.maybeSame.length} customers may be the same person at both: see the list below.`);
  return noted(bits.join(" "));
});
