// The move file (company-move-design.md section 8): streamed straight from the database as the owner's browser downloads
// it (nothing spooled, nothing to delete). For the owner of the company (or the StitchBench administrator), signed in,
// and only over https or on the program's own PC: the file is the shop, every login's hash included. The move record
// named in the address must be one of the signed-in company's own.
import { sessionUser } from "@/lib/session";
import { db } from "@/lib/db";
import { exportCompany } from "@/lib/move/export";
import { secureRequest } from "@/lib/move/http";
import { isPlatformAdmin } from "@/lib/shops";
import { isUserError } from "@/lib/user-error";
import { secureAddress } from "@/lib/secure-address";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (user.role !== "OWNER" && !isPlatformAdmin(user.email)) return new Response("Only the shop owner can download the move file.", { status: 403 });
  if (!secureRequest(req)) {
    const https = secureAddress();
    return new Response(`The move file holds everything the shop holds, so it is downloaded only over https or on the program's own PC.${https ? ` Open ${https} and try again.` : ""}`, {
      status: 403,
    });
  }
  const { id } = await params;
  const move = await db.companyMove.findFirst({ where: { id, direction: "export", shopId: isPlatformAdmin(user.email) ? undefined : user.shopId }, select: { id: true, shopId: true, status: true } });
  if (!move || move.status === "cancelled") return new Response("Move not found.", { status: 404 });
  try {
    const { stream, fileName } = await exportCompany(user, move.shopId, { moveId: move.id });
    return new Response(stream, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (isUserError(e)) return new Response(e.message, { status: 404 });
    throw e;
  }
}
