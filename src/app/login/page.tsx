import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import Link from "next/link";
import { signIn } from "@/auth";
import { appName } from "@/lib/shops";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const shopApp = appName() === "StitchShop";

  async function login(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: "/",
      });
    } catch (e) {
      if (e instanceof AuthError) redirect("/login?error=1");
      throw e;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={login} className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">
            Stitch<span className="text-thread">{shopApp ? "Shop" : "Bench"}</span>
          </div>
          <p className="muted text-sm">{shopApp ? "Sign in to your shop." : "Sign in to your repair bench."}</p>
        </div>
        {error && (
          <p className="pill tone-bad" role="alert">
            Email or password is wrong.
          </p>
        )}
        <div className="field">
          <label htmlFor="email" className="label">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="email" required className="input" />
        </div>
        <div className="field">
          <label htmlFor="password" className="label">
            Password
          </label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
        </div>
        <button className="btn btn-primary w-full">Sign in</button>
        {process.env.ALLOW_SIGNUP === "true" && (
          <p className="muted text-center text-sm">
            New shop?{" "}
            <Link href="/signup" className="link">
              Create an account
            </Link>
          </p>
        )}
      </form>
    </div>
  );
}
