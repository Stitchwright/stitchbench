// The Windows program's door for removing the old copy of a company that moved (company-move-design.md section 7,
// package move-hub): the tray's "Remove the moved company..." posts { shopId, name } with a one-use token made by the
// program itself for that company (x-move-token: the same HMAC as the move file's door, src/lib/move/local.ts, over
// "remove:<shopId>"), addressed to the PC itself. The rules are deleteMovedCompany's: moved, 30 days on, the name as it is.
import { DOOR_SHUT, takeMoveToken } from "@/lib/move/local";
import { localRequest } from "@/lib/move/http";
import { deleteMovedCompany } from "@/lib/move/old-copy";
import { isUserError } from "@/lib/user-error";

export async function POST(req: Request) {
  if (!process.env.MOVE_LOCAL_SECRET || !localRequest(req)) return Response.json({ error: DOOR_SHUT }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { shopId?: unknown; name?: unknown } | null;
  const shopId = typeof body?.shopId === "string" ? body.shopId : "";
  if (!shopId || !takeMoveToken(req.headers.get("x-move-token"), `remove:${shopId}`)) return Response.json({ error: DOOR_SHUT }, { status: 403 });
  try {
    return Response.json(await deleteMovedCompany("operator", shopId, body?.name));
  } catch (e) {
    if (!isUserError(e)) throw e;
    return Response.json({ error: e.message }, { status: 400 });
  }
}
