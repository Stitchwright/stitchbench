"use client";
// The quilt planner (shop-features-round-2-design.md 5.3): what are we making (a pattern and size, or a plain quilt by
// size and block), the yards for each part worked out by the program, a fabric from the shelf for each part, and the pull
// list with Add all to the sale, Print the list and Make it a kit.
import Link from "next/link";
import { useMemo, useState } from "react";
import { PLAIN_DEFAULTS, plainQuiltPlan, plainQuiltProblem, QUILT_SIZES, type QuiltRole } from "@/lib/fabric-math";
import { money } from "@/lib/format";
import { yards } from "@/lib/register-math";
import type { PlannerFabric, PlannerPattern } from "@/lib/quilt";

export type Picks = Record<string, string>;

const num = (s: string) => {
  const n = Number(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

function SwatchImg({ f }: { f: PlannerFabric | undefined }) {
  if (!f) return <span className="inline-block h-11 w-11 shrink-0 rounded border border-dashed border-line" aria-hidden />;
  if (f.photoId)
    // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
    return <img src={`/api/parts/photo/${f.photoId}`} alt={`${f.name} swatch`} className="h-11 w-11 shrink-0 rounded border border-line object-cover" />;
  return <span className="inline-block h-11 w-11 shrink-0 rounded border border-line" style={{ background: f.colorHex ?? undefined }} aria-hidden />;
}

export const fabricLabel = (f: PlannerFabric) => `${f.name} (${f.partNumber}) · ${yards(f.yards)} yd${f.priceCents != null ? ` · ${money(f.priceCents)}/yd` : ""}`;

export function QuiltPlanner({
  patterns,
  fabrics,
  startPattern,
}: {
  patterns: PlannerPattern[];
  fabrics: PlannerFabric[];
  startPattern?: string | null;
}) {
  const first = patterns.find((p) => p.id === startPattern) ?? null;
  const [mode, setMode] = useState<"pattern" | "plain">(first || (patterns.length && !startPattern) ? "pattern" : "plain");
  const [patternId, setPatternId] = useState(first?.id ?? patterns[0]?.id ?? "");
  const pattern = patterns.find((p) => p.id === patternId) ?? null;
  const [size, setSize] = useState(first?.sizes[0]?.size ?? patterns[0]?.sizes[0]?.size ?? "");
  const [plain, setPlain] = useState({ sizeKey: "throw", width: String(PLAIN_DEFAULTS.widthIn), length: String(PLAIN_DEFAULTS.lengthIn), block: String(PLAIN_DEFAULTS.blockIn), fabrics: String(PLAIN_DEFAULTS.fabrics), bg: String(PLAIN_DEFAULTS.backgroundPct), border: String(PLAIN_DEFAULTS.borderIn) });
  const [picks, setPicks] = useState<Picks>({});
  const [find, setFind] = useState("");
  const setPick = (role: string, id: string) => setPicks((p) => ({ ...p, [role]: id }));

  const plainQ = { widthIn: num(plain.width), lengthIn: num(plain.length), blockIn: num(plain.block), fabrics: Math.round(num(plain.fabrics)), backgroundPct: num(plain.bg || "0"), borderIn: num(plain.border || "0") };
  const problem = mode === "plain" ? plainQuiltProblem(plainQ) : null;
  const plan = mode === "plain" && !problem ? plainQuiltPlan(plainQ) : null;
  const roles: QuiltRole[] = useMemo(() => {
    if (mode === "plain") return plan?.roles ?? [];
    return (pattern?.sizes.find((s) => s.size === size)?.roles ?? []).map((r) => ({ role: r.role, yards: r.yards, note: "from the pattern" }));
  }, [mode, plan, pattern, size]);

  const byId = useMemo(() => new Map(fabrics.map((f) => [f.id, f])), [fabrics]);
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (f: PlannerFabric) => !words.length || words.every((w) => `${f.name} ${f.partNumber} ${f.collection ?? ""} ${f.brand ?? ""} ${f.tags.join(" ")}`.toLowerCase().includes(w));

  // The pull list: a part with a fabric that has the yards; the same fabric for two parts is one line.
  const rows = roles.map((r) => ({ ...r, fabric: byId.get(picks[r.role] ?? "") }));
  const ready = rows.filter((r) => r.fabric && r.fabric.yards >= r.yards);
  const merged = new Map<string, number>();
  for (const r of ready) merged.set(r.fabric!.id, (merged.get(r.fabric!.id) ?? 0) + r.yards);
  const short = [...merged].filter(([id, y]) => (byId.get(id)?.yards ?? 0) < y).map(([id]) => byId.get(id)!.name);
  const total = ready.reduce((a, r) => a + Math.round(r.yards * (r.fabric!.priceCents ?? 0)), 0) + (mode === "pattern" && pattern?.priceCents ? pattern.priceCents : 0);
  const itemsParam = [...[...merged].map(([id, y]) => `${id}:${y}`), ...(mode === "pattern" && pattern ? [`${pattern.id}:1`] : [])].join(",");
  const kitParams = new URLSearchParams({ lines: [...merged].map(([id, y]) => `${id}:${y}`).join(","), ...(mode === "pattern" && pattern ? { pattern: pattern.id, name: `${pattern.name} (${size})` } : { name: `Quilt kit ${plan ? `${plan.finishedWidth} x ${plan.finishedLength}` : ""}`.trim() }) });

  return (
    <div className="space-y-4">
      <section className="card card-pad no-print space-y-3" aria-labelledby="q-what">
        <h2 id="q-what" className="h2">
          1. What are we making?
        </h2>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What are we making?">
          <label className={`btn ${mode === "pattern" ? "btn-primary" : ""}`}>
            <input type="radio" name="q-mode" className="sr-only" checked={mode === "pattern"} onChange={() => setMode("pattern")} /> From a pattern
          </label>
          <label className={`btn ${mode === "plain" ? "btn-primary" : ""}`}>
            <input type="radio" name="q-mode" className="sr-only" checked={mode === "plain"} onChange={() => setMode("plain")} /> A plain quilt
          </label>
        </div>
        {mode === "pattern" ? (
          patterns.length === 0 ? (
            <p className="text-sm">
              No pattern has its yardage typed in yet. Open a pattern in Inventory and fill in <strong>Yardage on the back</strong>, or plan a plain quilt.
            </p>
          ) : (
            <div className="grid-form">
              <div className="field">
                <label htmlFor="q-pattern" className="label">
                  Pattern
                </label>
                <select
                  id="q-pattern"
                  className="select"
                  value={patternId}
                  onChange={(e) => {
                    setPatternId(e.target.value);
                    setSize(patterns.find((p) => p.id === e.target.value)?.sizes[0]?.size ?? "");
                  }}
                >
                  {patterns.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.partNumber})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-size" className="label">
                  Size
                </label>
                <select id="q-size" className="select" value={size} onChange={(e) => setSize(e.target.value)}>
                  {(pattern?.sizes ?? []).map((s) => (
                    <option key={s.size}>{s.size}</option>
                  ))}
                </select>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div className="grid-form">
              <div className="field">
                <label htmlFor="q-qsize" className="label">
                  Quilt size
                </label>
                <select
                  id="q-qsize"
                  className="select"
                  value={plain.sizeKey}
                  onChange={(e) => {
                    const s = QUILT_SIZES.find((x) => x.key === e.target.value);
                    setPlain({ ...plain, sizeKey: e.target.value, ...(s ? { width: String(s.width), length: String(s.length) } : {}) });
                  }}
                >
                  {QUILT_SIZES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                  <option value="own">My own size</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-block" className="label">
                  Block size (inches, finished)
                </label>
                <input id="q-block" className="input num" inputMode="decimal" value={plain.block} onChange={(e) => setPlain({ ...plain, block: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="q-fabrics" className="label">
                  Fabrics in the blocks
                </label>
                <input id="q-fabrics" className="input num" inputMode="numeric" value={plain.fabrics} onChange={(e) => setPlain({ ...plain, fabrics: e.target.value })} />
              </div>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer">More choices: exact size, background, border</summary>
              <div className="grid-form mt-2">
                <div className="field">
                  <label htmlFor="q-width" className="label">
                    Width (inches)
                  </label>
                  <input id="q-width" className="input num" inputMode="decimal" value={plain.width} onChange={(e) => setPlain({ ...plain, sizeKey: "own", width: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="q-length" className="label">
                    Length (inches)
                  </label>
                  <input id="q-length" className="input num" inputMode="decimal" value={plain.length} onChange={(e) => setPlain({ ...plain, sizeKey: "own", length: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="q-bg" className="label">
                    Background (% of the blocks)
                  </label>
                  <input id="q-bg" className="input num" inputMode="numeric" value={plain.bg} onChange={(e) => setPlain({ ...plain, bg: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="q-border" className="label">
                    Border (inches, 0 for none)
                  </label>
                  <input id="q-border" className="input num" inputMode="decimal" value={plain.border} onChange={(e) => setPlain({ ...plain, border: e.target.value })} />
                </div>
              </div>
            </details>
            {problem ? (
              <p className="text-sm" role="alert">
                {problem}
              </p>
            ) : (
              plan && (
                <p className="muted text-sm">
                  {plan.cols} blocks across and {plan.rows} down ({plan.blocks} blocks): the quilt finishes at {plan.finishedWidth} x {plan.finishedLength} inches.
                </p>
              )
            )}
          </div>
        )}
        {roles.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Yards needed</h3>
            <ul className="text-sm" aria-label="Yards needed">
              {roles.map((r) => (
                <li key={r.role}>
                  {r.role}: <strong>{yards(r.yards)} yd</strong> <span className="muted text-xs">{r.note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {roles.length > 0 && (
        <section className="card card-pad no-print space-y-3" aria-labelledby="q-pick">
          <h2 id="q-pick" className="h2">
            2. Pick the fabrics
          </h2>
          {fabrics.length === 0 ? (
            <p className="text-sm">No fabric by the yard is in stock. Receive some fabric first.</p>
          ) : (
            <>
              <div className="field max-w-md">
                <label htmlFor="q-find" className="label">
                  Find a fabric (name, number, collection or color)
                </label>
                <input id="q-find" className="input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="navy, Kona, batik" />
              </div>
              <ul className="space-y-2">
                {roles.map((r) => {
                  const chosen = byId.get(picks[r.role] ?? "");
                  const options = fabrics.filter((f) => f.yards >= r.yards && (matches(f) || f.id === chosen?.id)).slice(0, 300);
                  return (
                    <li key={r.role} className="flex flex-wrap items-center gap-3">
                      <SwatchImg f={chosen} />
                      <div className="field min-w-64 flex-1">
                        <label htmlFor={`q-pick-${r.role}`} className="label">
                          {r.role} ({yards(r.yards)} yd)
                        </label>
                        <select id={`q-pick-${r.role}`} className="select" value={chosen?.id ?? ""} onChange={(e) => setPick(r.role, e.target.value)}>
                          <option value="">{options.length ? "Choose a fabric" : "Nothing in stock has enough yards"}</option>
                          {options.map((f) => (
                            <option key={f.id} value={f.id}>
                              {fabricLabel(f)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {ready.length > 0 && (
        <section className="card card-pad space-y-3" aria-labelledby="q-list">
          <h2 id="q-list" className="h2">
            3. The pull list
          </h2>
          <p className="hidden text-sm print:block">{mode === "pattern" && pattern ? `${pattern.name}, ${size}` : plan ? `Quilt ${plan.finishedWidth} x ${plan.finishedLength} inches` : ""}</p>
          <div className="overflow-x-auto">
            <table className="table" aria-label="Pull list">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Fabric</th>
                  <th className="text-right">Yards</th>
                  <th className="text-right">A yard</th>
                  <th className="text-right">Comes to</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((r) => (
                  <tr key={r.role}>
                    <td>{r.role}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <SwatchImg f={r.fabric} /> {r.fabric!.name} <span className="mono muted text-xs">{r.fabric!.partNumber}</span>
                      </span>
                    </td>
                    <td className="num text-right">{yards(r.yards)}</td>
                    <td className="num text-right">{r.fabric!.priceCents != null ? money(r.fabric!.priceCents) : "-"}</td>
                    <td className="num text-right">{money(Math.round(r.yards * (r.fabric!.priceCents ?? 0)))}</td>
                  </tr>
                ))}
                {mode === "pattern" && pattern && (
                  <tr>
                    <td>Pattern</td>
                    <td>{pattern.name}</td>
                    <td className="num text-right">1</td>
                    <td />
                    <td className="num text-right">{pattern.priceCents != null ? money(pattern.priceCents) : "-"}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={4} className="text-right font-semibold">
                    Total before tax
                  </td>
                  <td className="num text-right font-semibold">{money(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {ready.length < roles.length && <p className="muted text-sm">{roles.length - ready.length} part(s) still need a fabric.</p>}
          {short.length > 0 && <p className="text-sm" role="alert">Not enough on the bolt for two parts at once: {short.join(", ")}. Pick another fabric for one of them.</p>}
          <div className="no-print flex flex-wrap gap-2">
            <Link href={`/register?items=${encodeURIComponent(itemsParam)}`} className={`btn btn-primary ${short.length ? "pointer-events-none opacity-50" : ""}`} aria-disabled={short.length > 0}>
              Add all to the sale
            </Link>
            <button type="button" className="btn" onClick={() => window.print()}>
              Print the list
            </button>
            <Link href={`/fabric/kits/new?${kitParams}`} className="btn">
              Make it a kit
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
