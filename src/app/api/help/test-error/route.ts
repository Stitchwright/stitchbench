// Test only (tests/help.spec.ts): runs an action that fails like a fault in the program, so the spec sees the error alert
// reach the hub once, counted. Answers 404 unless the server was started with HELP_TEST_ERRORS=1.
import { helpTestError } from "@/actions/help";
import { sessionUser } from "@/lib/session";

export async function POST(req: Request) {
  if (process.env.HELP_TEST_ERRORS !== "1") return new Response("Not found", { status: 404 });
  if (!(await sessionUser())) return new Response("Sign in first", { status: 401 });
  try {
    await helpTestError(new URL(req.url).searchParams.get("tag") ?? "x");
  } catch {
    return Response.json({ ok: false, thrown: true }, { status: 500 });
  }
  return Response.json({ ok: true });
}
