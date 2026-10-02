// Settings → Online booking (online-and-parts-design.md section 2): the page's address, on / off, lead time, how far
// ahead, the welcome, which appointment types and classes customers may book themselves, the link and the embed
// snippet. Owners and admins edit; it needs the Scheduling module and (for a link that works) a public address.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { bookingSettings, bookingUrl, slugOf } from "@/lib/online-booking";
import { isDesktop } from "@/lib/modules";
import { db } from "@/lib/db";
import { saveBookingSettings } from "@/actions/online-booking";
import { ActionForm, Submit } from "@/components/action-form";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function BookingSettings() {
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate !== "on") {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader title="Online booking" back={{ href: "/settings", label: "Settings" }} />
        <ModuleOff shopId={shopId} module="scheduling" what="Online booking" admin={user.role !== "TECH"} />
      </div>
    );
  }
  const [s, shop] = await Promise.all([bookingSettings(shopId), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } })]);
  const admin = user.role !== "TECH";
  const base = publicBaseUrl();
  const url = bookingUrl(s.slug);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Online booking" sub="Customers book an appointment or sign up for a class themselves, from your website. The booking lands on your calendar and roster." back={{ href: "/settings", label: "Settings" }} />
      {!base && (
        <p className="card card-pad text-sm">
          {isDesktop()
            ? "This program has no public address yet. Set publicUrl (a tunnel to the links port) in its settings file; the booking page then works at that address. The hosted version has one built in."
            : "This install has no PUBLIC_URL set, so the booking page has no address customers can open. Ask the operator to set it."}
        </p>
      )}
      {url && s.on && (
        <Section title="Your booking page">
          <p className="text-sm">
            <a href={url} className="link" target="_blank" rel="noreferrer">
              {url}
            </a>
          </p>
          <p className="muted mt-2 text-xs">Put the link on your website, or embed the page:</p>
          <pre className="mt-1 overflow-x-auto rounded border border-line p-2 text-xs">{`<iframe src="${url}" title="Book with ${shop.name}" style="width:100%;height:900px;border:0"></iframe>`}</pre>
        </Section>
      )}
      <ActionForm action={saveBookingSettings} success="Saved" className="space-y-6">
        <fieldset disabled={!admin} className="space-y-6">
          <Section title="The page">
            <div className="grid-form">
              <div className="field">
                <label htmlFor="bs-slug" className="label">
                  Address (after /book/)
                </label>
                <input id="bs-slug" name="slug" className="input mono" defaultValue={s.slug ?? slugOf(shop.name)} placeholder="your-shop-name" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
                <p className="muted text-xs">Lower-case letters, digits and dashes.</p>
              </div>
              <label className="flex items-center gap-2 self-end text-sm">
                <input type="checkbox" name="on" className="check" defaultChecked={s.on} /> Online booking is on
              </label>
              <div className="field">
                <label htmlFor="bs-lead" className="label">
                  Earliest booking (hours from now)
                </label>
                <input id="bs-lead" name="leadHours" type="number" min={0} max={336} className="input num" defaultValue={s.leadHours} />
              </div>
              <div className="field">
                <label htmlFor="bs-ahead" className="label">
                  How far ahead (days)
                </label>
                <input id="bs-ahead" name="daysAhead" type="number" min={1} max={365} className="input num" defaultValue={s.daysAhead} />
              </div>
              <div className="field sm:col-span-2">
                <label htmlFor="bs-welcome" className="label">
                  Welcome text at the top of the page (optional)
                </label>
                <textarea id="bs-welcome" name="welcome" rows={2} maxLength={500} className="textarea" defaultValue={s.welcome ?? ""} placeholder="Book a machine fitting or a lesson below. Fees are paid when you come in." />
              </div>
            </div>
          </Section>
          <Section title="Appointments customers may book">
            {s.types.length === 0 ? (
              <Empty>
                No appointment types yet.{" "}
                <Link href="/calendar/types" className="link">
                  Add one
                </Link>
                .
              </Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {s.types.map((t) => (
                  <li key={t.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="type" value={t.id} className="check" defaultChecked={t.online} disabled={!t.active} /> {t.name}
                      {!t.active && <span className="muted"> (not bookable now)</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Classes customers may sign up for">
            {s.classes.length === 0 ? (
              <Empty>No upcoming classes.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {s.classes.map((c) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="class" value={c.id} className="check" defaultChecked={c.online} disabled={c.status !== "OPEN"} /> {c.title}
                      {c.status !== "OPEN" && <span className="muted"> (sign-ups closed)</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {admin && <Submit>Save</Submit>}
        </fieldset>
      </ActionForm>
      <p className="muted text-sm">Fees are paid at the counter in this version. Bookings made online show &quot;online&quot; on the appointment and the roster, and the customer can cancel or move them from the link in their confirmation until your earliest-booking time.</p>
    </div>
  );
}
