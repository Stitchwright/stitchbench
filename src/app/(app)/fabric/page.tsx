// The Fabric page (fabric-smarts-design.md section 2), for companies that sell retail. Tabs: Bolt ends (F1), What sells and
// Slow fabric (F2), Reorder (F3), Kits (F4).
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { boltEndsFor } from "@/lib/fabric";
import { cutWords } from "@/lib/fabric-math";
import { MAX_ROWS, insightFor, ladderViewsFor, type GmroiRow, type GroupRow, type Insight, type InsightItem, type SlowRow } from "@/lib/fabric-insight";
import { qtyText } from "@/lib/register-math";
import { Empty, PageHeader } from "@/components/ui";
import { FabricCuts } from "@/components/fabric-cuts";
import { FabricMarkdown } from "@/components/fabric-markdown";
import { Swatch } from "@/components/fabric-swatch";
import { ReorderTab } from "./reorder-tab";
import { KitsTab } from "./kits-tab";

type Tab = "bolt" | "sells" | "slow" | "reorder" | "kits";

export default async function FabricPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { tab: raw } = await searchParams;
  const tab: Tab = raw === "sells" || raw === "slow" || raw === "reorder" || raw === "kits" ? raw : "bolt";
  const [bolt, insight] = await Promise.all([tab === "bolt" ? boltEndsFor(user.shopId) : null, tab === "bolt" || tab === "reorder" || tab === "kits" ? null : insightFor(user.shopId)]);
  const sub =
    tab === "bolt" && bolt
      ? `Bolt ends: ${qtyText(bolt.limit, "yd")} or less left, none on order. Cut them into fat quarters before they sit.`
      : tab === "kits"
        ? "Kits: fabric, pattern and notions in one box with one price."
        : tab === "reorder"
        ? "Fabric worth reordering while it is still in print, and your purchase orders."
        : tab === "sells"
        ? "Yards a week, weeks of supply and margin for every fabric, from your own sales and stock moves."
        : "Fabric that has sat since it came in and is still mostly unsold: mark it down a step, or cut it into fat quarters.";
  const links: { tab: Tab; label: string }[] = [
    { tab: "bolt", label: tab === "bolt" && bolt ? `Bolt ends (${bolt.rows.length})` : "Bolt ends" },
    { tab: "sells", label: "What sells" },
    { tab: "slow", label: tab === "slow" && insight ? `Slow fabric (${insight.slow.length})` : "Slow fabric" },
    { tab: "reorder", label: "Reorder" },
    { tab: "kits", label: "Kits" },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Fabric"
        sub={sub}
        actions={
          <>
            {tab === "kits" && (
              <Link href="/fabric/kits/new" className="btn btn-primary">
                New kit
              </Link>
            )}
            <Link href="/fabric/collection" className={tab === "kits" ? "btn" : "btn btn-primary"}>
              Add a collection
            </Link>
          </>
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Fabric tabs">
        {links.map((l) =>
          l.tab === tab ? (
            <span key={l.tab} className="btn btn-sm btn-primary" aria-current="page">
              {l.label}
            </span>
          ) : (
            <Link key={l.tab} href={l.tab === "bolt" ? "/fabric" : `/fabric?tab=${l.tab}`} className="btn btn-sm">
              {l.label}
            </Link>
          ),
        )}
      </nav>
      {tab === "bolt" && bolt && <BoltEnds shopId={user.shopId} rows={bolt.rows} limit={bolt.limit} />}
      {tab === "sells" && insight && <WhatSells insight={insight} />}
      {tab === "slow" && insight && <SlowFabric insight={insight} />}
      {tab === "reorder" && <ReorderTab shopId={user.shopId} />}
      {tab === "kits" && <KitsTab shopId={user.shopId} />}
    </div>
  );
}

