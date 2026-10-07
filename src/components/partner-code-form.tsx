"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { makePartnerCode, type InviteResult } from "@/actions/partners";

/** Make a partner code (with the terms offered) and show it to read out or send. */
export function PartnerCodeForm({ defaultSide, children }: { defaultSide: "repair" | "retail"; children: React.ReactNode }) {
  const [result, setResult] = useState<Extract<InviteResult, { code: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const longCode = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-4">
      <form
        className="grid-form"
        action={async (fd) => {
          setBusy(true);
          try {
            const r = await makePartnerCode(fd);
            if ("error" in r) toast.error(r.error);
            else setResult(r);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="side" className="label">
            This shop is the
          </label>
          <select id="side" name="side" defaultValue={defaultSide} className="select">
            <option value="repair">Repair shop (the other shop takes machines in for us)</option>
            <option value="retail">Sewing / quilt shop (we take machines in for them)</option>
          </select>
        </div>
        {children}
        <div className="sm:col-span-2">
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Making..." : "Make partner code"}
          </button>
        </div>
      </form>
      {result && (
        <div className="card card-pad space-y-2" role="status">
          <div className="label">Partner code (good for 14 days, works once)</div>
          <div className="mono text-3xl font-bold tracking-widest" data-testid="partner-code">
            {result.code}
          </div>
          <p className="muted text-sm">
            The other shop opens Partners and types it under &quot;Enter a partner code&quot;. If they aren&apos;t on the same hub, send them the long
            version instead:
          </p>
          <div className="flex gap-2">
            <input ref={longCode} readOnly value={result.long} className="input mono text-xs" aria-label="Long partner code" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.long);
                  toast.success("Copied");
                } catch {
                  // No clipboard on a plain http address (a phone on the shop network): select the code to copy by hand.
                  longCode.current?.select();
                  toast.error("Couldn't copy here. The code is selected: copy it by hand.");
                }
              }}
              aria-label="Copy the long code"
            >
              <Copy size={14} aria-hidden />
            </button>
          </div>
          <p className="muted text-sm">
            This shop&apos;s signing key: <span className="mono" data-testid="partner-fingerprint">{result.fingerprint}</span>. The other shop sees theirs on the partnership&apos;s page; read the two to each other to be sure no one
            stepped in between (the long code checks it for you).
          </p>
        </div>
      )}
    </div>
  );
}
