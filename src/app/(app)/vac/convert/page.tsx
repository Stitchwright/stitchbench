// "Vacuums filed as sewing machines?" (modules-design.md 10.0): SEWING machines whose brand is a vacuum maker or whose
// type says "vac", each with "It's a vacuum" (convertMachineKind, admin + Vac Shop on). Nothing is converted on its own.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { brandMatches, VACUUM_BRANDS } from "@/lib/equipment/vacuum";
import { convertMachineKind } from "@/actions/records";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function VacConvertPage() {
  const user = await requireUser();
  const s = await vacPageState(user);
  const shopId = user.shopId;
  const tz = await shopTimeZone(shopId);
  const rows = (
    await db.machine.findMany({
      where: { shopId, equipment: "SEWING", OR: [{ brand: { in: VACUUM_BRANDS, mode: "insensitive" } }, { machineType: { contains: "vac", mode: "insensitive" } }] },
      include: { customer: { select: { id: true, name: true } }, tickets: { orderBy: { intakeAt: "desc" }, take: 1, select: { id: true, number: true, status: true, intakeAt: true } } },
      orderBy: [{ brand: "asc" }, { model: "asc" }],
      take: 200,
    })
  ).filter((m) => brandMatches(m.brand) || /vac/i.test(m.machineType ?? ""));
  return (
    <VacFrame title="Vacuums filed as sewing machines?" tab={null} {...s}>
      <p className="muted text-sm">Kenmore, Singer and Electrolux made sewing machines too. Check the model before you change it.</p>
      {rows.length === 0 ? (
        <Empty>Nothing looks misfiled.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Brand</th>
                <th>Model</th>
                <th>Serial</th>
                <th>Type</th>
                <th>Customer</th>
                <th>Last ticket</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const t = m.tickets[0];
                return (
                  <tr key={m.id}>
                    <td>{m.brand}</td>
                    <td>
                      <Link href={`/machines/${m.id}`} className="link">
                        {m.model}
                      </Link>
                    </td>
                    <td className="mono">{m.serial ?? ""}</td>
                    <td>{m.machineType ?? ""}</td>
                    <td>
                      {m.customer ? (
                        <Link href={`/customers/${m.customer.id}`} className="link">
                          {m.customer.name}
                        </Link>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="whitespace-nowrap">{t ? `${fmtDate(t.intakeAt, tz)} (${t.status.toLowerCase().replace(/_/g, " ")})` : "none"}</td>
                    <td className="text-right">
                      {s.admin && s.gate === "write" && (
                        <ActionForm action={convertMachineKind.bind(null, m.id)} success="It's a vacuum now" className="inline-flex">
                          <input type="hidden" name="kind" value="vacuum" />
                          <Submit className="btn btn-sm">It&apos;s a vacuum</Submit>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </VacFrame>
  );
}
