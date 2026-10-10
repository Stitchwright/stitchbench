// What each release changed, in plain words for shop staff. Newest first. Read by the "What's new" card and page, and by
// scripts/release/publish-release.mjs (keep this file free of imports). Lines: short, warm, 90 characters at most.
export const WHATS_NEW: { version: string; date: string; stitchbench: string[]; stitchshop: string[] }[] = [
  {
    version: "1.7.2",
    date: "2026-10-10",
    stitchbench: ["A test of the one-button update (not a real release)."],
    stitchshop: ["A test of the one-button update (not a real release)."],
  },
  {
    version: "1.7.1",
    date: "2026-10-10",
    stitchbench: [
      "New Help button: tell us something's wrong, share an idea, or rate StitchBench.",
      "When we answer you, the answer shows up right in Help.",
      "Texting set-up guide in Settings, under Messages, one step at a time.",
      "When a new version is ready, a notice appears with one button to update.",
      "Getting started list on the first page, so you can see what's left to set up.",
    ],
    stitchshop: [
      "New Help button: tell us something's wrong, share an idea, or rate StitchShop.",
      "When we answer you, the answer shows up right in Help.",
      "Texting set-up guide in Settings, under Messages, one step at a time.",
      "When a new version is ready, a notice appears with one button to update.",
      "Getting started list at the register, so you can see what's left to set up.",
    ],
  },
];
