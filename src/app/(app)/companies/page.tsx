import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { defaultShopKind, isPlatformAdmin } from "@/lib/shops";
import { fmtDate } from "@/lib/format";
import { PageHeader, Section } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { createCompany } from "@/actions/companies";

// Only the StitchBench admin (PLATFORM_ADMIN_EMAILS) sees this: every company on the system, and a form to add one.
export default async function Companies() {
  const user = await requireUser();
  if (!isPlatformAdmin(user.email)) notFound();
  const shops = await db.shop.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      users: { where: { role: "OWNER" }, select: { name: true, email: true } },
      _count: { select: { users: true, machines: true, tickets: true, sharedPosts: true } },
    },
  });

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Companies"
        sub="Each company has its own customers, machines, tickets, prices and people. Only shared notes and the factory specs are seen by everyone."
      />
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Owner</th>
              <th className="text-right">People</th>
              <th className="text-right">Machines</th>
              <th className="text-right">Tickets</th>
              <th className="text-right">Shared</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.id}>
                <td className="font-semibold">
                  {s.name}
                  {s.id === user.shopId && <span className="pill tone-neutral ml-2">yours</span>}
                </td>
                <td>
                  {s.users[0]?.name ?? "-"} <span className="muted text-xs">{s.users[0]?.email}</span>
                </td>
                <td className="num text-right">{s._count.users}</td>
                <td className="num text-right">{s._count.machines}</td>
                <td className="num text-right">{s._count.tickets}</td>
                <td className="num text-right">{s._count.sharedPosts}</td>
                <td className="num whitespace-nowrap">{fmtDate(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Section title="Add a company">
        <p className="muted mb-3 text-sm">
          Creates the company and its owner login. Give the owner the temporary password; they sign in, set their prices, and add their own employees under
          Settings → People.
        </p>
        <ActionForm action={createCompany} reset success="Company created" className="grid-form">
          <div className="field">
            <label htmlFor="c-shop" className="label">
              Company name
            </label>
            <input id="c-shop" name="shop" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-kind" className="label">
              Kind of shop
            </label>
            <select id="c-kind" name="kind" className="select" defaultValue={defaultShopKind()}>
              <option value="repair">Repair shop (StitchBench)</option>
              <option value="retail">Sewing / quilt shop (StitchShop register)</option>
              <option value="both">Both: repairs and a counter</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-name" className="label">
              Owner&apos;s name
            </label>
            <input id="c-name" name="name" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-email" className="label">
              Owner&apos;s email (their login)
            </label>
            <input id="c-email" name="email" type="email" required className="input" />
          </div>
          <div className="field">
            <label htmlFor="c-pw" className="label">
              Temporary password (8+ characters)
            </label>
            <input id="c-pw" name="password" required minLength={8} className="input" autoComplete="new-password" />
          </div>
          <div className="field sm:col-span-2">
            <label htmlFor="c-code" className="label">
              Partner code from its repair shop (optional: connects a sewing shop to the repair shop that made the code)
            </label>
            <input id="c-code" name="partnerCode" autoComplete="off" className="input mono" placeholder="7KQP-M2XH-9TRD" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Create company</Submit>
          </div>
        </ActionForm>
      </Section>
    </div>
  );
}
