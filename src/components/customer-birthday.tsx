// A customer's birthday on her page (shop-features-round-2-design.md 1.6): month and day, "only if she'd like to tell
// you"; the shop's birthday offer uses it.
import { db } from "@/lib/db";
import { monthName } from "@/lib/birthdays";
import { saveBirthday } from "@/actions/birthdays";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export async function CustomerBirthday({ shopId, customerId }: { shopId: string; customerId: string }) {
  const c = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { birthMonth: true, birthDay: true } });
  if (!c) return null;
  return (
    <Section title="Birthday">
      <p className="text-base">{c.birthMonth && c.birthDay ? `${monthName(c.birthMonth)} ${c.birthDay}` : "Not on file."}</p>
      <details className="mt-2">
        <summary className="link cursor-pointer text-base">{c.birthMonth ? "Change" : "Add her birthday"} (only if she&apos;d like to tell you)</summary>
        <ActionForm action={saveBirthday.bind(null, customerId)} success="Saved" className="mt-2 flex flex-wrap items-end gap-3 text-base">
          <div className="field">
            <label htmlFor="bd-month" className="label">
              Month
            </label>
            <select id="bd-month" name="month" className="select" defaultValue={c.birthMonth ?? ""}>
              <option value="">Not on file</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bd-day" className="label">
              Day
            </label>
            <input id="bd-day" name="day" className="input num w-20" inputMode="numeric" defaultValue={c.birthDay ?? ""} />
          </div>
          <Submit className="btn min-h-11">Save</Submit>
        </ActionForm>
      </details>
    </Section>
  );
}
