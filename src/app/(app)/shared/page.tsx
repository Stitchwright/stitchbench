import { requireUser } from "@/lib/session";
import { modelKey } from "@/lib/format";
import { PageHeader, Empty } from "@/components/ui";
import { findSharedPosts, SharedPostList } from "@/components/shared-posts";

export default async function SharedPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const term = (await searchParams).q?.trim() ?? "";
  const key = modelKey(term);
  const posts = await findSharedPosts(
    term
      ? {
          OR: [
            { brand: { contains: term, mode: "insensitive" } },
            { model: { contains: term, mode: "insensitive" } },
            ...(key.length >= 2 ? [{ modelKey: { contains: key } }] : []),
            { title: { contains: term, mode: "insensitive" } },
            { body: { contains: term, mode: "insensitive" } },
          ],
        }
      : {},
    100,
  );
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Shared by techs" sub="Issues, fixes and photos techs at every StitchBench shop have shared. Share yours from a machine page." />
      <form className="flex gap-2">
        <label htmlFor="sq" className="sr-only">
          Search shared notes
        </label>
        <input id="sq" name="q" defaultValue={term} className="input max-w-md" placeholder="Model, brand or problem, e.g. MC6700P, thread cutter" />
        <button className="btn">Search</button>
      </form>
      <div className="card card-pad">
        {posts.length === 0 ? <Empty>{term ? "Nothing shared matches that." : "Nothing shared yet."}</Empty> : <SharedPostList posts={posts} user={user} showModel />}
      </div>
    </div>
  );
}
