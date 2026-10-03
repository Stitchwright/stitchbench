// The hosted Companies page's "Import a company" (company-move-design.md section 8): POST { name, size } starts an
// upload, or finds the one already part way for the same file, and answers it ({ id, received, ... }). The parts go to
// /api/move/upload/{id}/{n}, then POST /api/move/upload/{id} imports. The StitchBench administrator only.
import { startUpload } from "@/lib/move/upload";
import { importer, json, refused } from "@/lib/move/routes";

export async function POST(req: Request) {
  const user = await importer(req);
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as { name?: unknown; size?: unknown } | null;
  try {
    return json(await startUpload(user, body ?? {}));
  } catch (e) {
    return refused(e);
  }
}
