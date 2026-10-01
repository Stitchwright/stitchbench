// Texts customers sent back (scheduling-messaging-design.md 8.3). "Handled" is a consent-side record, never gated.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtPhone } from "@/lib/phone";
import { gateFor } from "@/lib/module-gate";
import { markReplyHandled } from "@/actions/consent";
import { ModuleOff } from "@/components/module-off";
import { MessagesTabs } from "@/components/messages-tabs";
import { PageHeader, Empty } from "@/components/ui";
import { ActionButton } from "@/components/action-form";

const KEYWORD_TONE: Record<string, string> = { STOP: "bad", STOPLIKE: "bad", START: "ready", HELP: "wait" };
const KEYWORD_LABEL: Record<string, string> = { STOP: "STOP", STOPLIKE: "Stop (in other words)", START: "START", HELP: "HELP" };

export default async function RepliesPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  const admin = user.role !== "TECH";
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="marketing" admin={admin} />;
  const tz = await shopTimeZone(shopId);
  const rows = await db.inboundText.findMany({
    where: { shopId },
    orderBy: [{ handledAt: { sort: "asc", nulls: "first" } }, { receivedAt: "desc" }],
    take: 200,
  });
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter((id): id is string => !!id))];
  const [customers, users] = await Promise.all([
    customerIds.length ? db.customer.findMany({ where: { shopId, id: { in: customerIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    db.user.findMany({ where: { shopId }, select: { id: true, name: true } }),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const unhandled = rows.filter((r) => !r.keyword && !r.handledAt).length;

  return (
    <div className="space-y-4">
      <PageHeader title="Replies" sub="Texts customers sent back to your number." />
      <MessagesTabs active="replies" unhandled={unhandled} />
      {gate !== "on" && <ModuleOff shopId={shopId} module="marketing" admin={admin} what="Your replies" />}
      <p className="text-sm">
        Replies to your texts. STOP, START and HELP are handled automatically. Call them back about anything else: replies can&apos;t be answered from here yet. Until you mark a reply
        handled, that number gets no marketing texts.
      </p>
      <div className="card">
        {rows.length === 0 ? (
          <div className="card-pad">
            <Empty>No replies yet.</Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>Text</th>
                  <th>Keyword</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sid}>
                    <td className="num whitespace-nowrap">{fmtDateTime(r.receivedAt, tz)}</td>
                    <td>
                      {r.customerId && customerName.has(r.customerId) ? (
                        <>
                          <Link href={`/customers/${r.customerId}`} className="link">
                            {customerName.get(r.customerId)}
                          </Link>
                          <div className="muted text-xs">{fmtPhone(r.fromNumber)}</div>
                        </>
                      ) : (
                        fmtPhone(r.fromNumber)
                      )}
                    </td>
                    <td className="max-w-md whitespace-pre-wrap">{r.body}</td>
                    <td>{r.keyword ? <span className={`pill tone-${KEYWORD_TONE[r.keyword] ?? "neutral"}`}>{KEYWORD_LABEL[r.keyword] ?? r.keyword}</span> : null}</td>
                    <td className="whitespace-nowrap text-xs">
                      {r.handledAt ? (
                        <span className="muted">
                          Handled {fmtDateTime(r.handledAt, tz)}
                          {r.handledBy && userName.has(r.handledBy) ? ` by ${userName.get(r.handledBy)}` : ""}
                        </span>
                      ) : r.keyword ? (
                        <span className="muted">Handled automatically</span>
                      ) : (
                        <ActionButton action={markReplyHandled.bind(null, r.sid)} success="Marked handled">
                          Handled
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
