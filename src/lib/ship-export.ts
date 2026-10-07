// Shipping labels through Pirate Ship (shop-features-round-2-design.md 9.5, package ship-export). Pure: the address
// split and the rows, shared by the export route and its check. The online shop takes the shipping address as one
// box of text ("Name, street, city, state, ZIP"), so it is split here as well as it can be; Pirate Ship checks every
// address on import and flags the ones it can't use, and the export page names the ones split by guesswork.

export type Split = { street: string; line2: string; city: string; state: string; zip: string; country: string; sure: boolean };

const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP".split(" "),
);

/** "Jane Doe\n12 Elm St\nApt 4\nSpringfield, IL 62704" (or all on one line with commas) into its parts. */
export function splitAddress(raw: string, name?: string | null): Split {
  const text = String(raw ?? "").replace(/\r/g, "").trim();
  let parts = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  // The person's name on the first line is the label's name, not the street.
  if (parts.length > 1 && name && parts[0].toLowerCase().replace(/\W/g, "") === name.toLowerCase().replace(/\W/g, "")) parts.shift();
  let country = "US";
  if (parts.length > 1 && /^(usa|us|united states( of america)?)$/i.test(parts[parts.length - 1])) parts.pop();
  // The last part ends with "State ZIP"; the city is before it on the same part or the part before.
  const last = parts.length ? parts[parts.length - 1] : "";
  const m = /^(?:(.*?)[,\s]+)?([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/.exec(last);
  if (m && STATES.has(m[2].toUpperCase())) {
    parts.pop();
    let city = (m[1] ?? "").replace(/,$/, "").trim();
    if (!city && parts.length > 1) city = parts.pop()!;
    const [street = "", ...rest] = parts;
    return { street, line2: rest.join(", "), city, state: m[2].toUpperCase(), zip: m[3], country, sure: !!street && !!city };
  }
  country = "";
  return { street: parts.join(", "), line2: "", city: "", state: "", zip: "", country, sure: false };
}

export const PIRATE_SHIP_HEADER = ["Name", "Company", "Address", "Address Line 2", "City", "State", "Zipcode", "Country", "Email", "Phone", "Order ID", "Order Items", "Pounds", "Ounces", "Length", "Width", "Height"];

type Order = { number: number; name: string; email: string | null; phone: string | null; address: string | null; items: unknown };

/** One row per order, in Pirate Ship's spreadsheet layout (it maps the columns again on import). Weight and size are left for Pirate Ship to ask. */
export function pirateShipRows(orders: Order[]): { rows: string[][]; unsure: number[] } {
  const rows: string[][] = [PIRATE_SHIP_HEADER];
  const unsure: number[] = [];
  for (const o of orders) {
    const a = splitAddress(o.address ?? "", o.name);
    if (!a.sure) unsure.push(o.number);
    const items = Array.isArray(o.items) ? (o.items as { description?: string; qty?: number }[]).map((i) => `${i.qty ?? 1} x ${i.description ?? "item"}`).join("; ") : "";
    rows.push([o.name, "", a.street, a.line2, a.city, a.state, a.zip, a.country, o.email ?? "", o.phone ?? "", `#${o.number}`, items.slice(0, 500), "", "", "", "", ""]);
  }
  return { rows, unsure };
}
