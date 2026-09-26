import { timingSafeEqual } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { signIn } from "@/auth";
import { appName, createShopWithOwner, defaultShopKind, type ShopKind } from "@/lib/shops";
import { redeemPartnerCode } from "@/lib/partners";
import { UserError } from "@/lib/action";

/**
 * The Windows program's first run passes SETUP_TOKEN: sign-up then only works from the program's own window (it opens
 * /signup?setup=<token>), and only for the first company. Another device on the shop network can't claim the install.
 */
function setupOk(given: unknown) {
  const want = process.env.SETUP_TOKEN;
  if (!want) return true;
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Lets another repair shop create its own account. Off unless ALLOW_SIGNUP=true.
export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string; setup?: string }> }) {
  const { error, setup } = await searchParams; // read first so the page renders per request, not at build time
  if (process.env.ALLOW_SIGNUP !== "true" || !setupOk(setup)) notFound();

  async function create(fd: FormData) {
    "use server";
    if (process.env.ALLOW_SIGNUP !== "true" || !setupOk(fd.get("setup"))) notFound();
    const firstOnly = !!process.env.SETUP_TOKEN;
    const back = (e: string) => `/signup?error=${e}${firstOnly ? `&setup=${encodeURIComponent(String(fd.get("setup")))}` : ""}`;
    const shopName = String(fd.get("shop") ?? "").trim();
    const name = String(fd.get("name") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const password = String(fd.get("password") ?? "");
    if (!shopName || !name || !email || password.length < 8) redirect(back("missing"));
    if (await db.user.findUnique({ where: { email } })) redirect(back("taken"));
    const kind = (String(fd.get("kind") ?? "repair") || "repair") as ShopKind;
    let shop: { id: string; name: string };
    try {
      shop = await createShopWithOwner({ shopName, name, email, password, kind }, { firstOnly });
    } catch (e) {
      // The first company already exists (this install's sign-up is closed), or the email was just taken.
      if (e instanceof UserError) redirect(firstOnly ? "/login" : back("taken"));
      throw e;
    }
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
        {setup && <input type="hidden" name="setup" value={setup} />}
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
