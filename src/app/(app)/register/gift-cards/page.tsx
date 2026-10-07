import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { findCard, limitLookups, untouchedCards } from "@/lib/gift-cards";
import { lastFour, parseCardNumber } from "@/lib/gift-card-number";
import { isUserError } from "@/lib/user-error";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { addExistingGiftCard } from "@/actions/gift-cards";

/** Gift cards and store credit: find a card by its number or the customer, see what the shop owes on cards. */
export default async function GiftCards({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const tz = await shopTimeZone(user.shopId);
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  let notice: string | null = null;
  let found: { id: string; number: string; kind: string; balanceCents: number; status: string; lastUsedAt: Date | null; customer: { name: string } | null }[] = [];

  if (q) {
    const p = parseCardNumber(q);
    if (p.kind === "gc" || p.kind === "printed" || p.kind === "gc-bad") {
      // A number: exactly this one, and rate-limited so it can't be guessed at.
      try {
        limitLookups(user.id);
        const card = await findCard(db, user.shopId, q);
        redirect(`/register/gift-cards/${card.id}`);
      } catch (e) {
        if (!isUserError(e)) throw e;
        notice = e.message;
      }
    }
    if (p.kind === "none" || (notice && p.kind === "printed")) {
      // Words: the customer's name, phone or email.
      const customers = await db.customer.findMany({
        where: { shopId: user.shopId, OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || "\u0000" } }] },
        select: { id: true },
        take: 20,
      });
      if (customers.length) {
        found = await db.giftCard.findMany({
          where: { shopId: user.shopId, customerId: { in: customers.map((c) => c.id) } },
          include: { customer: { select: { name: true } } },
          orderBy: { issuedAt: "desc" },
          take: 50,
        });
        notice = found.length ? null : "That customer has no gift card or store credit.";
      } else if (!notice) notice = "Nothing found. Type the whole card number, or a customer's name.";
    }
  }

  // What the shop owes on cards (the liability), by kind; owners and admins only.
  const owed = admin
    ? await db.giftCard.groupBy({ by: ["kind"], where: { shopId: user.shopId, status: "active", balanceCents: { gt: 0 } }, _sum: { balanceCents: true }, _count: true })
    : [];
  const stale = admin ? await untouchedCards(user.shopId) : null;
  const sum = (kind: string) => owed.find((o) => o.kind === kind);

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/register", label: "Register" }}
        title="Gift cards and store credit"
        sub="Cards never expire and carry no fees. Sell, load and spend them at the register or on a ticket's payments."
        actions={
          admin && (
            // A file download, not a page: a plain link.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a href="/api/export/gift-cards" className="btn">
              Download the card list (CSV)
            </a>
          )
        }
      />
      <form method="get" className="card card-pad flex flex-wrap items-end gap-2" role="search">
        <div className="field min-w-64 flex-1">
          <label htmlFor="gc-q" className="label">
            Find a card by its number, or a customer by name
          </label>
          <input id="gc-q" name="q" defaultValue={q} className="input mono" autoComplete="off" autoFocus placeholder="GC-XXXX-XXXX-XXXX-X, or a name" />
        </div>
        <button className="btn btn-primary">Find</button>
      </form>
      {notice && (
        <p className="pill tone-wait" role="status">
          {notice}
        </p>
      )}
      {found.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th>Card</th>
                <th>Customer</th>
                <th>Last used</th>
                <th className="text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {found.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/register/gift-cards/${c.id}`} className="link">
                      {c.kind === "credit" ? "Store credit" : "Gift card"} ending {lastFour(c.number)}
                    </Link>
                    {c.status !== "active" && <span className="pill tone-neutral ml-2">void</span>}
                  </td>
                  <td>{c.customer?.name ?? ""}</td>
                  <td>{c.lastUsedAt ? fmtDate(c.lastUsedAt, tz) : "never"}</td>
                  <td className="num text-right">{money(c.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {admin && (
        <Section title="What the shop owes on cards">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <div className="muted">Gift cards</div>
              <div className="num text-lg font-semibold">{money(sum("gift")?._sum.balanceCents ?? 0)}</div>
              <div className="muted">{sum("gift")?._count ?? 0} with a balance</div>
            </div>
            <div>
              <div className="muted">Store credit</div>
              <div className="num text-lg font-semibold">{money(sum("credit")?._sum.balanceCents ?? 0)}</div>
              <div className="muted">{sum("credit")?._count ?? 0} with a balance</div>
            </div>
            <div>
              <div className="muted">Untouched for 3 years</div>
              <div className="num text-lg font-semibold">{money(stale?.cents ?? 0)}</div>
              <div className="muted">{stale?.count ?? 0} cards: ask your accountant about your state&apos;s unclaimed property rules</div>
            </div>
          </div>
          <p className="muted mt-3 text-xs">
            Selling a card is not a sale: it is money held for the customer, and it is taxed when spent on taxable things. Some states require a small leftover to be paid out in cash on request: an owner or an admin can pay out a
            balance from the register (Gift card, Pay out a balance in cash). This is plain terms, not legal advice.
          </p>
        </Section>
      )}
      {admin && (
        <Section title="Add an existing card">
          <p className="muted mb-2 text-sm">A paper card the shop sold before this program: type the number printed on it and what is left. It counts in what the shop owes, not in sales.</p>
          <ActionForm action={addExistingGiftCard} success="Card added" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="ex-number" className="label">
                Number on the card
              </label>
              <input id="ex-number" name="number" className="input mono" autoComplete="off" required />
            </div>
            <div className="field">
              <label htmlFor="ex-amount" className="label">
                Left on it ($)
              </label>
              <input id="ex-amount" name="amount" inputMode="decimal" className="input num w-28" required />
            </div>
            <Submit>Add the card</Submit>
          </ActionForm>
        </Section>
      )}
      {!q && !admin && <Empty>Type a card number or a customer&apos;s name above.</Empty>}
    </div>
  );
}
