import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { signIn } from "@/auth";
import { createShopWithOwner } from "@/lib/shops";

// Lets another repair shop create its own account. Off unless ALLOW_SIGNUP=true.
export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams; // read first so the page renders per request, not at build time
  if (process.env.ALLOW_SIGNUP !== "true") notFound();

  async function create(fd: FormData) {
    "use server";
    if (process.env.ALLOW_SIGNUP !== "true") notFound();
    const shopName = String(fd.get("shop") ?? "").trim();
    const name = String(fd.get("name") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const password = String(fd.get("password") ?? "");
    if (!shopName || !name || !email || password.length < 8) redirect("/signup?error=missing");
    if (await db.user.findUnique({ where: { email } })) redirect("/signup?error=taken");
    await createShopWithOwner({ shopName, name, email, password });
    await signIn("credentials", { email, password, redirectTo: "/settings" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={create} className="card card-pad w-full max-w-sm space-y-4">
        <div className="text-2xl font-bold tracking-tight">
          Stitch<span className="text-thread">Bench</span>
        </div>
        {error && (
          <p className="pill tone-bad" role="alert">
            {error === "taken" ? "That email already has an account." : "Fill in every field; password 8+ characters."}
          </p>
        )}
        {[
          ["shop", "Shop name", "text"],
          ["name", "Your name", "text"],
          ["email", "Email", "email"],
          ["password", "Password (8+ characters)", "password"],
        ].map(([k, label, type]) => (
          <div key={k} className="field">
            <label htmlFor={k} className="label">
              {label}
            </label>
            <input id={k} name={k} type={type} required className="input" />
          </div>
        ))}
        <button className="btn btn-primary w-full">Create shop</button>
      </form>
    </div>
  );
}