async function BoltEnds({ shopId, rows, limit }: { shopId: string; rows: Awaited<ReturnType<typeof boltEndsFor>>["rows"]; limit: number }) {
  const ladders = await ladderViewsFor(
    shopId,
    rows.map((r) => r.id),
  );
  return (
    <div className="card">
      {rows.length === 0 ? (
        <div className="card-pad">
          <Empty>No bolt ends right now. Fabric with {qtyText(limit, "yd")} or less left (and none on order) shows up here.</Empty>
        </div>
      ) : (
        <ul className="divide-y divide-line" aria-label="Bolt ends">
          {rows.map((r) => {
            const l = ladders.get(r.id);
            return (
              <li key={r.id} className="card-pad flex flex-wrap items-start gap-3">
                <Swatch photoId={r.photoId} alt={r.description} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <Link href={`/parts/${r.id}`} className="link mono">
                      {r.partNumber}
                    </Link>{" "}
                    {r.description}
                    <div className="muted text-xs">
                      {[r.brand, r.collection].filter(Boolean).join(" · ")}
                      {r.priceCents != null ? ` · ${money(r.priceCents)}/yd` : " · no price yet"}
                      {l && l.step > 0 && l.regularCents != null ? ` · marked down ${l.step} of 3 (regular ${money(l.regularCents)})` : ""}
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="num font-semibold">{qtyText(r.qtyOnHand, "yd")}</span> left. {cutWords("FQ", r.qtyOnHand)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <FabricCuts id={r.id} yards={r.qtyOnHand} hasPrice={r.priceCents != null} />
                    {l && <FabricMarkdown id={r.id} source="bolt" offer={l.offer} undo={l.undo} stopped={l.stopped} />}
                    <Link href={`/fabric/kits/new?fabric=${r.id}`} className="btn btn-sm">
                      Use in a kit
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const fix1 = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));

function GradePill({ g }: { g: InsightItem["grade"] }) {
  const tone = g === "A" ? "tone-ready" : g === "B" ? "tone-work" : g === "C" ? "tone-neutral" : "tone-wait";
  return <span className={`pill ${tone}`}>{g === "unrated" ? "unrated" : `Grade ${g}`}</span>;
}

function WhatSells({ insight }: { insight: Insight }) {
  const { items, groups, gmroi, settings: s } = insight;
  const shown = items.slice(0, MAX_ROWS);
  if (items.length === 0) {
    return (
      <div className="card card-pad">
        <Empty>No fabric has sold or been in stock lately. Once fabric is in inventory and rung up at the register, this page shows what sells.</Empty>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        Yards a week are over the last {s.fabVelocityWeeks} weeks, counting only the days a fabric was in stock; a fabric that sells in lumps is smoothed (Croston), and a new one leans on similar fabrics
        until it has {s.fabBlendDays} days in stock. Margin uses the cost recorded when the sale was rung up
        {insight.linesWithoutCost > 0 ? ` (${insight.linesWithoutCost} older sale lines have none, so they use the fabric's cost today)` : ""}; stock value for GMROI uses today&apos;s cost. Grades A and B are the
        fabrics making the first {s.fabAbcAPct}% and {s.fabAbcBPct}% of 12-month margin.
      </p>
      <div className="card">
        <h2 className="card-pad pb-0 text-sm font-semibold">Best sellers first</h2>
        <ul className="divide-y divide-line" aria-label="What sells">
          {shown.map((i) => (
            <li key={i.id} className="card-pad flex flex-wrap items-start gap-3">
              <Swatch photoId={i.photoId} alt={i.description} />
              <div className="min-w-0 flex-1 space-y-1">
                <div>
                  <Link href={`/parts/${i.id}`} className="link mono">
                    {i.partNumber}
                  </Link>{" "}
                  {i.description}
                  <div className="muted text-xs">{[i.brand, i.collection, i.priceCents != null ? `${money(i.priceCents)}/yd` : null].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span>
                    <span className="num font-semibold">{i.perWeek >= 0.05 ? fix1(i.perWeek) : "0"}</span> yd a week
                  </span>
                  <span>
                    <span className="num font-semibold">{i.weeks == null ? "no sales" : `${fix1(i.weeks)} weeks`}</span> of supply
                  </span>
                  <span className="muted">{qtyText(i.qty, "yd")} on hand</span>
                  <GradePill g={i.grade} />
                  {i.early && <span className="pill tone-wait">early: {i.daysInStock} days in stock</span>}
                  {i.lumpy && <span className="pill tone-neutral">sells in lumps</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {items.length > shown.length && (
          <p className="muted card-pad text-xs">
            Showing the top {shown.length} of {items.length} fabrics.
          </p>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Rollup title="By maker" rows={groups.maker} />
        <Rollup title="By collection" rows={groups.collection} />
        <Rollup title="By designer" rows={groups.designer} />
        <Rollup title="By color tag" rows={groups.color} />
        <Rollup title="By price band" rows={groups.band} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Gmroi title="Margin return on inventory (GMROI) by maker" rows={gmroi.maker} windowDays={gmroi.windowDays} good={s.fabGmroiGood} review={s.fabGmroiReview} />
        <Gmroi title="GMROI by supplier" rows={gmroi.supplier} windowDays={gmroi.windowDays} good={s.fabGmroiGood} review={s.fabGmroiReview} />
      </div>
    </div>
  );
}

function Rollup({ title, rows }: { title: string; rows: GroupRow[] }) {
  const top = rows.slice(0, 12);
  return (
    <div className="card">
      <h2 className="card-pad pb-0 text-sm font-semibold">{title}</h2>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Group</th>
              <th className="text-right">Fabrics</th>
              <th className="text-right">Yd a week per fabric</th>
              <th className="text-right">Weeks of supply</th>
              <th className="text-right">12-month margin</th>
            </tr>
          </thead>
          <tbody>
            {top.map((g) => (
              <tr key={g.name}>
                <td>{g.name}</td>
                <td className="num text-right">{g.items}</td>
                <td className="num text-right">{fix1(g.perItem)}</td>
                <td className="num text-right">{g.weeks == null ? "-" : fix1(g.weeks)}</td>
                <td className="num text-right">{money(g.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > top.length && (
        <p className="muted card-pad text-xs">
          The top {top.length} of {rows.length} groups.
        </p>
      )}
    </div>
  );
}

function Gmroi({ title, rows, windowDays, good, review }: { title: string; rows: GmroiRow[]; windowDays: number; good: number; review: number }) {
  const label = { good: "tone-ready", ok: "tone-work", review: "tone-bad" } as const;
  return (
    <div className="card">
      <h2 className="card-pad pb-0 text-sm font-semibold">{title}</h2>
      <p className="muted card-pad pb-0 text-xs">
        Margin of the last {windowDays} days, scaled to a year, over the average stock at cost. {good} or more is good; under {review} needs a look.
      </p>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th>Group</th>
              <th className="text-right">Margin</th>
              <th className="text-right">Average stock at cost</th>
              <th className="text-right">GMROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 15).map((g) => (
              <tr key={g.name}>
                <td>{g.name}</td>
                <td className="num text-right">{money(g.margin)}</td>
                <td className="num text-right">{money(g.avgInventory)}</td>
                <td className="text-right">{g.value == null || g.band == null ? "-" : <span className={`pill ${label[g.band]}`}>{g.value.toFixed(1)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STAGE = { watch: "Watch", markdown: "First markdown", clearance: "Clearance" } as const;

function SlowFabric({ insight }: { insight: Insight }) {
  const { slow, settings: s } = insight;
  if (slow.length === 0) {
    return (
      <div className="card card-pad">
        <Empty>
          Nothing is slow right now. Fabric shows up here once it has sat {s.fabWatchDays} days since it came in with less than {s.fabMarkdownSoldPct}% sold (new fabric is left alone for its first {s.fabEarlyDays}{" "}
          days).
        </Empty>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="muted text-sm">
        Age is first in, first out from the receipts: watch at {s.fabWatchDays} days, first markdown at {s.fabMarkdownDays} (under {s.fabMarkdownSoldPct}% sold), clearance at {s.fabClearanceDays}. Yards cut or used
        count as sold. A yard&apos;s margin is its price less cost; fat quarters use the cut price, less {money(s.fabCutCostCents)} a yard for cutting. Nothing here changes a price until you tap Mark down.
      </p>
      <div className="card">
        <ul className="divide-y divide-line" aria-label="Slow fabric">
          {slow.slice(0, MAX_ROWS).map((r) => (
            <SlowItem key={r.item.id} r={r} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SlowItem({ r }: { r: SlowRow }) {
  const { item: i, ladder: l, convert: c } = r;
  const a = i.aged!;
  const tone = r.stage === "clearance" ? "tone-bad" : r.stage === "markdown" ? "tone-wait" : "tone-neutral";
  return (
    <li className="card-pad flex flex-wrap items-start gap-3">
      <Swatch photoId={i.photoId} alt={i.description} />
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <Link href={`/parts/${i.id}`} className="link mono">
            {i.partNumber}
          </Link>{" "}
          {i.description}
          <div className="muted text-xs">
            {[i.brand, i.collection, i.priceCents != null ? `${money(i.priceCents)}/yd` : "no price yet"].filter(Boolean).join(" · ")}
            {l.step > 0 && l.regularCents != null ? ` · marked down ${l.step} of 3 (regular ${money(l.regularCents)})` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className={`pill ${tone}`}>{STAGE[r.stage]}</span>
          <span>
            <span className="num font-semibold">{Math.round(a.ageDays)}</span> days on the shelf
            {Math.round(a.oldestDays) > Math.round(a.ageDays) + 14 ? <span className="muted"> (oldest {Math.round(a.oldestDays)})</span> : null}
          </span>
          <span>
            <span className="num font-semibold">{Math.round(a.soldShare * 100)}%</span> sold
          </span>
          <span className="muted">
            {qtyText(i.qty, "yd")} left{r.tiedUp != null ? `, ${money(r.tiedUp)} at cost` : ""}
          </span>
        </div>
        {c ? (
          <div className="text-sm">
            {l.offer ? (
              <span className={c.better === "markdown" ? "font-semibold" : ""}>
                Mark down {l.offer.pct}%: {money(c.markdownMargin)} a yard.
              </span>
            ) : (
              <span className="muted">{l.stopped === "floor" ? `At the lowest price the ladder allows (${money(l.floorCents)}).` : l.stopped === "last" ? "At the last markdown step." : ""}</span>
            )}{" "}
            <span className={c.better === "fq" ? "font-semibold" : ""}>As fat quarters: {money(c.fqMargin)} a yard.</span> <span className="pill tone-ready">{c.better === "fq" ? "Cut it" : "Mark it down"}</span>
            {i.yardCost == null && <span className="muted text-xs"> (no cost on file: these are prices, not margins)</span>}
          </div>
        ) : (
          <div className="muted text-sm">Give this fabric a price per yard to see what a markdown or fat quarters would earn.</div>
        )}
        <div className="flex flex-wrap gap-2">
          {c?.better === "fq" && <FabricCuts id={i.id} yards={i.qty} hasPrice={i.priceCents != null} fqOnly highlight />}
          <FabricMarkdown id={i.id} source="slow" offer={l.offer} undo={l.undo} stopped={l.stopped} highlight={c?.better === "markdown"} />
          {c?.better === "markdown" && <FabricCuts id={i.id} yards={i.qty} hasPrice={i.priceCents != null} fqOnly />}
        </div>
      </div>
    </li>
  );
}
