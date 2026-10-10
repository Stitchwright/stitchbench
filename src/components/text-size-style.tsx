"use client";
// Applies the person's text size to <html> from the server render (a <style> in the page, so there is no flash). Print
// views (/.../print) are marked data-text-off so tags and paperwork show at their designed size; the CSS also resets
// the size in @media print for every other page.
import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { textSizeCss, type TextSize } from "@/lib/text-size";

export function TextSizeStyle({ size }: { size: TextSize }) {
  const pathname = usePathname();
  const off = /\/print(\/|$)/.test(pathname ?? "");
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (off) el.setAttribute("data-text-off", "");
    else el.removeAttribute("data-text-off");
    return () => el.removeAttribute("data-text-off");
  }, [off]);
  const css = textSizeCss(size);
  return css ? <style id="text-size" dangerouslySetInnerHTML={{ __html: css }} /> : null;
}
