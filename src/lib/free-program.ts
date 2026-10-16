// The programs are free (owner, 15 Oct 2026): StitchBench and StitchShop cost nothing, and a YouTube channel and donations
// pay for them. While this is on (the default) the program never goes read-only for want of a key, every add-on is on
// whatever keys the company holds, and Solo's two-login limit does not apply. The StitchHub hub says the same in the
// keys it signs (it comps every shop to 2099), so a program on an older version or with no hub behaves the same way.
// PROGRAM_FREE=off brings the key rules back (the check scripts and the end-to-end tests that test them set it).
// Pure: no "server-only" and no database, so check scripts can import it.
export const freeProgram = () => !/^(off|0|false|no)$/i.test((process.env.PROGRAM_FREE ?? "").trim());

/** The Assistant answers cost money for every question, so it is not part of "free": it keeps its own key. */
export const FREE_EXCLUDED = ["assistant"] as const;
