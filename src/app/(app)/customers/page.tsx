import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { firstValues } from "@/lib/search-params";
import { PageHeader, Section, Empty } from "@/components/ui";
import { CustomerForm } from "@/components/customer-form";
import { saveCustomer } from "@/actions/records";

export default async function Customers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = firstValues(await searchParams);
  const term = q?.trim();
  const customers = await db.customer.findMany({
    where: {
      shopId: user.shopId,
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { phone: { contains: term } },
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

  return (
    <div className="space-y-6">
      <PageHeader title="Customers" sub="Retail customers and the quilt shops or dealers that send machines in." />
      <form className="flex gap-2">
        <label htmlFor="cq" className="sr-only">
          Search customers
        </label>
        <input id="cq" name="q" defaultValue={term} className="input max-w-md" placeholder="Name, phone, email or route code" />
        <button className="btn">Search</button>
      </form>
      <div className="card">
        {customers.length === 0 ? (
          <div className="card-pad">
            <Empty>No customers yet.</Empty>
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
                    <td>{c.kind === "TRADE" ? <span className="pill tone-work">Account {c.code ?? ""}</span> : "Retail"}</td>
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
      <Section title="Add a customer or shop account">
        <CustomerForm action={saveCustomer.bind(null, null)} submitLabel="Add" />
      </Section>
    </div>
  );
}
