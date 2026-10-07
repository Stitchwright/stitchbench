# Ease of use: principles for StitchBench and StitchShop

The owner's rule (7 Oct 2026): the program must be very easy to use, "like Apple, very intuitive". Most of the people
at the counter and the bench are older women, many not technical, working on a shop counter PC, a tablet or an older
laptop, often with a customer waiting. These principles are the yardstick for every screen. The audit of the current
screens against them is `ease-of-use-audit.md`.

Research on older users says the same thing in different ways: people over 60 are slower and less sure with
software, not less able. They read smaller text with more effort, miss low-contrast and tiny targets, are more
likely to blame themselves for an error and stop, and rely on what a screen says rather than on hidden gestures or
remembered tricks. A design that works for them works better for everyone, including the 25-year-old on a busy
Saturday.

## 1. Big enough to read, strong enough to see
- Body text 16px minimum (17px is Apple's default body size). Secondary text 14px, never below. Nothing a person
  must act on below 14px. Prices, totals and change due are large (24px or more).
- Labels in sentence case, not small UPPERCASE: uppercase is slower to read and shouts.
- Contrast at least WCAG 2.2 AA: 4.5:1 for text, 3:1 for input borders, focus rings and icons that carry meaning
  (WCAG 1.4.3, 1.4.11). Placeholder text counts as text.
- Works at 200% browser zoom and with Windows text scaling, without sideways scrolling (WCAG 1.4.4, 1.4.10).

## 2. Easy to hit
- Touch targets 44 x 44 px (Apple HIG) on anything a finger may press; never below 24 x 24 px (WCAG 2.5.8 AA).
  Leave at least 8px between neighbouring buttons. Checkboxes and radio buttons get a large clickable label.
- The main button of a screen is the biggest thing on it.

## 3. Shop words, not software words
- Say what the shop says: "payment" not "tender", "% off" not "Disc %", "stock" not "inventory quantity", "what the
  customer okayed" not "pre-approved over the service". One glossary (`ease-of-use-audit.md`, "Wording glossary") and every
  screen uses it.
- Name buttons with a verb and the thing: "Take payment", "Check in the machine", "Print 4 labels". Never "Submit",
  "OK", "Go".

## 4. One obvious main action per screen
- Every screen answers "what do I do here?" at a glance: one filled (navy) button for the main job, everything else
  plain. Two equal choices (Approved / Declined) look equal.
- Put the main action where the eye lands first: top of the page, or at the bottom of a short form.

## 5. Show the common, fold the rare (progressive disclosure)
- A form shows what is needed nine times out of ten; the rest sits under "More details". Fields that only apply to
  fabric appear only for fabric.
- Long pages become sections or tabs ordered by how often the shop uses them. Settings that are set once (hub,
  backups, keys, audit) live under "Advanced", away from daily work.
- The menu shows each person what they use; the rest is one tap away under "More".

## 6. Sensible defaults, forgiving input
- Pre-fill what is almost always true (today's date, the signed-in person, power cord and foot control, the usual
  bolt size). Remember the last choice where it is safe.
- Accept input the way people type it: phone numbers with or without dashes, "2 1/2" or "2.5" yards, "$12" or "12",
  names with typos ("dorthy" finds Dorothy), last four digits of a phone.
- Don't let a format rule block a sale: round to the nearest 1/8 yd and say so, rather than refusing.

## 7. Undo beats "Are you sure?"
- Do the action, then offer "Undo" for a while (a status change, a cut into fat quarters, a removed line, a deleted
  record). Keep confirmation only for what cannot be undone (refunds to a card, sending 400 texts), and then say
  exactly what will happen ("Send 412 texts now?") with time to read it.

## 8. Clear feedback after every action
- After every press the screen says what happened, in words, where the person is looking, and long enough to read
  (8 seconds or until dismissed). The result also shows on the page itself (the new row, the new status), not only
  in a pop-up that fades.
- At the register, the result of a sale (total paid, change due, "Print receipt") stays large on screen until the
  next sale starts.

## 9. Same place, same look, every time
- The menu, page title, back link and main button sit in the same places on every page. The same thing has the same
  name everywhere (a "customer" is never also an "account" on one screen and a "contact" on another).
- The same pattern for the same job: picking a customer works the same at check-in, at the register and in class
  sign-ups.

## 10. Empty screens teach; the first day is guided
- An empty list says what goes there and offers the button that adds the first one ("No customers yet. Add your first
  customer.").
- A new company sees a short "Getting started" checklist (shop details, tax, first items, staff, printer test) that
  ticks itself off and then goes away.

## 11. Errors say what to do
- Errors appear next to the field they are about, in plain words, with the fix: "Enter the machine's brand, like
  Janome or Brother." Never a code, never only a red border, never "Invalid input" (WCAG 3.3.1, 3.3.3).
- A search with no results says what was searched, suggests a spelling, and offers to add it.
- Never lose what someone typed because of one mistake.

## 12. Keyboard and scanner friendly at the counter
- The scan box has the focus whenever the register is idle; a scan always lands there (already true). Enter adds,
  and the whole sale can be finished from the keyboard. Tab order follows the screen.
- A visible focus ring on everything (WCAG 2.4.7) that is never hidden under a sticky bar or pop-up (WCAG 2.4.11).

## 13. Nothing hides behind hover or a tiny icon
- Tablets have no hover. Anything explained only in a tooltip (`title`) is invisible there: put it on the screen.
- Icons always come with a word ("Delete", not a bin alone). Status is never shown by colour alone.

## Sources
- Apple, Human Interface Guidelines: Accessibility (44 x 44 pt hit targets, contrast) and Typography (17 pt body text,
  Dynamic Type). https://developer.apple.com/design/human-interface-guidelines/accessibility ,
  https://developer.apple.com/design/human-interface-guidelines/typography
- Nielsen Norman Group, "Usability for Seniors" research and report (older users are slower, need larger text and
  targets, clearer errors; they blame themselves). https://www.nngroup.com/articles/usability-for-senior-citizens/ ,
  https://www.nngroup.com/reports/senior-citizens-on-the-web/
- Nielsen Norman Group, "Progressive Disclosure" and "10 Usability Heuristics" (visibility of system status, match
  with the real world, user control and freedom/undo, error recovery). https://www.nngroup.com/articles/progressive-disclosure/ ,
  https://www.nngroup.com/articles/ten-usability-heuristics/
- W3C, Web Content Accessibility Guidelines (WCAG) 2.2 (1.4.3 contrast, 1.4.11 non-text contrast, 2.5.8 target size,
  2.4.11 focus not obscured, 3.3.1 / 3.3.3 errors, 3.3.7 redundant entry). https://www.w3.org/TR/WCAG22/
- W3C WAI, "Older Users and Web Accessibility". https://www.w3.org/WAI/older-users/
