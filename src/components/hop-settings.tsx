// Settings, Selling, "Shop hops" (shop-features-round-2-design.md 4.6): off until the shop turns them on; then Shop hop is
// in the menu. A server component.
import Link from "next/link";
import { setHopOn } from "@/actions/hops";
import { ActionButton } from "@/components/action-form";
import { Section } from "@/components/ui";

export function HopSettings({ on, admin }: { on: boolean; admin: boolean }) {
  return (
    <Section title="Shop hops" id="hops">
      <p className="text-base">
        {on ? "On: stamp shoppers' passports on the " : "Taking part in a shop hop? Turn this on to stamp shoppers' passports and see who visited. It runs on the community hub."}
        {on && (
          <Link href="/hops" className="link">
            Shop hop page
          </Link>
        )}
        {on ? "." : ""}
      </p>
      {admin && (
        <ActionButton action={setHopOn.bind(null, !on)} className={`btn mt-3 min-h-11 text-base ${on ? "" : "btn-primary"}`}>
          {on ? "Turn shop hops off" : "Turn shop hops on"}
        </ActionButton>
      )}
    </Section>
  );
}
