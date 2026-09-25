import { auth } from "@/auth";
import { libraryDir } from "@/lib/library-dir";

// Tells the browser whether the shop PC serves the manual library (desktop program) or each PC uses its own folder.
export async function GET() {
  const session = await auth();
  if (!session?.user?.shopId) return Response.json({ enabled: false }, { status: 401 });
  return Response.json({ enabled: libraryDir() != null });
}
