// The Windows program's door for a move file (company-move-design.md section 8; why and how it is safe: src/lib/move/
// local.ts). desktop/main.mjs posts { path } with a one-use token (x-move-token) for the file the tray's dialog picked;
// the server reads the file from disk and imports it in the background. Answers { job }: the window shows /move-in/<job>.
import { DOOR_SHUT, startPcImport } from "@/lib/move/local";
import { localRequest } from "@/lib/move/http";
import { isUserError } from "@/lib/user-error";

export async function POST(req: Request) {
  if (!process.env.MOVE_LOCAL_SECRET || !localRequest(req)) return Response.json({ error: DOOR_SHUT }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  try {
    const job = await startPcImport(body?.path, req.headers.get("x-move-token"));
    return Response.json({ job });
  } catch (e) {
    if (!isUserError(e)) throw e;
    return Response.json({ error: e.message }, { status: e.message === DOOR_SHUT ? 403 : 400 });
  }
}
