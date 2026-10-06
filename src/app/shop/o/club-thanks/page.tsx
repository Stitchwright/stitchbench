// Where Stripe sends a club member after the card page (package F7): a plain thank-you with nothing to look up. The
// membership itself is confirmed by the shop's webhook, not by anything on this page.
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Club sign-up", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ClubThanks({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <main className="mx-auto max-w-xl space-y-3 p-6 text-base">
      {sp.cancelled ? (
        <>
          <h1 className="text-xl font-semibold">No card was saved.</h1>
          <p>Nothing was charged. Ask the shop for a new link whenever you are ready.</p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Thank you, you are signed up.</h1>
          <p>Your card is saved for the monthly club price. The shop will have your membership in a moment; you can close this page.</p>
        </>
      )}
    </main>
  );
}
