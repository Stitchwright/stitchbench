// Help switching from Square, Rain or Like Sew, and QuickBooks Desktop Point of Sale (shop-features-round-2-design.md
// 4.7): the ready-made layouts. Each system's export is read by its column names (any case, spaces and punctuation
// ignored, several names each because the systems name them differently by version); the program never guesses a
// column that isn't named. Pure: no "server-only", no database. The column names come from each system's documented
// exports and import templates as far as they could be checked; see the Built note for what is unverified.

export const SYSTEMS = { square: "Square", rain: "Rain or Like Sew", qbpos: "QuickBooks Point of Sale" } as const;
export type System = keyof typeof SYSTEMS;
export const isSystem = (s: unknown): s is System => typeof s === "string" && s in SYSTEMS;

export const KINDS = { items: "Items", customers: "Customers", giftcards: "Gift card balances" } as const;
export type Kind = keyof typeof KINDS;
export const isKind = (s: unknown): s is Kind => typeof s === "string" && s in KINDS;

type Cols = Record<string, string[]>;

/** Column names per system and kind. A name ending in "*" matches any column that starts with it ("Current Quantity Main St"). */
export const LAYOUTS: Record<System, Record<Kind, Cols>> = {
  square: {
    items: {
      number: ["SKU"],
      name: ["Item Name", "Name"],
      variation: ["Variation Name"],
      barcode: ["GTIN", "UPC", "Barcode"],
      price: ["Price"],
      cost: ["Default Unit Cost", "Unit Cost", "Cost"],
      qty: ["Current Quantity*", "Quantity", "Stock"],
      brand: ["Brand"],
      supplier: ["Default Vendor Name", "Vendor Name", "Vendor"],
      description: ["Description"],
    },
    customers: {
      first: ["First Name", "Given Name"],
      last: ["Last Name", "Family Name", "Surname"],
      name: ["Name", "Full Name"],
      email: ["Email Address", "Email"],
      phone: ["Phone Number", "Phone"],
      street: ["Street Address 1", "Address Line 1", "Street Address"],
      street2: ["Street Address 2", "Address Line 2"],
      city: ["City", "Locality"],
      state: ["State", "Administrative District Level 1"],
      zip: ["Postal Code", "Zip", "Zip Code"],
      company: ["Company Name", "Company"],
      birthday: ["Birthday"],
      notes: ["Memo", "Note", "Notes"],
      spend: ["Total Spend", "Total Spent"],
      visits: ["Transaction Count", "Number of Visits", "Visits"],
      firstVisit: ["First Visit"],
      lastVisit: ["Last Visit"],
      ref: ["Square Customer ID", "Reference ID"],
    },
    giftcards: {
      number: ["Gift Card Number", "GAN", "Card Number"],
      balance: ["Balance", "Current Balance", "Remaining Balance"],
      status: ["Status", "State"],
      email: ["Customer Email", "Email Address", "Email"],
    },
  },
  rain: {
    items: {
      number: ["SKU", "Item Number", "Item #", "Item No", "Product Code", "Part Number"],
      name: ["Name", "Item Name", "Product Name", "Title"],
      barcode: ["UPC", "Barcode", "UPC Code", "EAN"],
      price: ["Price", "Retail Price", "Sell Price", "Retail"],
      cost: ["Cost", "Unit Cost", "Avg Cost", "Average Cost"],
      qty: ["Qty", "Quantity", "On Hand", "Quantity On Hand", "Qty On Hand", "Stock", "Inventory"],
      brand: ["Manufacturer", "Brand", "Mfg"],
      supplier: ["Vendor", "Supplier", "Distributor"],
      description: ["Description", "Long Description"],
    },
    customers: {
      first: ["First Name", "First"],
      last: ["Last Name", "Last"],
      name: ["Name", "Customer Name", "Full Name"],
      email: ["Email", "Email Address", "E-mail"],
      phone: ["Phone", "Phone Number", "Cell", "Mobile", "Cell Phone", "Home Phone"],
      street: ["Address", "Address 1", "Street", "Address Line 1"],
      street2: ["Address 2", "Address Line 2"],
      city: ["City"],
      state: ["State", "Province"],
      zip: ["Zip", "Zip Code", "Postal Code"],
      company: ["Company"],
      birthday: ["Birthday", "Birth Date", "Date of Birth"],
      notes: ["Notes", "Note", "Comments"],
      spend: ["Total Spent", "Lifetime Sales", "Total Sales", "Lifetime Spend"],
      visits: ["Visits", "Number of Sales", "Sales Count", "Transactions"],
      firstVisit: ["Customer Since", "Created", "Date Added"],
      lastVisit: ["Last Purchase", "Last Sale", "Last Visit", "Last Purchase Date"],
      ref: ["Customer ID", "Customer Number", "ID"],
    },
    giftcards: {
      number: ["Gift Card Number", "Card Number", "Gift Card", "Number", "Code"],
      balance: ["Balance", "Remaining Balance", "Amount Remaining", "Current Balance"],
      status: ["Status"],
      email: ["Email", "Customer Email"],
    },
  },
  qbpos: {
    items: {
      number: ["Item Number", "Item #", "Item No"],
      name: ["Item Name", "Name"],
      description: ["Item Description", "Description 1", "Brief Description", "Description"],
      barcode: ["UPC", "Alternate Lookup", "Alt Lookup"],
      price: ["Regular Price", "Price 1", "Price"],
      cost: ["Average Unit Cost", "Avg Unit Cost", "Average Cost", "Order Cost", "Cost"],
      qty: ["On Hand Qty", "On-Hand Qty", "Qty 1", "Qty On Hand", "Quantity On Hand", "Quantity"],
      brand: ["Manufacturer", "Brand"],
      supplier: ["Vendor Name", "Vendor", "Vendor Code"],
    },
    customers: {
      first: ["First Name"],
      last: ["Last Name"],
      name: ["Full Name", "Customer Name", "Name"],
      email: ["EMail", "Email", "E-mail", "Email Address"],
      phone: ["Phone 1", "Phone", "Phone Number", "Phone 2"],
      street: ["Street", "Street 1", "Bill Street", "Address"],
      street2: ["Street 2", "Address 2"],
      city: ["City", "Bill City"],
      state: ["State", "Bill State"],
      zip: ["ZIP", "Zip Code", "Postal Code", "Bill ZIP"],
      company: ["Company", "Company Name"],
      birthday: ["Birthday"],
      notes: ["Notes", "Note", "Customer Notes"],
      spend: ["Total Sales", "Lifetime Sales"],
      visits: ["Number of Sales", "Sales Count"],
      firstVisit: ["Customer Since"],
      lastVisit: ["Last Sale", "Last Sale Date", "Last Purchase"],
      ref: ["Customer ID", "Customer Number", "Account Number"],
    },
    giftcards: {
      number: ["Gift Certificate #", "Gift Certificate Number", "Certificate Number", "Gift Card Number", "Number"],
      balance: ["Balance", "Remaining Balance", "Amount Remaining", "Amount"],
      status: ["Status"],
      email: ["Email", "EMail"],
    },
  },
};

