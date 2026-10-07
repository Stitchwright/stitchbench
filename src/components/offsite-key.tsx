"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmOffsiteKey, makeOffsiteKey } from "@/actions/offsite";
import { ActionForm, Submit, runAction } from "@/components/action-form";

/**
 * Makes the recovery key and shows it once as the recovery sheet to print (later-round-1-design.md 1.3). Backups switch on only
 * when the owner types the whole key back correctly. Closing the page forgets the key: the program keeps only the public half.
 */
export function OffsiteKey({ shopName, shopId, hasKey, on }: { shopName: string; shopId: string; hasKey: boolean; on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sheet, setSheet] = useState<{ key: string; made: string } | null>(null);

  const make = () =>
    start(async () => {
      const r = await runAction(() => makeOffsiteKey());
      if (r.error) toast.error(r.error);
      else if (r.shown) setSheet({ key: r.shown, made: new Date().toISOString().slice(0, 10) });
    });

  return (
    <div className="space-y-3">
      {!sheet && (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={make}>
          {hasKey ? "Make a new recovery key" : "Make my recovery key"}
        </button>
      )}
      {!sheet && hasKey && !on && <p className="text-sm font-semibold">A key was made but not confirmed, so backups are still off. Make a new key and print its sheet.</p>}
      {sheet && (
        <div className="space-y-3">
          <div className="card card-pad space-y-2 print:border-0" data-testid="recovery-sheet">
            <h3 className="text-lg font-semibold">Recovery sheet: {shopName}</h3>
            <p className="muted text-sm">
              Company {shopId} · made {sheet.made}
            </p>
            <p className="mono rounded border border-line px-3 py-3 text-lg tracking-wider break-all" data-testid="recovery-key">
              {sheet.key}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Keep this sheet somewhere safe, away from the shop computer: a file drawer or a safe.</li>
              <li>If the computer is lost, install StitchBench on another one, choose Restore from off-site backup, and type this key when it asks.</li>
              <li>Without this key nobody can open the backups, not even us. A lost sheet can&apos;t be printed again: make a new key and the old backups stay closed.</li>
            </ol>
          </div>
          <div className="no-print flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" onClick={() => window.print()}>
              Print the sheet
            </button>
          </div>
          <ActionForm action={confirmOffsiteKey} className="no-print space-y-2">
            <div className="field">
              <label htmlFor="offsite-key-typed" className="label">
                Type the key back from the sheet to turn backups on
              </label>
              <input id="offsite-key-typed" name="key" className="input mono" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH-..." />
            </div>
            <Submit>Turn backups on</Submit>
          </ActionForm>
          <button
            type="button"
            className="link no-print text-sm"
            onClick={() => {
              setSheet(null);
              router.refresh();
            }}
          >
            Close the sheet
          </button>
        </div>
      )}
    </div>
  );
}
