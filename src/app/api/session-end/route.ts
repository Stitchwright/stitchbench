import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { sessionUser } from "@/lib/session";

// A session whose access was removed (or whose password changed) lands here: clear the cookie, then sign in again.
// Only for a session that really has ended (requireUser sends those here). A plain link or page on another site can send
// anyone's browser to this address, so a working session is never signed out by it: it goes on to the dashboard.
export async function GET() {
  if (await sessionUser()) redirect("/");
  await signOut({ redirectTo: "/login?ended=1" });
}
