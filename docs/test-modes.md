# Test modes: correcting the sheet and adding pictures

The test-mode card (handoff item 15) shows how to put a machine into its test, service or diagnostic mode, how to
leave it, what the numbered tests do, the cautions and the manual page. It is on the machine page, the ticket page and
the model page (under "Timing and adjustments", for the machines that show factory tension), and on `/specs` under "Test
modes". A factory setting that says "test mode 36" links to test 36 in the card.

The data comes from the owner's sheet, `C:\Manuals\_business-notes\Service_Modes.xlsx`:

1. Correct the sheet (steps in our own words, never a password; the rules are at the top of
   `scripts/library/service_modes_from_xlsx.py`).
2. `python scripts/library/service_modes_from_xlsx.py` writes `prisma/seed-data/service_modes.json`.
3. `npm run db:seed` loads it here. Hosted installs load it at the next deploy, and the Windows program at its first
   start after an update (it ships with the program).

## Pictures of the entry keys

For now every row shows its whole first manual page (the first number in `pages`) behind a "Show figure" button,
drawn from the tech's own PDF and then shared like a factory setting's figure. To show just the button diagram, add
two columns to the sheet (any position, the header names matter):

| column        | what to put in it                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `figure_page` | the PDF page with the picture (1-based, as in `pages`); blank = the first page in `pages`; `none` = no picture                  |
| `figure_box`  | the picture's edges as fractions of the page: `left, top, right, bottom`, e.g. `0.08, 0.30, 0.55, 0.62`; blank = the whole page |

To read the fractions: open the page in a PDF viewer, and divide the picture's left and right edges by the page width
and its top and bottom edges by the page height (0 is the left or top edge, 1 the right or bottom). A little margin
is fine. Start with the rows whose entry keys are only drawn: Brother E100, Singer 9910-9940, EverSewn Sparrow QE,
Elna 9006, Melco EP1B, Happy HCD2/HCD3. Then run steps 2 and 3 above; the script stops at a box it can't read and
names the row.

A changed box is a new picture: the first tech who opens it on a PC with the manual draws it, and it is saved for
everyone else then (phones and shops without the manual see it after that).
