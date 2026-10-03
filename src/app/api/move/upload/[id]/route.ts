// One hosted upload (company-move-design.md section 8): GET its state (the upload, then the import's progress and its
// summary), POST to import it once every part is here (or again after a refusal, from the same file), DELETE to
// discard it and its file. The StitchBench administrator's own uploads only; another's is 404.
import { discardUpload, finishUpload, uploadView } from "@/lib/move/upload";
import { importer, json, refused } from "@/lib/move/routes";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const user = await importer(req);
  if (user instanceof Response) return user;
  try {
    return json(await uploadView(user, (await params).id));
  } catch (e) {
    return refused(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const user = await importer(req);
  if (user instanceof Response) return user;
  try {
    return json(await finishUpload(user, (await params).id));
  } catch (e) {
    return refused(e);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const user = await importer(req);
  if (user instanceof Response) return user;
  try {
    await discardUpload(user, (await params).id);
    return json({ ok: true });
  } catch (e) {
    return refused(e);
  }
}
