"use client";
// How many parts a text will take, as it's typed (scheduling-messaging-design.md section 5). Reads the textarea with
// `name` in the same form (or the page), adds what finalize() adds (the shop prefix, the STOP line) and shows parts, a
// warning when emoji or special characters make 70-character parts, and a cost hint from the shop's part price.
import { useEffect, useRef, useState } from "react";
import { render, smsParts } from "@/lib/messaging/templates";

export function SmsCounter({ name, prefix = "", suffix = "", partMills, vars }: { name: string; prefix?: string; suffix?: string; partMills?: number | null; vars?: Record<string, string> }) {
  const me = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const scope: ParentNode = me.current?.closest("form") ?? document;
    const box = scope.querySelector<HTMLTextAreaElement>(`textarea[name="${CSS.escape(name)}"]`) ?? document.querySelector<HTMLTextAreaElement>(`textarea[name="${CSS.escape(name)}"]`);
    if (!box) return;
    const update = () => setText(box.value);
    update();
    box.addEventListener("input", update);
    return () => box.removeEventListener("input", update);
  }, [name]);
  const body = vars ? render(text, vars) : text;
  const full = `${prefix}${body}${suffix}`;
  const { parts, unicode } = smsParts(full);
  const cents = partMills ? (parts * partMills) / 10 : null;
  return (
    <span ref={me} className="muted text-xs">
      {parts} part{parts === 1 ? "" : "s"} ({full.length} characters with the shop name{suffix ? " and the STOP line" : ""})
      {cents != null && parts > 0 && <> · about {cents.toFixed(1)}¢ a text</>}
      {unicode && <span className="pill tone-wait ml-2">Emoji or special characters: 70 characters a part instead of 160</span>}
    </span>
  );
}
