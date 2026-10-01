// "Marked ready by the repair shop. Are they here?" on /repairs (scheduling-messaging-design.md sections 7.3 and 9.5):
// retail jobs the repair shop says are ready, not yet recorded back at our counter. Server component.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { READY_JOB_STATUSES } from "@/lib/notices/hooks";
import { markManyBack } from "@/actions/notices";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function RepairsBackSlot({ user }: { user: CurrentUser }) {
  const shopId = user.shopId;
  const jobs = await db.repairJob.findMany({
    where: { shopId, side: "retail", status: { in: READY_JOB_STATUSES }, backAt: null, pickedUpAt: null },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: { id: true, tag: true, customerName: true, brand: true, model: true, linkId: true, updatedAt: true, customer: { select: { name: true } } },
  });
  if (!jobs.length) return null;
  const [gate, shop, links] = await Promise.all([
    gateFor(shopId, "marketing"),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true } }),
    db.partnerLink.findMany({ where: { shopId, id: { in: [...new Set(jobs.map((j) => j.linkId))] } }, select: { id: true, partnerName: true } }),
  ]);
  const partner = new Map(links.map((l) => [l.id, l.partnerName]));
  const on = gate === "on";

  async function back(fd: FormData) {
    "use server";
    const r = await markManyBack(fd);
    if ("error" in r) return r;
    // "...call them" is work for staff: show it as a warning rather than a quiet "Recorded".
    return /call/i.test(r.note) ? { error: r.note } : { ok: true as const };
  }

  return (
    <Section title="Marked ready by the repair shop. Are they here?">
      <ActionForm action={back} success="Recorded" className="space-y-3">
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th className="w-10">
                  <span className="sr-only">Here</span>
                </th>
                <th>Tag</th>
                <th>Customer</th>
                <th>Machine</th>
                <th>Repair shop</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <input type="checkbox" name="jobIds" value={j.id} className="check" aria-label={`Tag ${j.tag} is here`} />
                  </td>
                  <td className="mono">{j.tag}</td>
                  <td>{j.customer?.name ?? j.customerName}</td>
                  <td>
                    {j.brand} {j.model}
                  </td>
                  <td>{partner.get(j.linkId) ?? ""}</td>
                  <td className="num">{fmtDate(j.updatedAt, shop.timeZone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Submit className="btn btn-primary">{on ? "These are back: tell the customers" : "These are back"}</Submit>
      </ActionForm>
    </Section>
  );
}
