import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { Nav } from "@/components/nav";
import { signOut } from "@/auth";
import { isPlatformAdmin } from "@/lib/shops";
import { hubOfflineSince } from "@/lib/hub";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [shop, hub, retailPartners] = await Promise.all([
    db.shop.findUnique({ where: { id: user.shopId }, select: { name: true, doesRepair: true, sellsRetail: true } }),
    db.hubState.findUnique({ where: { id: 1 }, select: { discordUrl: true, installKey: true, scope: true } }),
    db.partnerLink.count({ where: { shopId: user.shopId, side: "retail" } }),
  ]);
  const doesRepair = shop?.doesRepair ?? true;
  // The hub stopped answering (the internet is down, most likely): say so once, quietly. Everything local keeps working.
  const offline = hub?.installKey ? hubOfflineSince() : null;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="no-print border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:overflow-y-auto md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:block md:py-5">
          <Link href="/" className="block">
            <div className="text-lg font-bold tracking-tight">
              Stitch<span className="text-thread">{doesRepair ? "Bench" : "Shop"}</span>
            </div>
            <div className="muted truncate text-xs">{shop?.name}</div>
          </Link>
        </div>
        <form action="/search" className="px-4 pb-3">
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <input id="q" name="q" className="input text-sm" placeholder={doesRepair ? "Serial, model, customer, ticket #" : "Customer, item, tag #"} />
        </form>
        <Nav
          platformAdmin={isPlatformAdmin(user.email)}
          chatUrl={hub?.installKey && hub.scope !== "partner" ? hub.discordUrl : null}
          doesRepair={doesRepair}
          sellsRetail={shop?.sellsRetail ?? false}
          retailPartners={retailPartners > 0}
        />
        {offline && (
          <div className="px-4 pb-2">
            <span className="pill tone-wait text-xs" title="Sharing, the marketplace and messages to partner shops wait until the connection is back. Tickets, the register, customers and parts work as usual.">
              Offline since {new Date(offline).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        )}
        {/* On phones too: a shared counter tablet or a tech's phone must be able to sign out. */}
        <div className="px-4 py-2 text-xs md:py-4">
          <div className="muted">Signed in as {user.name}</div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="link mt-1 text-xs">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
