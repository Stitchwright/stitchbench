import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hubJoined } from "@/lib/hub";
import { numberKey } from "@/lib/parts";
import { PageHeader, Empty } from "@/components/ui";
import { ListingCard, MarketNav } from "@/components/market-ui";
import { CONDITIONS, CONDITION_NAME, ORIGINS, ORIGIN_NAME } from "@/lib/part-labels";

const KINDS = [
  { key: "", label: "Everything" },
  { key: "PART", label: "Parts" },
  { key: "ACCESSORY", label: "Accessories" },
  { key: "SUPPLY", label: "Supplies" },
  { key: "NOTION", label: "Notions" },
  { key: "FABRIC", label: "Fabric" },
  { key: "THREAD", label: "Thread" },
  { key: "PATTERN", label: "Patterns / books" },
] as const;

export default async function Market({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; condition?: string; origin?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const term = sp.q?.trim() ?? "";
  const kind = KINDS.some((k) => k.key && k.key === sp.kind) ? sp.kind : "";
  const condition = CONDITIONS.find((c) => c === sp.condition) ?? "";
  const origin = ORIGINS.find((o) => o === sp.origin) ?? "";
  const nk = numberKey(term);
  const t = { contains: term, mode: "insensitive" as const };
  const [joined, listings] = await Promise.all([
    hubJoined(),
    db.listing.findMany({
      where: {
        status: "ACTIVE",
        mine: false,
        ...(kind ? { kind } : {}),
        ...(condition ? { condition } : {}),
        ...(origin ? { origin } : {}),
        ...(term ? { OR: [{ title: t }, { brand: t }, { fits: t }, { description: t }, ...(nk.length >= 3 ? [{ numberKey: nk }] : [])] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 120,
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace"
        sub="Parts and accessories other repair shops are selling. You pay the seller directly; they ship with tracking."
        actions={
          <Link href="/market/mine" className="btn btn-primary">
            Sell something
          </Link>
        }
      />
      <MarketNav current="browse" />
      {!joined ? (
        <p className="pill tone-wait inline-block">
          The marketplace is on the community hub. <Link href="/settings#hub" className="link">Join it in Settings</Link>.
        </p>
      ) : (
        <>
          <form className="flex flex-wrap gap-2">
            <label htmlFor="mq" className="sr-only">
              Search the marketplace
            </label>
            <input id="mq" name="q" defaultValue={term} className="input max-w-md" placeholder="Part number, brand, model it fits" />
            <label htmlFor="mk" className="sr-only">
              Type
            </label>
            <select id="mk" name="kind" defaultValue={kind} className="select w-44">
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
            <label htmlFor="mc" className="sr-only">
              Condition
            </label>
            <select id="mc" name="condition" defaultValue={condition} className="select w-40">
              <option value="">Any condition</option>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {CONDITION_NAME[c]}
                </option>
              ))}
            </select>
            <label htmlFor="mo" className="sr-only">
              Made by
            </label>
            <select id="mo" name="origin" defaultValue={origin} className="select w-40">
              <option value="">Made by anyone</option>
              {ORIGINS.map((o) => (
                <option key={o} value={o}>
                  {ORIGIN_NAME[o]}
                </option>
              ))}
            </select>
            <button className="btn">Search</button>
          </form>
          {listings.length === 0 ? (
            <Empty>{term ? "Nobody is selling that right now." : "Nothing for sale yet. Be the first: list a spare part."}</Empty>
          ) : (
            <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {listings.map((l) => (
                <li key={l.id}>
                  <ListingCard l={l} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
