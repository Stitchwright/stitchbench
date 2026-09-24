import Link from "next/link";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { Nav } from "@/components/nav";
import { signOut } from "@/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const shop = await db.shop.findUnique({ where: { id: user.shopId }, select: { name: true } });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="no-print border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:block md:py-5">
          <Link href="/" className="block">
            <div className="text-lg font-bold tracking-tight">
              Stitch<span className="text-thread">Bench</span>
            </div>
            <div className="muted truncate text-xs">{shop?.name}</div>
          </Link>
        </div>
        <form action="/search" className="px-4 pb-3">
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <input id="q" name="q" className="input text-sm" placeholder="Serial, model, customer, ticket #" />
        </form>
        <Nav />
        <div className="hidden px-4 py-4 text-xs md:block">
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
