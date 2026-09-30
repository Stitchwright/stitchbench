import { db } from "@/lib/db";

// The host's health check (railway.json): 200 once the server is up and the database answers. A release that fails
// on start (a migration that can't apply) never gets here, so the host keeps the previous version running. Open to
// everyone on purpose (the proxy skips /api) and it says nothing about the data.
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
