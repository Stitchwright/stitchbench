import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { PageHeader, Section, Empty } from "@/components/ui";
import { CustomerForm } from "@/components/customer-form";
import { saveCustomer } from "@/actions/records";
import { customerIdsByPhone } from "@/lib/phone-search";
import { customerIdsBySpelling } from "@/lib/customer-search";
import { gateFor } from "@/lib/module-gate";

export default async function Customers({ searchParams }: { searchParams: Promise<{ q?: string; new?: string }> }) {
  const user = await requireUser();
  const { q, new: newTyped } = firstValues(await searchParams);
  const term = q?.trim();
  const phoneIds = term ? await customerIdsByPhone(user.shopId, term) : [];
  const customers = await db.customer.findMany({
    where: {
      shopId: user.shopId,
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { phone: { contains: term } },
              { id: { in: phoneIds } },
              { email: { contains: term, mode: "insensitive" } },
              { code: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { _count: { select: { machines: true, tickets: true, viaTickets: true } } },
    orderBy: [{ kind: "desc" }, { name: "asc" }],
    take: 500,
  });
  // Nothing as typed: near spellings ("dorthy" finds Dorothy Miller), offered as "Did you mean".
  const nearIds = term && customers.length === 0 ? await customerIdsBySpelling(user.shopId, term, { take: 20 }) : [];
  const near = nearIds.length
    ? await db.customer.findMany({ where: { shopId: user.shopId, id: { in: nearIds } }, select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } })
    : [];
  // "Add 'dorthy' as a new customer" fills the add form: digits go in the Phone box, anything else in the Name box.
  const preset = newTyped?.trim().slice(0, 120) ?? "";
  const presetIsPhone = /\d/.test(preset) && !/\p{L}/u.test(preset);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        sub="Retail customers and the quilt shops or dealers that send machines in."
        actions={
          <Link href="/customers#add" className="btn btn-primary">
            Add customer
          </Link>
        }
      />
      <form className="flex gap-2">
        <label htmlFor="cq" className="sr-only">
          Search customers
        </label>
        <input id="cq" name="q" defaultValue={term} className="input max-w-md" placeholder="Name, phone or email" />
        <button className="btn">Search</button>
      </form>
      <div className="card">
        {customers.length === 0 ? (
          <div className="card-pad space-y-3">
            {term ? (
              <>
                <p>No customer matches &lsquo;{term}&rsquo;.</p>
                {near.length > 0 && (
                  <div>
                    <p className="font-semibold">Did you mean:</p>
                    <ul className="mt-1 space-y-1">
                      {near.map((c) => (
                        <li key={c.id}>
                          <Link href={`/customers/${c.id}`} className="link font-semibold">
                            {c.name}
                          </Link>
                          {c.phone && <span className="muted"> {c.phone}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Link href={`/customers?new=${encodeURIComponent(term)}#add`} className="btn">
                  Add &lsquo;{term}&rsquo; as a new customer
                </Link>
              </>
            ) : (
              <Empty>No customers yet. Add your first customer below.</Empty>
            )}
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Phone</th>
                  <th className="text-right">Machines</th>
                  <th className="text-right">Tickets</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/customers/${c.id}`} className="link font-semibold">
                        {c.name}
                      </Link>
                    </td>
                    <td>{c.kind === "TRADE" ? <span className="pill tone-work">Shop or dealer {c.code ?? ""}</span> : "Retail"}</td>
                    <td>{c.phone ?? "-"}</td>
                    <td className="num text-right">{c._count.machines}</td>
                    <td className="num text-right">{c._count.tickets + c._count.viaTickets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Section title="Add a customer or shop account" id="add">
        <CustomerForm
          key={preset}
          action={saveCustomer.bind(null, null)}
          submitLabel="Add"
          preset={presetIsPhone ? { phone: preset } : { name: preset }} taxFields={user.role !== "TECH"} marketingHidden={(await gateFor(user.shopId, "marketing")) === "hidden"} />
      </Section>
    </div>
  );
}
