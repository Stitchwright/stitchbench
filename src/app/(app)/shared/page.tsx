import Link from "next/link";
import { requireUser } from "@/lib/session";
import { hubJoined } from "@/lib/hub";
import { PageHeader, Empty } from "@/components/ui";
import { sharedNotes, SharedPostList } from "@/components/shared-posts";
import { shopTimeZone } from "@/lib/shop-zone";

export default async function SharedPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const term = (await searchParams).q?.trim() ?? "";
  const [notes, joined, tz] = await Promise.all([sharedNotes(user, { term: term || undefined, take: 100 }), hubJoined(), shopTimeZone(user.shopId)]);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Shared by techs" sub="Issues, fixes and photos techs at every shop on StitchHub have shared. Share yours from a machine page." />
      {!joined && (
        <p className="pill tone-wait inline-block">
          Not connected to StitchHub yet. <Link href="/settings#hub" className="link">Join it in Settings</Link> to see other shops&apos; notes.
        </p>
      )}
      <form className="flex gap-2">
        <label htmlFor="sq" className="sr-only">
          Search shared notes
        </label>
        <input id="sq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model, brand or problem, e.g. MC6700P, thread cutter" />
        <button className="btn">Search</button>
      </form>
      <div className="card card-pad">
        {notes.length === 0 ? <Empty>{term ? "Nothing shared matches that." : "Nothing shared yet."}</Empty> : <SharedPostList notes={notes} showModel timeZone={tz} />}
      </div>
    </div>
  );
}
