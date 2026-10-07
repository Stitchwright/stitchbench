// The fields of a co-op or rebate claim (shop-features-round-2-design.md 9.2), for a new claim and an existing one.
// The usual ones first; the program, where it ran and the note fold away.
export type CoopDraft = { maker: string; kind: string; program: string; adWhere: string; placedOn: string; spent: string; claim: string; deadline: string; note: string };

export function CoopFields({ d, p, lockClaim = false }: { d: CoopDraft; p: string; lockClaim?: boolean }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${p}maker`}>
          Maker
        </label>
        <input id={`${p}maker`} name="maker" className="input" required maxLength={80} defaultValue={d.maker} placeholder="Brother" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}kind`}>
          What kind
        </label>
        <select id={`${p}kind`} name="kind" className="select" defaultValue={d.kind}>
          <option value="COOP">Co-op advertising (an ad we paid for)</option>
          <option value="REBATE">Rebate (machines sold under a program)</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}spent`}>
          What we spent ($)
        </label>
        <input id={`${p}spent`} name="spent" inputMode="decimal" className="input num w-32" defaultValue={d.spent} />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}claim`}>
          What we can claim ($)
        </label>
        <input id={`${p}claim`} name="claim" inputMode="decimal" className="input num w-32" defaultValue={d.claim} disabled={lockClaim} />
        <p className="muted text-sm">Blank for co-op: half of what was spent.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}deadline`}>
          Send it by
        </label>
        <input id={`${p}deadline`} name="deadline" type="date" className="input" defaultValue={d.deadline} />
        <p className="muted text-sm">The dashboard reminds you two weeks before.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${p}proof`}>
          Photo of the ad or the invoice
        </label>
        <input id={`${p}proof`} name="proof" type="file" accept="image/*,application/pdf" className="input" />
      </div>
      <details className="sm:col-span-2">
        <summary className="link cursor-pointer text-sm">Program, where it ran and a note</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="field">
            <label className="label" htmlFor={`${p}program`}>
              Program
            </label>
            <input id={`${p}program`} name="program" className="input" maxLength={120} defaultValue={d.program} placeholder="Spring co-op 2026" />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${p}where`}>
              Where it ran
            </label>
            <input id={`${p}where`} name="adWhere" className="input" maxLength={120} defaultValue={d.adWhere} placeholder="The Gazette, Facebook" />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${p}placed`}>
              When it ran
            </label>
            <input id={`${p}placed`} name="placedOn" type="date" className="input" defaultValue={d.placedOn} />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${p}note`}>
              Note
            </label>
            <input id={`${p}note`} name="note" className="input" maxLength={1000} defaultValue={d.note} />
          </div>
        </div>
      </details>
    </>
  );
}
