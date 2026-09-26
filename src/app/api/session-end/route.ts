import { signOut } from "@/auth";

// A session whose access was removed (or whose password changed) lands here: clear the cookie, then sign in again.
export async function GET() {
  await signOut({ redirectTo: "/login?ended=1" });
}
