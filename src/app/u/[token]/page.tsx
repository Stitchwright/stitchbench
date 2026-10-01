// The unsubscribe page a marketing email links to (scheduling-messaging-design.md section 9.6). Public: outside (app), no
// session, nothing of the shop but its name and the masked address. Opening it changes nothing; the button posts.
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { allowPublic } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** "j•••@gmail.com" */
function mask(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 1 ? `${address.slice(0, 1)}•••` : `${address.slice(0, 1)}•••${address.slice(at)}`;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <section className="card card-pad space-y-4 text-center">{children}</section>
    </main>
  );
}

export default async function Unsubscribe({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  if (!allowPublic(await headers(), "u", 60, 60_000)) {
    return (
      <Card>
        <p>Too many requests. Try again in a minute.</p>
      </Card>
    );
  }
  const row = TOKEN.test(token) ? await db.outMessage.findFirst({ where: { optOutToken: token }, select: { shopId: true, address: true, shop: { select: { name: true } } } }) : null;
  if (!row) {
    return (
      <Card>
        <p>This link isn&apos;t valid. To stop getting emails, reply to one of them with the word UNSUBSCRIBE.</p>
      </Card>
    );
  }
  const sup = await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: row.shopId, channel: "email", address: row.address } }, select: { scope: true } });
  const who = `${row.shop.name} at ${mask(row.address)}`;
  if (sup || done === "1") {
    return (
      <Card>
        <p>Done. You won&apos;t get marketing emails from {who} any more. You&apos;ll still get messages about your own repairs and bookings.</p>
      </Card>
    );
  }
  return (
    <Card>
      <p>
        Stop marketing emails from {row.shop.name} to {mask(row.address)}?
      </p>
      <form method="post" action={`/api/u/${token}`}>
        <button type="submit" className="btn btn-primary">
          Unsubscribe
        </button>
      </form>
    </Card>
  );
}
