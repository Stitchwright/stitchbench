// Parts the community cross-reference says fit this machine, and which ones are on this shop's shelf.
import Link from "next/link";
import { hubJoined } from "@/lib/hub";
import { modelKey } from "@/lib/format";
import { EVIDENCE_LABEL, partsFittingModel, type XFit, type XNumber } from "@/lib/parts";
import { Section, Empty } from "@/components/ui";

export async function PartsThatFit({ shopId, brand, model }: { shopId: string; brand: string; model: string }) {
  if (!(await hubJoined())) return null;
  const { xparts, stocked } = await partsFittingModel(shopId, brand, model);
  const key = modelKey(model);
  const shown = xparts.slice(0, 25);
  return (
    <Section title={`Parts that fit (${xparts.length})`}>
      {xparts.length === 0 ? (
        <Empty>Nothing in the cross-reference for the {model} yet.</Empty>
      ) : (
        <>
          <ul className="divide-y divide-line text-sm">
            {shown.map((x) => {
              const fit = (x.fits as XFit[]).find((f) => f.modelKey === key);
              const nums = x.numbers as XNumber[];
              const s = stocked.get(x.id);
              return (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link href={`/xref/${x.id}`} className="link">
                      {x.name}
                    </Link>{" "}
                    <span className="mono muted text-xs">{nums[0] ? nums[0].number : ""}</span>
                    {fit && fit.evidence !== "listed" && <span className="pill tone-ready ml-2">{EVIDENCE_LABEL[fit.evidence]}</span>}
                  </span>
                  {s ? (
                    <Link href={`/parts/${s.id}`} className="pill tone-ready">
                      {s.qtyOnHand} on the shelf{s.location ? ` · ${s.location}` : ""}
                    </Link>
                  ) : (
                    <span className="muted text-xs">not in stock</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted mt-2 text-xs">
            {xparts.length > shown.length && (
              <>
                Showing {shown.length} of {xparts.length}.{" "}
                <Link href={`/xref?q=${encodeURIComponent(model)}`} className="link">
                  See them all
                </Link>
                .{" "}
              </>
            )}
            Unmarked parts are in the {model}&apos;s parts list; marked ones were fitted by a tech.
          </p>
        </>
      )}
    </Section>
  );
}
