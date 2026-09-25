"use client";

import { useRef } from "react";
import { FileUp } from "lucide-react";

/** The member invite from the hub admin: paste the code, or open the .stitchhub file into the box. */
export function InviteInput() {
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="field">
      <label htmlFor="hub-invite" className="label">
        Invite (paste the code, or open the invite file)
      </label>
      <textarea id="hub-invite" name="invite" ref={box} rows={3} className="textarea mono text-xs" placeholder="stitchhub:..." />
      <label className="btn btn-sm mt-2 w-fit cursor-pointer">
        <FileUp size={12} aria-hidden /> Open invite file
        <input
          type="file"
          accept=".stitchhub,application/json"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f && box.current) box.current.value = (await f.text()).trim();
          }}
        />
      </label>
    </div>
  );
}
