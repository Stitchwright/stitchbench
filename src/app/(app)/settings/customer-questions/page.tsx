// Settings → Customer questions (shop-features-round-2-design.md 5.6): answer customers' questions on the booking page
// (off until turned on), how many typed questions a day, the opening hours the Hours answer reads, and the status link
// for an outside phone-answering service. Owners and admins change it.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hoursOf, WEEKDAY_NAMES } from "@/lib/appointments";
import { assistantSettings } from "@/lib/assistant/context";
import { fmtDateTime } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { publicBaseUrl } from "@/lib/messaging/settings";
import { removeStatusKey, saveCustomerAnswers } from "@/actions/customer-answers";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { StatusKeyButton } from "@/components/status-key";
import { PageHeader, Section } from "@/components/ui";

export default async function CustomerQuestionsSettings() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const [shop, settings, assistant] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { bookingSlug: true, openHours: true, hoursNote: true, statusKeyAt: true, timeZone: true } }),
    assistantSettings(user.shopId),
    gateFor(user.shopId, "assistant"),
  ]);
  const hours = hoursOf(shop.openHours);
  const base = publicBaseUrl() ?? "";
  const link = shop.bookingSlug ? `${base}/api/public/v1/${shop.bookingSlug}` : null;
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Customer questions" sub="Answers on your booking page, from your own records only." back={{ href: "/settings", label: "Settings" }} />
      {!shop.bookingSlug && (
        <p className="card card-pad text-sm">
          Your booking page has no address yet. Set it in{" "}
          <Link href="/settings/booking" className="link">
            Settings → Online booking
          </Link>{" "}
          first: the questions show there.
        </p>
      )}
      <Section title="On your booking page">
        {admin ? (
          <ActionForm action={saveCustomerAnswers} success="Saved" className="space-y-4">
            <label className="flex items-start gap-2 text-base">
              <input type="checkbox" name="customerOn" defaultChecked={settings.customerOn} className="check mt-1" />
              <span>
                <strong>Answer customers&apos; questions on your booking page.</strong> It only answers from your records: is a machine ready, your hours, classes with seats, open drop-off times. Anything else
                goes to you, on the{" "}
                <Link href="/customer-questions" className="link">
                  Customer questions
                </Link>{" "}
                list. It never gives a price or says what&apos;s wrong with a machine.
              </span>
            </label>
            <div className="field max-w-xs">
              <label htmlFor="cq-cap" className="label">
                Typed questions a day, at most
              </label>
              <input id="cq-cap" name="customerDailyCap" className="input num" inputMode="numeric" defaultValue={String(settings.customerDailyCap)} />
              <p className="muted mt-1 text-xs">
                {assistant === "on"
                  ? "Each typed question uses one Assistant call. Past this, customers use the buttons (free)."
                  : "Typed questions need the Assistant; without it, customers use the buttons (free)."}
              </p>
            </div>
            <fieldset className="space-y-1">
              <legend className="label">Opening hours (for the Hours answer)</legend>
              {WEEKDAY_NAMES.map((d, i) => {
                const w = hours.find((h) => h.day === i);
                return (
                  <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2">
                      <input type="checkbox" name={`day${i}`} className="check" defaultChecked={!!w} /> {d}
                    </label>
                    <input name={`from${i}`} type="time" className="input w-32" defaultValue={w?.from ?? "10:00"} aria-label={`${d} opens`} />
                    <span className="muted">to</span>
                    <input name={`to${i}`} type="time" className="input w-32" defaultValue={w?.to ?? "17:00"} aria-label={`${d} closes`} />
                  </div>
                );
              })}
            </fieldset>
            <div className="field">
              <label htmlFor="cq-note" className="label">
                A line under the hours (optional)
              </label>
              <input id="cq-note" name="hoursNote" className="input" maxLength={200} defaultValue={shop.hoursNote ?? ""} placeholder="Closed on holidays." />
            </div>
            <Submit>Save</Submit>
          </ActionForm>
        ) : (
          <p className="text-sm">Answers on the booking page are {settings.customerOn ? "on" : "off"}. Only an owner or admin can change this.</p>
        )}
      </Section>
      {admin && (
        <Section title="A phone-answering service">
          <div className="space-y-3 text-sm">
            <p>
              If you use an outside service to answer your phone, give it this link and a key. It can read the same four answers (is a machine ready, hours, classes with seats, open drop-off times)
              and book a drop-off. It can&apos;t see anything else, and nothing here uses the Assistant.
            </p>
            {link ? (
              <>
                <div className="field">
                  <label htmlFor="cq-link" className="label">
                    Status link
                  </label>
                  <input id="cq-link" readOnly value={link} className="input mono" />
                </div>
                <p className="muted text-xs">
                  {shop.statusKeyAt ? `A key was made ${fmtDateTime(shop.statusKeyAt, shop.timeZone, { month: "short", day: "numeric", year: "numeric" })}.` : "No key yet: the link answers nothing until you make one."}{" "}The service
                  sends it as &quot;Authorization: Bearer &lt;key&gt;&quot;.
                </p>
                <StatusKeyButton hasKey={!!shop.statusKeyAt} />
                {shop.statusKeyAt && (
                  <ActionButton action={removeStatusKey} className="btn btn-sm" success="The status link is off.">
                    Turn the status link off
                  </ActionButton>
                )}
              </>
            ) : (
              <p className="muted">Set your booking page address first.</p>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
