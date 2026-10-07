// Starter care tips per kind of machine (shop-features-round-2-design.md 5.5): the shop adds them with one tap and
// changes them as it likes; the pickup sheet picks only from the shop's own list. Pure.

export const STARTER_TIPS: Record<string, string[]> = {
  sewing: [
    "Change the needle every 8 hours of sewing, or when you start a new project.",
    "Brush the lint out of the bobbin area every time you change the bobbin.",
    "Cover the machine when you're not using it to keep dust out.",
    "Use good quality thread: cheap thread sheds lint and breaks.",
    "Bring it in for a clean and oil once a year, or sooner if you sew every day.",
  ],
  vacuum: [
    "Change the bag when it's two-thirds full: a full bag loses suction.",
    "Rinse or change the filters as the manual says, and let them dry completely.",
    "Cut threads and hair off the brush roll every few weeks.",
    "Don't pick up water, ash or fine powder unless the vacuum is made for it.",
    "Check the belt every few months; a stretched belt stops the brush.",
  ],
  "stand-mixer": [
    "Don't run it at high speed with stiff dough: use a low speed and let it rest.",
    "Wipe the body with a damp cloth; never put the motor head in water.",
    "Bring it in if it gets hot, loud or smells of oil.",
  ],
  "3d-printer": [
    "Keep filament dry in a sealed box with desiccant.",
    "Clean the build plate with isopropyl alcohol before printing.",
    "Check that the belts are snug and the nozzle is clean every few weeks.",
  ],
  "resin-printer": [
    "Wear gloves when you handle resin, and work with the window open.",
    "Filter the resin in the vat back into the bottle after a few prints.",
    "Keep the screen and the vat film clean and free of scratches.",
  ],
};

/** Starter tips for a kind (the sewing ones for a shop's own kind that has none). */
export const startersFor = (kind: string): string[] => STARTER_TIPS[kind] ?? [];

export const MAX_TIP = 300;
export const MAX_TIPS_PER_KIND = 40;
