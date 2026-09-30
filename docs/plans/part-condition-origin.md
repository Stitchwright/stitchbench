# Parts: condition, who made it, and parts with no maker's number

Owner request (30 Sep 2026): parts for sale may be new, used or refurbished; genuine, a compatible (non-OEM)
replacement such as an aftermarket screen, or 3D printed; and some have no part number because the maker never gave
one. Decisions: the three "made by" values below and no others; the customer's invoice always says when a part is
used, refurbished, compatible or 3D printed; build before merging the round-3 fixes.

## The two labels

- **Condition**: New (default), Used, Refurbished (cleaned and tested).
- **Made by**: Genuine (default: the machine maker's part), Compatible (a non-genuine replacement), 3D printed.

They are independent: a part pulled from a donor machine is Genuine + Used; an aftermarket screen is Compatible + New;
a printed knob is 3D printed + New. Stored on the stock item (`Part.condition`, `Part.origin`).

## Parts with no maker's number

- The maker's part number is optional on a stock item. Left blank, the item gets a **shop number**: `SB-00001` in
  StitchBench, `SS-00001` in StitchShop, counted per company (`Shop.nextPartNumber`, taken atomically) and marked
  `Part.ownNumber = true`. It prints on labels, scans at the register and counts like any number.
- A shop number is never presented as the maker's: it isn't sent to the hub in usage reports, isn't put in a listing's
  or a cross-reference entry's part numbers, and the part page says "Shop number (the maker gives none)".
- Such a part is identified by its description, the models it fits and (on the marketplace) photos.
- The community cross-reference already takes an entry with a name and no numbers; the StitchBench form lets the
  numbers be blank when the models it fits are given. A 3D printed version is a "where to get it" source whose vendor
  is "3D print file" and whose link is the design (no price needed).

## The same part in two conditions

A second stock item for a number already in stock in another condition is saved as `<number> (used)` or
`<number> (refurbished)` with the maker's number among its other numbers (as consigned stock already gets `(own)`),
so a scan finds both. `baseNumber()` already drops the suffix for the cross-reference and usage.

## Where the labels show

- Parts list: small tags (Used, Refurbished, Compatible, 3D printed) and filters for both labels. Part page and the
  add/edit form: two selects. Spreadsheet import: optional Condition and Made by columns when the column mapping makes
  it easy (new/used/refurbished; genuine/OEM, compatible/aftermarket/generic, 3D printed/printed).
- Labels: a short tag under the description (USED, REFURB, COMPATIBLE, 3D PRINTED).
- A ticket line or register line made from such a part carries the disclosure in its description, written when the
  line is added so the invoice and receipt stay right if the part changes later: "Bobbin case (used)", "Touch screen
  (compatible, not genuine Brother)", "Spool pin knob (3D printed)", "Motor (used, compatible)".
- Inventory CSV export: condition, made_by, shop_number columns.
- Marketplace: the listing form's condition keeps New/Used/Refurbished and gains Made by; a listing started from a
  stock item is filled in from it (no part number when the item has a shop number). Listings show a tag and can be
  filtered. The hub stores `listings.origin` (null from installs that don't send it = not stated) and returns it; an
  order's item snapshot carries it.
- Partner shops: catalog items, orders and consignment carry `condition` and `origin` (optional fields; old installs
  ignore them), and the sewing shop's copy of a part gets them, so it can tell its customer too.

## Compatibility

All new fields are optional on the wire. Old installs keep working with the updated hub (listings without `origin`),
and new installs with an old hub (the hub ignores `origin`). Existing parts become New + Genuine with their numbers
unchanged.
