import { TriangleAlert } from "lucide-react";
import { ManualFigure } from "@/components/manual-figure";
import { OpenSpecSource } from "@/components/local-manuals";
import { modeAnchor, type ModeCard, type TestLink } from "@/lib/service-modes";

/** A model's test / service modes, listed together (test mode, touch panel calibration, service program ...). */
export function ServiceModes({ modes }: { modes: ModeCard[] }) {
  return (
    <div className="divide-y divide-line">
      {modes.map((m) => (
        <ServiceModeCard key={m.id} m={m} />
      ))}
    </div>
  );
}

function Steps({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div>
      <h4 className="label mb-1">{title}</h4>
      {steps.length ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : (
        <p className="muted text-sm">The manual doesn&rsquo;t say.</p>
      )}
    </div>
  );
}

/** One mode: how to enter and leave it, what each test does, its cautions, and the manual page with its picture. */
export function ServiceModeCard({ m }: { m: ModeCard }) {
  const check = !!m.confidence && m.confidence !== "high";
  return (
    <article id={modeAnchor(m.id, null)} className="scroll-mt-4 space-y-3 py-4 first:pt-0 last:pb-0" aria-label={`${m.mode}, ${m.brand} ${m.models}`}>
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">{m.mode}</h3>
          {check && (
            <span className="pill tone-wait" title={`${m.confidence} confidence: read from the manual, not yet tried on a machine`}>
              Check on the machine
            </span>
          )}
        </div>
        <div className="muted text-xs">
          {m.brand} {m.models}
        </div>
      </header>
      {m.cautions && (
        <p role="note" className="tone-wait flex gap-2 rounded px-3 py-2 text-sm">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Caution:</span> {m.cautions}
          </span>
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Steps title="To enter" steps={m.enterSteps} />
        <Steps title="To leave" steps={m.exitSteps} />
      </div>
      {m.tests.length > 0 && (
        <div>
          <h4 className="label mb-1">Tests ({m.tests.length})</h4>
          <table className="table">
            <thead className="sr-only">
              <tr>
                <th>Test</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {m.tests.map((t, i) => (
                <tr key={i} id={modeAnchor(m.id, i)} className="scroll-mt-4 target:bg-[var(--wait-bg)]">
                  <td className="mono w-px font-semibold whitespace-nowrap">{t.code || "-"}</td>
                  <td>{t.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {m.notes && <p className="muted text-xs">{m.notes}</p>}
      <div className="muted flex flex-wrap items-center gap-x-2 text-xs">
        <span className="max-w-full truncate" title={m.sourcePath ?? m.sourceFile}>
          {m.sourceFile}
          {m.pages ? `, p. ${m.pages}` : ""}
        </span>
        {m.page && <OpenSpecSource file={m.sourceFile} sourcePath={m.sourcePath} pages={String(m.page)} label={`Manual page ${m.page}`} />}
      </div>
      <ManualFigure file={m.sourceFile} sourcePath={m.sourcePath} page={m.figurePage} box={m.figureBox} figureId={m.figureId} stored={m.figureStored} openLink={false} />
    </article>
  );
}

/** `text` with its "test mode NN" made a link to the test (or to the mode, for a number no list has). */
export function LinkedText({ text, link }: { text: string; link?: TestLink & { href: string } }) {
  if (!link) return <>{text}</>;
  return (
    <>
      {text.slice(0, link.start)}
      <a href={link.href} className="link" title={link.title}>
        {text.slice(link.start, link.end)}
      </a>
      {text.slice(link.end)}
    </>
  );
}