/** "Current Quantity: Main St." -> "currentquantitymainst". */
export const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9#]/g, "");

/** For each field of the layout, the column it reads (-1: the file has none). */
export function columnsFor(layout: Cols, headers: string[]): Record<string, number> {
  const keys = headers.map(headerKey);
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const [field, names] of Object.entries(layout)) {
    let at = -1;
    for (const n of names) {
      const prefix = n.endsWith("*");
      const k = headerKey(prefix ? n.slice(0, -1) : n);
      at = keys.findIndex((h, i) => !used.has(i) && (prefix ? h.startsWith(k) : h === k));
      if (at >= 0) break;
    }
    out[field] = at;
    if (at >= 0) used.add(at);
  }
  return out;
}

/** The columns a kind can't do without. */
const NEEDS: Record<Kind, string[][]> = {
  items: [["number", "barcode", "name"], ["name", "description"]],
  customers: [["name", "first", "last"], ["email", "phone"]],
  giftcards: [["number"], ["balance"]],
};

/** What the file is missing for this kind, in words, or null when it can be read. */
export function missingColumns(kind: Kind, cols: Record<string, number>): string | null {
  const words: Record<string, string> = { number: "an item or card number", barcode: "a barcode", name: "a name", description: "a description", first: "a first name", last: "a last name", email: "an email", phone: "a phone", balance: "a balance" };
  for (const anyOf of NEEDS[kind]) {
    if (!anyOf.some((f) => (cols[f] ?? -1) >= 0)) return `This file has no column for ${anyOf.map((f) => words[f]).join(" or ")}. Check it's the ${KINDS[kind].toLowerCase()} export.`;
  }
  return null;
}

