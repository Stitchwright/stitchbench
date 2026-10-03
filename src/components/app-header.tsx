"use client";

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

/**
 * The sidebar's top on a phone is the logo, the search and a Menu button; the full menu opens under it (a disclosure
 * button, Escape closes it, and it closes on navigation). From md up the menu is always shown and the button is gone.
 */
export function AppHeader({ logo, search, children }: { logo: React.ReactNode; search: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(usePathname());
  const path = usePathname();
  const id = useId();
  if (seen !== path) {
    setSeen(path);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2 md:block md:py-0">
        <div className="max-w-[8.5rem] shrink-0 md:max-w-none md:py-5">{logo}</div>
        <div className="min-w-0 flex-1 md:flex-none">{search}</div>
        <button
          type="button"
          className="btn btn-sm shrink-0 md:hidden"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
          Menu
        </button>
      </div>
      <div id={id} className={open ? "block" : "hidden md:block"}>
        {children}
      </div>
    </>
  );
}
