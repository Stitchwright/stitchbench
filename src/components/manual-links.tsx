// Where each manual for a model can be downloaded, from the community hub's catalog.
// Links only: the hub never holds a manual. Anyone can fix a dead link; history and rollback live on the hub.
// The section opens with what the model has and lacks by kind of manual (service, parts, operator, error codes,
// wiring), lists the links grouped by kind, and can queue every link for the model or the brand into the library.
import Link from "next/link";
import { Download, ExternalLink, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { fmtDate, modelKey } from "@/lib/format";
import { DOC_TYPES } from "@/lib/constants";
import { brandMatches, libraryFor } from "@/lib/model-info";
import { hubJoined } from "@/lib/hub";
import { libraryDir } from "@/lib/library-dir";
import { coverage, type Coverage } from "@/lib/manual-downloads";
import { Section, Empty } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { LinkHistory } from "@/components/link-history";
import { DownloadProgress } from "@/components/download-progress";
import { addManualLink, downloadManualLink, editManualLink, removeManualLink } from "@/actions/hub";
import { downloadBrandManuals, downloadModelManuals } from "@/actions/manual-downloads";

type LinkRow = Awaited<ReturnType<typeof db.manualLink.findMany>>[number];

const STATUS: Record<string, { label: string; tone: string }> = {
  ok: { label: "Working", tone: "tone-ready" },
  dead: { label: "Dead link", tone: "tone-bad" },
  blocked: { label: "Site blocks checks: try it in a browser", tone: "tone-wait" },
  unchecked: { label: "Not checked yet", tone: "tone-neutral" },
};

export const docLabel = (d: string | null) => (d ? d.replace(/([a-z])([A-Z])/g, "$1 $2") : "Manual");

function LinkFields({ l, brand, models }: { l?: LinkRow; brand?: string; models?: string }) {
  const id = l?.id ?? "new";
  return (
    <div className="grid-form">
      <div className="field">
        <label htmlFor={`lb-${id}`} className="label">
          Brand
        </label>
        <input id={`lb-${id}`} name="brand" defaultValue={l?.brand ?? brand} required className="input" />
      </div>
      <div className="field">
        <label htmlFor={`lm-${id}`} className="label">
          Model(s)
        </label>
        <input id={`lm-${id}`} name="models" defaultValue={l?.models ?? models} required className="input" />
      </div>
      <div className="field">
        <label htmlFor={`ld-${id}`} className="label">
          Kind of manual
        </label>
        <select id={`ld-${id}`} name="docType" defaultValue={l?.docType ?? "ServiceManual"} className="select">
          {DOC_TYPES.map((d) => (
            <option key={d} value={d}>
              {docLabel(d)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`lt-${id}`} className="label">
          Title (optional)
        </label>
        <input id={`lt-${id}`} name="title" defaultValue={l?.title} className="input" />
      </div>
      <div className="field sm:col-span-2">
        <label htmlFor={`lu-${id}`} className="label">
          Link (where the PDF can be downloaded)
        </label>
        <input id={`lu-${id}`} name="url" type="url" defaultValue={l?.url} required className="input mono" placeholder="https://" />
      </div>
      <div className="field sm:col-span-2">
        <label htmlFor={`ln-${id}`} className="label">
          Note for the history (optional)
        </label>
        <input id={`ln-${id}`} name="note" className="input" placeholder={l ? "e.g. old link moved to the new support site" : "e.g. found on the maker's support page"} />
      </div>
    </div>
  );
}

export function ManualLinkItem({ l, canDownload, showModel, timeZone }: { l: LinkRow; canDownload: boolean; showModel?: boolean; timeZone: string }) {
  const st = STATUS[l.status] ?? STATUS.unchecked;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <a href={l.url} target="_blank" rel="noreferrer" className="link font-semibold break-words">
            {l.title} <ExternalLink size={11} className="inline" aria-hidden />
          </a>
          <div className="muted mt-0.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="pill tone-neutral">{docLabel(l.docType)}</span>
            {showModel && (
              <span>
                {l.brand} {l.models}
              </span>
            )}
            <span>{l.source}</span>
            <span className={`pill ${st.tone}`}>{st.label}</span>
            {l.checkedAt && l.status !== "unchecked" && <span>checked {fmtDate(l.checkedAt, timeZone)}</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        {canDownload && l.status !== "dead" && (
          <ActionButton action={downloadManualLink.bind(null, l.id)} className="btn btn-sm" success="Saved to the manual library">
            <Download size={12} aria-hidden /> Download to library
          </ActionButton>
        )}
        <details>
          <summary className="btn btn-sm cursor-pointer">Fix link</summary>
          <ActionForm action={editManualLink.bind(null, l.id)} success="Link fixed for every shop" className="mt-2 space-y-2">
            <LinkFields l={l} />
            <Submit className="btn btn-sm btn-primary">Save for everyone</Submit>
          </ActionForm>
        </details>
        <LinkHistory linkId={l.id} />
        <ActionButton
          action={removeManualLink.bind(null, l.id)}
          className="btn btn-sm btn-danger"
          confirm="Remove for everyone?"
          success="Removed (it can be restored from the hub)"
          title="Remove link"
        >
          <Trash2 size={12} aria-label="Remove" />
        </ActionButton>
      </div>
    </li>
  );
}

export async function linksFor(brand: string, model: string) {
  const key = modelKey(model);
  if (!key) return [];
  const rows = await db.manualLink.findMany({ where: { modelKeys: { has: key } }, orderBy: [{ docType: "asc" }, { title: "asc" }] });
  return rows.filter((l) => brandMatches(l.brand, brand));
}

const COVER_TONE: Record<Coverage["state"], { tone: string; words: (c: Coverage) => string }> = {
  have: { tone: "tone-ready", words: (c) => (c.have === 1 ? "in the library" : `${c.have} in the library`) },
  link: { tone: "tone-wait", words: (c) => (c.links === 1 ? "link only, not downloaded" : `${c.links} links, none downloaded`) },
  missing: { tone: "tone-bad", words: (c) => (c.dead ? `missing (${c.dead} dead link${c.dead === 1 ? "" : "s"})` : "missing: nothing to download") },
};

/** What the model has and lacks, by kind of manual: a pill per kind. */
export function DocCoverage({ cover, model }: { cover: Coverage[]; model: string }) {
  const missing = cover.filter((c) => c.state === "missing").map((c) => docLabel(c.docType).toLowerCase());
  return (
    <div className="mb-3">
      <ul className="flex flex-wrap gap-1.5" aria-label={`Kinds of manual for the ${model}`}>
        {cover.map((c) => (
          <li key={c.docType} className={`pill ${COVER_TONE[c.state].tone}`} title={COVER_TONE[c.state].words(c)}>
            {docLabel(c.docType)}: {COVER_TONE[c.state].words(c)}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="muted mt-1 text-xs">
          Nobody has shared a {missing.join(", ")} for the {model} yet. If you find one, add the link below so every shop can get it.
        </p>
      )}
    </div>
  );
}

export async function ManualLinks({ shopId, brand, model, timeZone }: { shopId?: string; brand: string; model: string; timeZone: string }) {
  if (!(await hubJoined())) {
    return (
      <Section title="Manual links">
        <Empty>
          Join the community hub (
          <Link href="/settings#hub" className="link">
            Settings → Community hub
          </Link>
          ) to see where every shop has found manuals for the {model}, and to share links you find.
        </Empty>
      </Section>
    );
  }
  const [links, docs] = await Promise.all([linksFor(brand, model), libraryFor(brand, model)]);
  const canDownload = libraryDir() != null;
  const dead = links.filter((l) => l.status === "dead").length;
  const cover = coverage(docs, links);
  // Grouped by the kind of manual the links carry, in the library's order (service first, parts last); unknown kinds at the end.
  const order = new Map(cover.map((c, i) => [c.docType, i]));
  const groups = new Map<string, LinkRow[]>();
  for (const l of [...links].sort((a, b) => (order.get(a.docType ?? "") ?? 99) - (order.get(b.docType ?? "") ?? 99) || a.title.localeCompare(b.title))) {
    const k = l.docType ?? "";
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const toGet = links.filter((l) => l.status !== "dead").length;
  return (
    <Section
      title={`Manual links (${links.length})`}
      actions={
        canDownload && toGet > 0 ? (
          <div className="flex flex-wrap gap-2">
            <ActionButton
              action={downloadModelManuals.bind(null, brand, model)}
              className="btn btn-sm"
              success={`Queued: every ${model} link not yet in the library`}
              title="Download every working link for this model into the library, one at a time"
            >
              <Download size={12} aria-hidden /> Download all for the {model}
            </ActionButton>
            <ActionButton
              action={downloadBrandManuals.bind(null, brand)}
              className="btn btn-sm"
              confirm={`Every ${brand} link?`}
              success={`Queued: every ${brand} link not yet in the library`}
              title={`Download every working ${brand} link into the library, one at a time`}
            >
              <Download size={12} aria-hidden /> All {brand}
            </ActionButton>
          </div>
        ) : undefined
      }
    >
      <DocCoverage cover={cover} model={model} />
      <p className="muted mb-1 text-xs">
        Where each manual can be downloaded, shared by every shop on the hub. Anyone can fix a link; every change can be rolled back.
        {dead > 0 && ` ${dead} dead: if you find where it moved, fix it for everyone.`}
      </p>
      {links.length === 0 ? (
        <Empty>No links for the {model} yet.</Empty>
      ) : (
        <div className="space-y-2">
          {[...groups.entries()].map(([k, rows]) => (
            <div key={k || "other"}>
              <div className="label">{k ? docLabel(k) : "Other"}</div>
              <ul className="divide-y divide-line">
                {rows.map((l) => (
                  <ManualLinkItem key={l.id} l={l} canDownload={canDownload} timeZone={timeZone} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {shopId && canDownload && (
        <div className="mt-3">
          <DownloadProgress shopId={shopId} timeZone={timeZone} labels={[`${brand} ${model}`, brand]} />
        </div>
      )}
      <details className="mt-3 border-t border-line pt-3">
        <summary className="link cursor-pointer text-sm">Add a link for the {model}</summary>
        <ActionForm action={addManualLink} reset success="Link shared with every shop" className="mt-2 space-y-2">
          <LinkFields brand={brand} models={model} />
          <Submit className="btn btn-sm btn-primary">Share link</Submit>
        </ActionForm>
      </details>
    </Section>
  );
}
