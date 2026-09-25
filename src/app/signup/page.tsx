import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { signIn } from "@/auth";
import { appName, createShopWithOwner, defaultShopKind, type ShopKind } from "@/lib/shops";
import { redeemPartnerCode } from "@/lib/partners";

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
    const kind = (String(fd.get("kind") ?? "repair") || "repair") as ShopKind;
    const shop = await createShopWithOwner({ shopName, name, email, password, kind });
    // A partner code from the repair shop (or sewing shop) connects the two right away.
    const code = String(fd.get("partnerCode") ?? "").trim();
    let next = kind === "retail" ? "/register" : "/settings";
    if (code) {
      try {
        await redeemPartnerCode(shop.id, shop.name, email, code);
        next = "/partners";
      } catch (e) {
        next = `/partners?error=${encodeURIComponent(e instanceof Error ? e.message : "That partner code didn't work.")}`;
      }
    }
    await signIn("credentials", { email, password, redirectTo: next });
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form action={create} className="card card-pad w-full max-w-sm space-y-4">
        <div className="text-2xl font-bold tracking-tight">
          Stitch<span className="text-thread">{appName() === "StitchShop" ? "Shop" : "Bench"}</span>
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
        <div className="field">
          <label htmlFor="kind" className="label">
            What kind of shop
          </label>
          <select id="kind" name="kind" className="select" defaultValue={defaultShopKind()}>
            <option value="repair">Repair shop</option>
            <option value="retail">Sewing / quilt shop (register, inventory, repairs sent out)</option>
            <option value="both">Both: we repair and sell over the counter</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="partnerCode" className="label">
            Partner code from your repair shop (optional)
          </label>
          <input id="partnerCode" name="partnerCode" autoComplete="off" className="input mono" placeholder="7KQP-M2XH-9TRD" />
        </div>
        <button className="btn btn-primary w-full">Create shop</button>
      </form>
    </div>
  );
}
