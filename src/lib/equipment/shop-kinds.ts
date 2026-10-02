import "server-only";
// A shop's own equipment kinds ("What you repair", modules-design.md 11.2): add, change, switch on or off, and which
// kind check-in opens on. Bodies with a user; src/actions/equipment.ts adds requireAdmin and the revalidation.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { str } from "@/lib/format";
import { requireModule } from "@/lib/modules";
import type { CurrentUser } from "@/lib/session";
import { cleanFieldDefs } from "./form";
import { builtInKind } from "./index";
import { readAccessoryBox, readListBox, readQuestionRows, slug } from "./lines";
import { usableKind } from "./shop";

const KEY = /^[a-z0-9-]{1,40}$/;

/**
 * Saves a kind of this company's: `key` null adds one (its key is the slug of the label), a key the company has
 * changes that row, and a key it doesn't have yet makes a row for this company only. Returns the key.
 */
export async function saveEquipmentKindFor(user: CurrentUser, key: string | null, fd: FormData): Promise<string> {
  const shopId = user.shopId;
  await requireModule(user, "appliance");
  const label = str(fd.get("label"))?.slice(0, 80);
  if (!label) throw new UserError("Give the kind a name, e.g. \"Espresso machine\".");
  const noun = str(fd.get("noun"))?.slice(0, 80) ?? null;
  const row = key ? await db.shopEquipmentKind.findFirst({ where: { shopId, key } }) : null;
  const newKey = row ? row.key : key ?? slug(label);
  if (!row) {
    if (!KEY.test(newKey)) throw new UserError("A kind's key is lower-case letters, digits and dashes.");
    if (builtInKind(newKey)) throw new UserError("That name is one of the built-in kinds. Pick another.");
    const clash = await db.shopEquipmentKind.findFirst({ where: { shopId, OR: [{ key: newKey }, { label: { equals: label, mode: "insensitive" } }] }, select: { id: true } });
    if (clash) throw new UserError(`You already have a kind called ${label}.`);
  } else if (label.toLowerCase() !== row.label.toLowerCase()) {
    const clash = await db.shopEquipmentKind.findFirst({ where: { shopId, id: { not: row.id }, label: { equals: label, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new UserError(`You already have a kind called ${label}.`);
  }
  const { accessories, defaultChecked } = readAccessoryBox(str(fd.get("accessories")));
  const data = {
    label,
    noun,
    types: readListBox(str(fd.get("types")), 30),
    brands: readListBox(str(fd.get("brands")), 100),
    accessories,
    defaultChecked,
    checklist: readListBox(str(fd.get("checklist")), 60),
    intakeFields: readQuestionRows(fd, row ? cleanFieldDefs(row.intakeFields) : []) as unknown as Prisma.InputJsonValue,
    active: fd.has("active") ? String(fd.get("active")) === "on" || String(fd.get("active")) === "true" : (row?.active ?? true),
  };
  if (row) {
    await db.shopEquipmentKind.updateMany({ where: { id: row.id, shopId }, data });
  } else {
    const sortOrder = await db.shopEquipmentKind.count({ where: { shopId } });
    await db.shopEquipmentKind.create({ data: { shopId, key: newKey, equipment: "APPLIANCE", sortOrder, ...data } });
  }
  return newKey;
}

/** A kind with open tickets can be made inactive: it disappears from check-in, and its tickets keep rendering. */
export async function setKindActiveFor(user: CurrentUser, key: string, active: boolean): Promise<void> {
  await requireModule(user, "appliance");
  const r = await db.shopEquipmentKind.updateMany({ where: { shopId: user.shopId, key }, data: { active } });
  if (!r.count) throw new UserError("Kind not found.");
}

/** "Check-in opens on": one of the kinds the company can check in. */
export async function saveCheckInKindFor(user: CurrentUser, fd: FormData): Promise<void> {
  const key = str(fd.get("checkInKind"));
  if (!key || !(await usableKind(user.shopId, key))) throw new UserError("Pick one of the kinds you can check in.");
  await db.shop.update({ where: { id: user.shopId }, data: { checkInKind: key } });
}