/** Which system and kind a file most looks like, from its column names (the best match; null when nothing fits). */
export function detect(headers: string[]): { system: System; kind: Kind } | null {
  const keys = new Set(headers.map(headerKey));
  // Names only one system uses settle it.
  const marks: [System, string][] = [
    ["square", "squarecustomerid"],
    ["square", "variationname"],
    ["square", "token"],
    ["qbpos", "regularprice"],
    ["qbpos", "averageunitcost"],
    ["qbpos", "phone1"],
    ["qbpos", "giftcertificate#"],
  ];
  let best: { system: System; kind: Kind; score: number } | null = null;
  for (const system of Object.keys(LAYOUTS) as System[]) {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const cols = columnsFor(LAYOUTS[system][kind], headers);
      if (missingColumns(kind, cols)) continue;
      const score = Object.values(cols).filter((i) => i >= 0).length + marks.filter(([s, k]) => s === system && keys.has(k)).length * 5;
      if (!best || score > best.score) best = { system, kind, score };
    }
  }
  return best ? { system: best.system, kind: best.kind } : null;
}

// ---------------------------------------------------------------- reading the rows

/** "$1,234.50", "1234.5", "(12.00)" -> cents; anything else -> null. */
export function moneyCell(v: string | undefined): number | null {
  const t = (v ?? "").trim().replace(/[$,\s]/g, "");
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[()-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/** "12", "12.0", "2.5" -> the number; blank or words -> null. */
export function qtyCell(v: string | undefined): number | null {
  const t = (v ?? "").trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type ItemIn = { partNumber: string; barcode: string | null; description: string; brand: string | null; supplier: string | null; costCents: number | null; priceCents: number | null; qty: number | null };
export type CustomerIn = { name: string; email: string | null; phone: string | null; address: string | null; notes: string | null; history: string | null; ref: string | null };
export type CardIn = { number: string; balanceCents: number; email: string | null };

const cellOf = (row: string[], cols: Record<string, number>, f: string) => ((cols[f] ?? -1) >= 0 ? (row[cols[f]] ?? "").trim() : "");

/** The items in a file, with problems by row (the header is row 1). Square's variations become "Item, Variation". */
export function readItems(system: System, table: string[][]): { rows: ItemIn[]; problems: string[]; cols: Record<string, number> } {
  const cols = columnsFor(LAYOUTS[system].items, table[0] ?? []);
  const rows: ItemIn[] = [];
  const problems: string[] = [];
  table.slice(1).forEach((r, i) => {
    const c = (f: string) => cellOf(r, cols, f);
    if (r.every((x) => !x.trim())) return;
    const variation = c("variation");
    const name = [c("name"), variation && !/^regular$/i.test(variation) ? variation : ""].filter(Boolean).join(", ") || c("description");
    const barcode = c("barcode").replace(/\s/g, "") || null;
    const number = c("number") || barcode || "";
    if (!number) return void problems.push(`Row ${i + 2} (${name || "no name"}): no item number or barcode, left out.`);
    if (!name) return void problems.push(`Row ${i + 2} (${number}): no name, left out.`);
    rows.push({ partNumber: number.slice(0, 60), barcode, description: name.slice(0, 200), brand: c("brand") || null, supplier: c("supplier") || null, costCents: moneyCell(c("cost")), priceCents: moneyCell(c("price")), qty: qtyCell(c("qty")) });
  });
  return { rows, problems, cols };
}

/** The customers in a file. What they spent and when they last came in (where the export has it) goes in her notes. */
export function readCustomers(system: System, table: string[][]): { rows: CustomerIn[]; problems: string[]; cols: Record<string, number> } {
  const cols = columnsFor(LAYOUTS[system].customers, table[0] ?? []);
  const rows: CustomerIn[] = [];
  const problems: string[] = [];
  const from = SYSTEMS[system].split(" or ")[0];
  table.slice(1).forEach((r, i) => {
    const c = (f: string) => cellOf(r, cols, f);
    if (r.every((x) => !x.trim())) return;
    const name = (c("name") || [c("first"), c("last")].filter(Boolean).join(" ") || c("company")).replace(/\s+/g, " ").trim();
    const email = c("email") || null;
    const phone = c("phone") || null;
    if (!name) return void problems.push(`Row ${i + 2}: no name, left out.`);
    if (!email && !phone) return void problems.push(`Row ${i + 2} (${name}): no email or phone, left out.`);
    const street = [c("street"), c("street2")].filter(Boolean).join(", ");
    const place = [c("city"), [c("state"), c("zip")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const address = [street, place].filter(Boolean).join(", ") || null;
    const spend = moneyCell(c("spend"));
    const hist = [
      spend != null ? `spent $${(spend / 100).toFixed(2)}` : "",
      c("visits") ? `${c("visits")} visit${c("visits") === "1" ? "" : "s"}` : "",
      c("firstVisit") ? `first ${c("firstVisit")}` : "",
      c("lastVisit") ? `last ${c("lastVisit")}` : "",
    ].filter(Boolean);
    const notes = [c("notes"), c("birthday") ? `Birthday: ${c("birthday")}` : "", c("company") && c("name") ? `Company: ${c("company")}` : ""].filter(Boolean).join("\n");
    rows.push({ name: name.slice(0, 120), email, phone, address: address?.slice(0, 300) ?? null, notes: notes || null, history: hist.length ? `From ${from}: ${hist.join(", ")}.` : null, ref: c("ref") || null });
  });
  return { rows, problems, cols };
}

/** The gift cards in a file: a number and a balance above zero; used up or cancelled cards are left out. */
export function readCards(system: System, table: string[][]): { rows: CardIn[]; problems: string[]; cols: Record<string, number> } {
  const cols = columnsFor(LAYOUTS[system].giftcards, table[0] ?? []);
  const rows: CardIn[] = [];
  const problems: string[] = [];
  table.slice(1).forEach((r, i) => {
    const c = (f: string) => cellOf(r, cols, f);
    if (r.every((x) => !x.trim())) return;
    const number = c("number").replace(/[\s-]/g, "").toUpperCase();
    const bal = moneyCell(c("balance"));
    if (/deactivat|cancel|void|inactive/i.test(c("status"))) return;
    if (!number) return void problems.push(`Row ${i + 2}: no card number, left out.`);
    if (/[*xX]{3,}/.test(c("number"))) return void problems.push(`Row ${i + 2}: the card number is hidden (${c("number")}), left out: the export must show whole numbers.`);
    if (bal == null) return void problems.push(`Row ${i + 2} (${number}): no balance, left out.`);
    if (bal <= 0) return;
    rows.push({ number, balanceCents: bal, email: c("email") || null });
  });
  return { rows, problems, cols };
}

/** How to get the file out of each system, in plain steps (the switch page shows them). */
export const HOW_TO_EXPORT: Record<System, Record<Kind, string[]>> = {
  square: {
    items: ["In your Square Dashboard, open Items, Item library.", "Choose Actions, Export library, and pick the spreadsheet.", "If it comes as an Excel file, open it and Save As \"CSV (Comma delimited)\"."],
    customers: ["In your Square Dashboard, open Customers, Customer directory.", "Choose Export customers (it is a CSV file)."],
    giftcards: ["In your Square Dashboard, open Gift cards, then Export.", "The file must show whole card numbers and balances."],
  },
  rain: {
    items: ["In Rain (or Like Sew), open your inventory list or inventory report.", "Choose Export, and save it as a CSV file."],
    customers: ["Open your customer list and choose Export, as a CSV file."],
    giftcards: ["Open the gift card list or report and Export it as a CSV file, with card numbers and balances."],
  },
  qbpos: {
    items: ["In QuickBooks Point of Sale, open Inventory, Item List.", "Choose File, Export (or right-click, Export List) and save a CSV file.", "Show the columns Item Number, Item Name, UPC, Regular Price, Average Unit Cost and On-Hand Qty first."],
    customers: ["Open Customers, Customer List, then File, Export, as a CSV file."],
    giftcards: ["Open Reports, Gift Certificates (outstanding balances), then Export it as a CSV file."],
  },
};
