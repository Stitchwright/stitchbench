// A reusable demo company for showing StitchShop: "Bobbin & Bolt Quilt Co.", an invented quilt shop that also services
// sewing and embroidery machines, with every add-on module on and about a month of believable history.
//   npx tsx scripts/demo/seed-demo.ts            make it (running it again resets it: the old demo company is deleted first)
//   npx tsx scripts/demo/seed-demo.ts --remove   delete the demo company and everything in it
// Login: demo@stitchshop.test, password DEMO_PASSWORD or demo-password-1. Every date is worked out from today, so a re-run
// is always fresh. Everything is invented (555-01xx phones, example.com emails, a made-up town). Optional
// scripts/demo/guest.local.json (gitignored) adds one real person the demo is shown to as a customer with machines in
// the shop; see GuestFile below. Refuses a database that isn't on this PC unless DEMO_ALLOW_REMOTE=yes and DEMO_PASSWORD are set.
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { swatchPng, type SwatchKind } from "./swatch";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_EMAIL = "demo@stitchshop.test";
const SHOP_NAME = "Bobbin & Bolt Quilt Co.";
const TZ = "America/Chicago";
const TAX = 5.5;

// ---------- the database: this PC only unless told otherwise ----------
function databaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (.env).");
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!local && !(process.env.DEMO_ALLOW_REMOTE === "yes" && process.env.DEMO_PASSWORD)) {
    throw new Error(`Refusing to run: the database host is ${u.hostname}, not this PC. Set DEMO_ALLOW_REMOTE=yes and DEMO_PASSWORD to seed it anyway.`);
  }
  if (u.hostname === "localhost") u.hostname = "127.0.0.1"; // localhost can hang on this PC (IPv6 relay)
  return u.toString();
}
process.env.DATABASE_URL = databaseUrl();

type GuestFile = { firstName: string; lastName?: string; machines: { make: string; model: string; kind?: string; job: string; stage: string; part?: string; partPriceCents?: number }[] };

// ---------- small helpers ----------
let seed = 20261003;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const roundCents = (x: number) => Math.round(x);

function main() {
  return run().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

async function run() {
  const { db } = await import("../../src/lib/db");
  const { modelKey, brandKey } = await import("../../src/lib/format");
  const { dayStartIn, addDaysYmd } = await import("../../src/lib/license");
  const { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU, starterKindFor } = await import("../../src/lib/service-menu");
  const { grantDevLicense } = await import("../license/dev");
  void brandKey;

  try {
    // ---------- remove the old demo company ----------
    const old = await db.user.findFirst({ where: { email: DEMO_EMAIL }, select: { shopId: true } });
    if (old) {
      // Tickets first: a ticket holds its machine (restrict), so the company's cascade can't start with the machines.
      await db.ticket.deleteMany({ where: { shopId: old.shopId } });
      await db.shop.delete({ where: { id: old.shopId } });
      console.log("Removed the old demo company.");
    }
    if (process.argv.includes("--remove")) return;

    const password = process.env.DEMO_PASSWORD ?? "demo-password-1";
    const hash = await bcrypt.hash(password, 10);

    // ---------- time helpers (the shop's own zone) ----------
    const ymdIn = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const now = new Date();
    const todayYmd = ymdIn(now);
    const dayYmd = (n: number) => addDaysYmd(todayYmd, n);
    const dow = (n: number) => new Date(`${dayYmd(n)}T12:00:00Z`).getUTCDay(); // 0 = Sunday
    const at = (n: number, hm: string) => {
      const [h, m] = hm.split(":").map(Number);
      return new Date(dayStartIn(dayYmd(n), TZ).getTime() + (h * 60 + m) * 60_000);
    };
    const ago = (days: number, hm = "10:30") => at(-days, hm);
    const MIN = 60_000;

    // ---------- the company ----------
    const shop = await db.shop.create({
      data: {
        name: SHOP_NAME,
        phone: "(715) 555-0142",
        email: "hello@example.com",
        address: "214 Spool Street, Maple Hollow, WI 54999",
        laborRateCents: 9800,
        taxRatePct: TAX,
        partsMarkupPct: 30,
        timeZone: TZ,
        doesRepair: true,
        sellsRetail: true,
        checklistItems: DEFAULT_CHECKLIST,
        receiptNote: "Thank you for shopping Bobbin & Bolt! Returns within 14 days with receipt, uncut fabric only. Open Tue-Sat 10-5.",
        priceListNote: "Machines are quoted after a free look at the counter. We call before any work over the quote.",
        payInstructions: null,
        checkInKind: "sewing",
        // Online booking and the online shop share one public address.
        bookingSlug: "bobbin-and-bolt",
        bookingOn: true,
        bookingLeadHours: 12,
        bookingDaysAhead: 45,
        bookingWelcome: "Book a machine drop-off, a longarm rental or a private lesson, or sign up for a class. We will email you a confirmation.",
        shopOn: true,
        shopPickup: true,
        shopShipping: true,
        shopShipCents: 695,
        shopFreeOverCents: 7500,
        shopPayVia: "platform",
        shopWelcome: "Fat quarters, precuts, notions and patterns from our shelves in Maple Hollow. Pick up at the counter, or we ship anywhere in the U.S.",
        shopPickupNote: "Pick up Tue-Sat 10-5 at the front counter. We will email you when your order is packed.",
        serviceItems: { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: s.priceCents, sortOrder: i, equipmentKind: starterKindFor(s.name) })) },
      },
      select: { id: true },
    });
    const shopId = shop.id;

    // ---------- people who work here ----------
    const mkUser = (email: string, name: string, role: "OWNER" | "ADMIN" | "TECH") => db.user.create({ data: { shopId, email, name, role, passwordHash: hash }, select: { id: true, name: true } });
    const marlene = await mkUser(DEMO_EMAIL, "Marlene Hartwell", "OWNER");
    const priya = await mkUser("priya.nair@example.com", "Priya Nair", "ADMIN");
    const gus = await mkUser("gus.okafor@example.com", "Gus Okafor", "TECH");

    // Every add-on module, with a development key (it counts on a test build against a database on this PC).
    await grantDevLicense(shopId, ["vac", "appliance", "scheduling", "marketing"], { from: dayYmd(-30), until: dayYmd(335) });

    // ---------- customers ----------
    type C = { key: string; name: string; phone?: string; email?: string; address?: string; notes?: string; notify?: string };
    const custs: C[] = [
      { key: "linda", name: "Linda Marchetti", phone: "(715) 555-0113", email: "linda.marchetti@example.com", address: "88 Orchard Lane, Maple Hollow, WI 54999", notes: "Longtime customer. Quilts for the county fair; likes the 108in backing.", notify: "email" },
      { key: "joan", name: "Joan Kowalski", phone: "(715) 555-0121", email: "joan.kowalski@example.com", notes: "Embroiders monogrammed baby gifts. Prefers a text when a machine is ready.", notify: "email" },
      { key: "beth", name: "Beth Anderson-Cole", phone: "(715) 555-0134", email: "beth.ac@example.com", address: "7 Creamery Road, Maple Hollow, WI 54999", notify: "email" },
      { key: "guild", name: "Maple Hollow Quilt Guild", phone: "(715) 555-0150", email: "guild@example.com", notes: "Guild account: 24 members, meets first Thursday. 10% guild discount on classes.", notify: "email" },
      { key: "ruth", name: "Ruth Ellison", phone: "(715) 555-0127", email: "ruth.ellison@example.com", notify: "email" },
      { key: "nadia", name: "Nadia Rahman", phone: "(715) 555-0166", email: "nadia.rahman@example.com", notes: "New quilter, took Beginner Quilting last spring.", notify: "email" },
      { key: "carol", name: "Carol Dunning", phone: "(715) 555-0172", email: "carol.dunning@example.com", notify: "email" },
      { key: "harold", name: "Harold Peterson", phone: "(715) 555-0108", notes: "Restores vintage Singers. Calls, does not email.", notify: "" },
      { key: "walt", name: "Walt Szymanski", phone: "(715) 555-0119", notes: "Vintage machine collector. Brings his own oil.", notify: "" },
      { key: "patricia", name: "Patricia Ng", phone: "(715) 555-0183", email: "patricia.ng@example.com", notify: "email" },
      { key: "tamika", name: "Tamika Brooks", phone: "(715) 555-0147", email: "tamika.brooks@example.com", notify: "email" },
      { key: "susan", name: "Susan Oyelaran", phone: "(715) 555-0159", email: "susan.oyelaran@example.com", notify: "email" },
      { key: "marybeth", name: "Mary Beth Tolliver", phone: "(715) 555-0138", email: "mb.tolliver@example.com", notify: "email" },
      { key: "kristen", name: "Kristen Hale", phone: "(715) 555-0176", email: "kristen.hale@example.com", notify: "email" },
      { key: "janet", name: "Janet Voss", phone: "(715) 555-0165", email: "janet.voss@example.com", notes: "Rents the longarm most months.", notify: "email" },
    ];
    let guest: GuestFile | null = null;
    const guestFile = path.join(here, "guest.local.json");
    if (fs.existsSync(guestFile)) {
      guest = JSON.parse(fs.readFileSync(guestFile, "utf8")) as GuestFile;
      const gname = `${guest.firstName} ${guest.lastName ?? ""}`.trim();
      custs.push({ key: "guest", name: gname, phone: "(715) 555-0187", email: `${guest.firstName.toLowerCase()}@example.com`, notes: "Quilt-shop hopper. Three machines in for service this week.", notify: "email" });
    }
    const cid: Record<string, string> = {};
    const cname: Record<string, string> = {};
    for (const [i, c] of custs.entries()) {
      const row = await db.customer.create({
        data: { shopId, name: c.name, phone: c.phone, email: c.email, address: c.address, notes: c.notes, notifyBy: c.notify ?? "", createdAt: ago(60 + i * 9) },
        select: { id: true },
      });
      cid[c.key] = row.id;
      cname[c.key] = c.name;
    }

    // ---------- retail inventory ----------
    type Item = { key: string; number: string; desc: string; kind: "FABRIC" | "THREAD" | "NOTION" | "PATTERN" | "SUPPLY" | "ACCESSORY"; priceCents: number; costPct?: number; unit?: "yd"; stock: number; reorderAt?: number; brand?: string; online?: { title: string; text: string; swatch: SwatchKind; colors: string[] }; location?: string };
    const items: Item[] = [
      // Quilting cotton by the yard
      { key: "pumpkin", number: "FAB-1001", desc: "Quilting cotton - Harvest Pumpkin tonal", kind: "FABRIC", unit: "yd", priceCents: 1299, stock: 42.5, reorderAt: 10, location: "Wall A, bolt 1", online: { title: "Harvest Pumpkin tonal quilting cotton, per yard", text: "A warm pumpkin tonal that reads as a solid from across the room. 100% cotton, 44 inches wide. Cut to the yard; order 2 for 2 yards.", swatch: "dots", colors: ["#d9772b", "#c15f1b"] } },
      { key: "leaves", number: "FAB-1002", desc: "Quilting cotton - Autumn Leaves tossed print", kind: "FABRIC", unit: "yd", priceCents: 1349, stock: 36, reorderAt: 10, location: "Wall A, bolt 2" },
      { key: "navy", number: "FAB-1003", desc: "Quilting cotton - Navy blender", kind: "FABRIC", unit: "yd", priceCents: 1199, stock: 51.25, reorderAt: 10, location: "Wall A, bolt 3" },
      { key: "cream", number: "FAB-1004", desc: "Quilting cotton - Cream on cream", kind: "FABRIC", unit: "yd", priceCents: 1199, stock: 8.75, reorderAt: 10, location: "Wall A, bolt 4" },
      { key: "gingham", number: "FAB-1005", desc: "Quilting cotton - Red gingham 1/4 in", kind: "FABRIC", unit: "yd", priceCents: 1399, stock: 29, reorderAt: 8, location: "Wall B, bolt 1", online: { title: "Red gingham quilting cotton, per yard", text: "Classic quarter-inch red and white gingham, woven so it is the same on both sides. 44 inches wide, cut to the yard.", swatch: "gingham", colors: ["#f4efe6", "#b3262f"] } },
      { key: "sage", number: "FAB-1006", desc: "Quilting cotton - Sage green solid", kind: "FABRIC", unit: "yd", priceCents: 1250, stock: 33.5, reorderAt: 8, location: "Wall B, bolt 2" },
      { key: "flannel", number: "FAB-1007", desc: "Flannel - Cozy plaid, rust", kind: "FABRIC", unit: "yd", priceCents: 1450, stock: 24, reorderAt: 8, location: "Wall B, bolt 3" },
      { key: "backing", number: "FAB-1008", desc: "Wide backing 108in - Charcoal", kind: "FABRIC", unit: "yd", priceCents: 2399, stock: 18.5, reorderAt: 6, location: "Back wall" },
      { key: "batik", number: "FAB-1009", desc: "Batik - Ocean waves", kind: "FABRIC", unit: "yd", priceCents: 1599, stock: 27.25, reorderAt: 8, location: "Wall B, bolt 4" },
      // Batting
      { key: "batq", number: "BAT-2001", desc: "Cotton batting, queen 90x108", kind: "SUPPLY", priceCents: 3299, stock: 9, reorderAt: 3, location: "Batting wall", online: { title: "Cotton batting, queen size 90 x 108", text: "Soft needle-punched cotton batting that quilts easily by machine or by hand. Pre-shrunk, so your quilt keeps its flat finish. Queen size, 90 x 108 inches.", swatch: "solid", colors: ["#efe9da"] } },
      { key: "batyd", number: "BAT-2002", desc: "Batting by the yard, 80/20 blend, 96in wide", kind: "SUPPLY", unit: "yd", priceCents: 1099, stock: 34, reorderAt: 8, location: "Batting wall" },
      { key: "batcrib", number: "BAT-2003", desc: "Cotton batting, crib 45x60", kind: "SUPPLY", priceCents: 1499, stock: 12, reorderAt: 4, location: "Batting wall" },
      // Precuts
      { key: "fqb", number: "PRE-3001", desc: "Fat quarter bundle - Autumn Harvest, 20 pieces", kind: "FABRIC", priceCents: 4800, stock: 14, reorderAt: 4, location: "Precut rack", online: { title: "Autumn Harvest fat quarter bundle, 20 pieces", text: "Twenty fat quarters in pumpkin, rust, gold, sage and cream. Each piece is about 18 x 21 inches, enough for a whole table runner. Tied with a ribbon, ready to cut.", swatch: "squares", colors: ["#c15f1b", "#8a9a5b", "#e9b44c", "#f3ead7"] } },
      { key: "charm", number: "PRE-3002", desc: "Charm pack - Blue Hour, 42 squares 5in", kind: "FABRIC", priceCents: 1299, stock: 22, reorderAt: 6, location: "Precut rack", online: { title: "Blue Hour charm pack, 42 five-inch squares", text: "Forty-two 5 inch squares in deep navy, denim and soft sky blues, with a few cream prints to rest the eye. Perfect for a scrappy baby quilt.", swatch: "squares", colors: ["#1f3a68", "#6b93c9", "#d8e4f2", "#12264a"] } },
      { key: "jelly", number: "PRE-3003", desc: "Jelly roll - Cottage Garden, 40 strips 2.5in", kind: "FABRIC", priceCents: 3499, stock: 11, reorderAt: 4, location: "Precut rack", online: { title: "Cottage Garden jelly roll, 40 strips", text: "Forty 2.5 inch strips across the full width of the fabric, in florals and polka dots on cream. Makes a lap quilt in an afternoon.", swatch: "stripes", colors: ["#e7a6b3", "#f6efe3"] } },
      { key: "layer", number: "PRE-3004", desc: "Layer cake - Farmhouse, 42 squares 10in", kind: "FABRIC", priceCents: 4299, stock: 7, reorderAt: 3, location: "Precut rack" },
      { key: "fqone", number: "PRE-3005", desc: "Fat quarter - single, assorted", kind: "FABRIC", priceCents: 325, stock: 120, reorderAt: 30, location: "Fat quarter bins" },
      // Thread
      { key: "th_white", number: "THR-4001", desc: "50wt cotton thread, 1422 yd - Natural white", kind: "THREAD", priceCents: 1199, stock: 26, reorderAt: 8, location: "Thread wall", online: { title: "50wt cotton thread, 1422 yd, Natural white", text: "Smooth long-staple cotton thread for piecing and quilting. 50 weight, 2-ply, 1422 yards on a large spool.", swatch: "gradient", colors: ["#f4efe3", "#c9b78f"] } },
      { key: "th_gray", number: "THR-4002", desc: "50wt cotton thread, 1422 yd - Light gray", kind: "THREAD", priceCents: 1199, stock: 19, reorderAt: 8, location: "Thread wall" },
      { key: "th_cin", number: "THR-4003", desc: "50wt cotton thread, 1422 yd - Cinnamon", kind: "THREAD", priceCents: 1199, stock: 7, reorderAt: 8, location: "Thread wall" },
      { key: "th_black", number: "THR-4004", desc: "40wt polyester embroidery thread, 1000 m - Black", kind: "THREAD", priceCents: 850, stock: 21, reorderAt: 6, location: "Embroidery thread" },
      { key: "th_bob", number: "THR-4005", desc: "60wt bobbin thread, 1000 m - White", kind: "THREAD", priceCents: 750, stock: 30, reorderAt: 10, location: "Embroidery thread" },
      { key: "th_wool", number: "THR-4006", desc: "12wt hand-quilting thread, 109 yd - Assorted", kind: "THREAD", priceCents: 899, stock: 16, reorderAt: 6, location: "Thread wall" },
      // Notions and rulers
      { key: "cutter", number: "NOT-5001", desc: "Rotary cutter 45mm", kind: "NOTION", priceCents: 2299, stock: 10, reorderAt: 3, location: "Notions wall", online: { title: "Rotary cutter, 45 mm", text: "Comfortable ergonomic handle with a safety lock. Takes standard 45 mm blades.", swatch: "plaid", colors: ["#2e7d6b", "#f1c453", "#e9efe9"] } },
      { key: "blades", number: "NOT-5002", desc: "Rotary blades 45mm, 5 pack", kind: "NOTION", priceCents: 1199, stock: 18, reorderAt: 5, location: "Notions wall" },
      { key: "mat", number: "NOT-5003", desc: "Self-healing cutting mat 18x24", kind: "NOTION", priceCents: 3999, stock: 6, reorderAt: 2, location: "Notions wall", online: { title: "Self-healing cutting mat, 18 x 24", text: "Double-sided green mat with a one-inch grid and 45 and 60 degree lines. Lies flat, protects your table.", swatch: "gingham", colors: ["#2f8f5b", "#a7d6b9"] } },
      { key: "clips", number: "NOT-5004", desc: "Quilting clips, 50 count", kind: "NOTION", priceCents: 1099, stock: 24, reorderAt: 6, location: "Notions wall" },
      { key: "ripper", number: "NOT-5005", desc: "Seam ripper, ergonomic", kind: "NOTION", priceCents: 699, stock: 31, reorderAt: 8, location: "Notions wall" },
      { key: "microtex", number: "NOT-5006", desc: "Microtex sharp needles size 80/12, 5 pack", kind: "NOTION", priceCents: 599, stock: 27, reorderAt: 8, location: "Needle case" },
      { key: "pencils", number: "NOT-5007", desc: "Water-erasable marking pencils, 3 pack", kind: "NOTION", priceCents: 899, stock: 17, reorderAt: 5, location: "Notions wall" },
      { key: "needles", number: "NOT-5008", desc: "Universal machine needles 90/14, 5 pack", kind: "NOTION", priceCents: 549, stock: 38, reorderAt: 10, location: "Needle case" },
      { key: "pins", number: "NOT-5010", desc: "Glass head pins, 100 count", kind: "NOTION", priceCents: 649, stock: 22, reorderAt: 6, location: "Notions wall" },
      { key: "ruler1", number: "RUL-6001", desc: "Quilting ruler 6.5 x 24 in", kind: "NOTION", priceCents: 2999, stock: 8, reorderAt: 3, location: "Ruler wall" },
      { key: "ruler2", number: "RUL-6002", desc: "Square-up ruler 9.5 in", kind: "NOTION", priceCents: 2699, stock: 7, reorderAt: 3, location: "Ruler wall" },
      { key: "ruler3", number: "RUL-6003", desc: "Half-square triangle ruler 6.5 in", kind: "NOTION", priceCents: 2399, stock: 5, reorderAt: 2, location: "Ruler wall" },
      // Patterns
      { key: "pat_runner", number: "PAT-7001", desc: "Pattern - Harvest Table Runner", kind: "PATTERN", priceCents: 1100, stock: 15, reorderAt: 4, location: "Pattern rack" },
      { key: "pat_cabin", number: "PAT-7002", desc: "Pattern - Log Cabin Baby Quilt", kind: "PATTERN", priceCents: 1200, stock: 12, reorderAt: 4, location: "Pattern rack" },
      { key: "pat_book", number: "PAT-7003", desc: "Pattern book - Scrappy Stars, 12 quilts", kind: "PATTERN", priceCents: 2195, stock: 9, reorderAt: 3, location: "Pattern rack", online: { title: "Scrappy Stars pattern book, 12 quilts", text: "Twelve star quilts from table topper to king, all made from scraps and precuts. Full-color diagrams and cutting charts.", swatch: "squares", colors: ["#b3262f", "#1f3a68", "#f3ead7", "#e9b44c"] } },
      { key: "pat_tote", number: "PAT-7004", desc: "Pattern - Zip Tote Bag", kind: "PATTERN", priceCents: 1000, stock: 14, reorderAt: 4, location: "Pattern rack" },
      // Machines for sale
      { key: "m_janome", number: "MAC-8001", desc: "Janome 3160QDC computerized sewing machine, new", kind: "ACCESSORY", priceCents: 69900, costPct: 0.68, stock: 3, reorderAt: 1, brand: "Janome", location: "Machine shelf" },
      { key: "m_brother", number: "MAC-8002", desc: "Brother SE700 sewing and embroidery machine, new", kind: "ACCESSORY", priceCents: 49900, costPct: 0.7, stock: 2, reorderAt: 1, brand: "Brother", location: "Machine shelf" },
    ];
    const partId: Record<string, string> = {};
    const itemByKey: Record<string, Item> = {};
    const sold: Record<string, number> = {};
    for (const it of items) {
      const row = await db.part.create({
        data: {
          shopId,
          partNumber: it.number,
          description: it.desc,
          brand: it.brand ?? null,
          kind: it.kind,
          unit: it.unit ?? null,
          qtyOnHand: it.stock,
          reorderAt: it.reorderAt ?? 0,
          costCents: Math.round(it.priceCents * (it.costPct ?? 0.52)),
          priceCents: it.priceCents,
          location: it.location ?? null,
          numberKeys: [it.number.replace(/[^A-Z0-9]/g, "")],
          ownNumber: true,
          online: Boolean(it.online),
          onlineTitle: it.online?.title ?? null,
          onlineText: it.online?.text ?? null,
        },
        select: { id: true },
      });
      partId[it.key] = row.id;
      itemByKey[it.key] = it;
      sold[it.key] = 0;
      if (it.online) {
        await db.partPhoto.create({ data: { shopId, partId: row.id, mime: "image/png", data: swatchPng(it.online.swatch, it.online.colors), sortOrder: 0 } });
      }
    }

    // ---------- machines on file ----------
    type M = { key: string; cust: string; brand: string; model: string; serial?: string; type: string; notes?: string };
    const machines: M[] = [
      { key: "linda_mc", cust: "linda", brand: "Janome", model: "MC6700P", serial: "ZK4A02311", type: "Premium computerized", notes: "Sewing room, upstairs. Used daily." },
      { key: "joan_pe", cust: "joan", brand: "Brother", model: "PE770", serial: "U6B318850", type: "Embroidery only" },
      { key: "ruth_b", cust: "ruth", brand: "Bernina", model: "770 QE", serial: "00112345", type: "Premium computerized" },
      { key: "harold_s", cust: "harold", brand: "Singer", model: "15-91", serial: "AL201934", type: "Vintage", notes: "Restored, black gloss finish. Original motor." },
      { key: "walt_s", cust: "walt", brand: "Singer", model: "201-2", serial: "EF550212", type: "Vintage", notes: "Potted motor, 1948." },
      { key: "beth_j", cust: "beth", brand: "Janome", model: "Memory Craft 9400QCP", serial: "M2A140022", type: "Sew + embroidery" },
      { key: "nadia_bl", cust: "nadia", brand: "Baby Lock", model: "Soprano", serial: "BLSP-33801", type: "Computerized" },
      { key: "susan_juki", cust: "susan", brand: "Juki", model: "TL-2010Q", serial: "9TL304417", type: "Sit-down quilter" },
      { key: "carol_fw", cust: "carol", brand: "Singer", model: "Featherweight 221", serial: "AG887421", type: "Featherweight", notes: "Travels to retreat in the original case." },
      { key: "janet_bro", cust: "janet", brand: "Brother", model: "SE600", serial: "U5C114903", type: "Sew + embroidery" },
    ];
    // The guest's machines (from the local file, if there is one).
    const guestTicketSpecs: TicketSpec[] = [];
    const itemsExtra: { key: string; number: string; desc: string; priceCents: number; stock: number }[] = [];
    function stageOf(s: string): { status: "READY_FOR_PICKUP" | "WAITING_PARTS" | "ON_BENCH" | "WAITING_CUSTOMER_OK"; ago: number } {
      if (/ready|pick/i.test(s)) return { status: "READY_FOR_PICKUP", ago: 7 };
      if (/part/i.test(s)) return { status: "WAITING_PARTS", ago: 5 };
      if (/ok|approv|estimate/i.test(s)) return { status: "WAITING_CUSTOMER_OK", ago: 3 };
      return { status: "ON_BENCH", ago: 2 };
    }
    type Line = { kind: "SERVICE" | "LABOR" | "PART" | "FEE" | "DISCOUNT"; d: string; qty?: number; cents: number; taxable?: boolean; partKey?: string };
    type TicketSpec = {
      cust: string;
      machine: string;
      status: "ON_BENCH" | "WAITING_CUSTOMER_OK" | "WAITING_PARTS" | "READY_FOR_PICKUP" | "COLLECTED";
      intakeAgo: number;
      readyAgo?: number;
      closedAgo?: number;
      service: string;
      problem: string;
      diagnosis?: string;
      workDone?: string;
      lines: Line[];
      paid?: "full" | number;
      accessories: string[];
      checklist: number; // how many checklist items are done
      readings?: { upperFoundG: number; upperLeftG: number; bobbinFoundG: number; bobbinLeftG: number };
      notes?: string;
      wait?: { description: string; partKey: string; supplier: string; orderedAgo: number; etaDays: number };
      preApproved?: number;
      approved?: number;
    };
    if (guest) {
      for (const [i, gm] of guest.machines.entries()) {
        const key = `guest_${i}`;
        const st = stageOf(gm.stage);
        const embroidery = /embroid/i.test(gm.kind ?? "");
        const serger = /serger|overlock|coverstitch/i.test(`${gm.kind ?? ""} ${gm.model}`);
        const combo = embroidery && /sew|unit|designer|deluxe/i.test(`${gm.model} ${gm.job}`);
        const type = serger ? "Serger / cover" : combo ? "Sew + embroidery" : /featherweight|singer 2\d\d|15-91|vintage/i.test(`${gm.make} ${gm.model} ${gm.job}`) ? (/featherweight/i.test(gm.model) ? "Featherweight" : "Vintage") : embroidery ? "Embroidery only" : /bernina|pfaff|husqvarna|\bviking\b/i.test(gm.make) ? "Premium computerized" : "Computerized";
        machines.push({ key, cust: "guest", brand: gm.make, model: gm.model, serial: `DEMO-${String(7100 + i * 37)}`, type });
        const base = /featherweight/i.test(gm.model) ? 11900 : serger ? 15900 : combo ? 19900 : embroidery ? 17900 : type === "Premium computerized" ? 24900 : 15900;
        const svcName = /featherweight/i.test(gm.model) ? "Clean, oil, time & adjust - Featherweight 221/222" : serger ? "Clean, oil, time & adjust - serger / coverstitch" : combo ? "Clean, oil, time & adjust - sew & embroidery combo" : embroidery ? "Clean, oil, time & adjust - embroidery only" : type === "Premium computerized" ? "Clean, oil, time & adjust - premium computerized" : type === "Vintage" ? "Clean, oil, time & adjust - other vintage" : "Clean, oil, time & adjust - computerized";
        const lines: Line[] = [{ kind: "SERVICE", d: svcName, cents: base, taxable: false }];
        let wait: TicketSpec["wait"];
        if (st.status === "WAITING_PARTS") {
          const m = /(?:needs? |\bnew )(?:an? |the )?(?:new )?([^.;,]+)/i.exec(gm.job);
          const pdesc = gm.part ?? (m ? m[1].replace(/^(.)/, (c) => c.toUpperCase()) : "Replacement part");
          const pc = gm.partPriceCents ?? 4200;
          const pkey = `rp_${key}`;
          itemsExtra.push({ key: pkey, number: `RP-${modelKey(gm.model).slice(0, 8)}-${i + 1}`, desc: `${pdesc}, ${gm.make} ${gm.model}`, priceCents: pc, stock: 0 });
          lines.push({ kind: "PART", d: `${pdesc}, ${gm.make} ${gm.model}`, cents: pc, taxable: true, partKey: pkey });
          lines.push({ kind: "LABOR", d: "Fit and test the new part", qty: 0.5, cents: 9800, taxable: false });
          wait = { description: `${pdesc} (${gm.make} ${gm.model})`, partKey: pkey, supplier: `${gm.make} parts desk`, orderedAgo: Math.max(1, st.ago - 2), etaDays: 4 };
        } else if (st.status === "WAITING_CUSTOMER_OK") {
          // An estimate waiting for the customer: a part to fit if she approves.
          const m = /(?:needs? |\bnew )(?:an? |the )?(?:new )?([^.;,]+)/i.exec(gm.job);
          const pdesc = gm.part ?? (m ? m[1].replace(/^(.)/, (c) => c.toUpperCase()) : "Replacement part");
          lines.push({ kind: "PART", d: `${pdesc}, ${gm.make} ${gm.model}`, cents: gm.partPriceCents ?? 3200, taxable: true });
          lines.push({ kind: "LABOR", d: "Fit and test the new part", qty: 0.5, cents: 9800, taxable: false });
        } else if (/belt/i.test(gm.job)) {
          const pkey = `rp_${key}`;
          itemsExtra.push({ key: pkey, number: `RP-${modelKey(gm.model).slice(0, 8)}-${i + 1}`, desc: `Motor belt, ${gm.make} ${gm.model}`, priceCents: 1450, stock: 5 });
          lines.push({ kind: "PART", d: `Motor belt, ${gm.make} ${gm.model}`, cents: 1450, taxable: true, partKey: pkey });
        } else if (st.status === "READY_FOR_PICKUP") {
          lines.push({ kind: "PART", d: "Needles and bobbin case lubricant", cents: 850, taxable: true });
          lines.push({ kind: "LABOR", d: "Extra bench time, feed dog adjustment", qty: 0.5, cents: 9800, taxable: false });
        }
        guestTicketSpecs.push({
          cust: "guest",
          machine: key,
          status: st.status,
          intakeAgo: st.ago,
          readyAgo: st.status === "READY_FOR_PICKUP" ? 1 : undefined,
          service: svcName,
          problem: gm.job,
          diagnosis: st.status === "WAITING_PARTS" ? "Confirmed the fault on the bench; the part has to be replaced." : st.status === "READY_FOR_PICKUP" ? "No faults found. Tension and timing within spec." : st.status === "WAITING_CUSTOMER_OK" ? "Cleaned and checked; the part is worn and should be replaced. Estimate sent for her OK." : "Cleaned out; checking timing and belt.",
          workDone: st.status === "READY_FOR_PICKUP" ? "Cleaned and oiled to the manual, timing and tension set, test stitch-out done." : undefined,
          lines,
          accessories: embroidery ? ["Power cord", "Foot control", "Hoop", "Embroidery unit"] : ["Power cord", "Foot control", "Case / bag"],
          checklist: st.status === "READY_FOR_PICKUP" ? 11 : st.status === "ON_BENCH" ? 6 : 4,
          readings: st.status === "READY_FOR_PICKUP" ? { upperFoundG: 88, upperLeftG: 102, bobbinFoundG: 19, bobbinLeftG: 23 } : undefined,
          notes: `Customer is a regular at our classes. ${st.status === "WAITING_PARTS" ? "Told her it will be about a week for the part." : st.status === "READY_FOR_PICKUP" ? "Called her; she will pick up on her next visit." : "Has a retreat coming up, hoping for this week."}`,
          wait,
        });
      }
    }
    const mid: Record<string, string> = {};
    for (const m of machines) {
      const row = await db.machine.create({
        data: { shopId, brand: m.brand, model: m.model, modelKey: modelKey(m.model), serial: m.serial, machineType: m.type, customerId: cid[m.cust], notes: m.notes ?? null, kind: "sewing", equipment: "SEWING", createdAt: ago(40) },
        select: { id: true },
      });
      mid[m.key] = row.id;
    }

    // Parts made for the guest's tickets (above), and a few repair parts for the other tickets.
    const repairParts: { key: string; number: string; desc: string; fits?: string; priceCents: number; stock: number }[] = [
      { key: "rp_bobcase", number: "RP-JAN-BC", desc: "Bobbin case, Janome MC6700P", fits: "Janome MC6700P", priceCents: 2650, stock: 3 },
      { key: "rp_hoop", number: "RP-BRO-EH", desc: "Embroidery hoop arm screw set, Brother PE770", fits: "Brother PE770", priceCents: 1300, stock: 4 },
      { key: "rp_belt", number: "RP-SNG-BLT", desc: "Motor belt, Singer 15-91", fits: "Singer 15-91", priceCents: 1650, stock: 5 },
      { key: "rp_brush", number: "RP-SNG-MB", desc: "Motor brush set, Singer 201-2", fits: "Singer 201-2", priceCents: 2400, stock: 2 },
      { key: "rp_foot", number: "RP-BER-FP", desc: "Foot pressure spring, Bernina 7 series", fits: "Bernina 770 QE", priceCents: 3800, stock: 1 },
    ];
    for (const rp of [...repairParts, ...itemsExtra]) {
      const row = await db.part.create({
        data: { shopId, partNumber: rp.number, description: rp.desc, fits: (rp as { fits?: string }).fits ?? null, kind: "PART", qtyOnHand: rp.stock, reorderAt: 1, costCents: Math.round(rp.priceCents * 0.65), priceCents: rp.priceCents, numberKeys: [rp.number.replace(/[^A-Z0-9]/g, "")], ownNumber: true, location: "Bench drawers" },
        select: { id: true },
      });
      partId[rp.key] = row.id;
    }

    // ---------- classes (past, this month's, and the next two weeks) ----------
    type ClassSpec = {
      key: string;
      title: string;
      description: string;
      teacher: string;
      supplies: string;
      feeCents: number;
      seats: number;
      meetings: { day: number; from: string; to: string }[];
      status?: string;
      roster: { cust: string; status?: "ENROLLED" | "WAITLIST" | "CANCELLED"; paid?: boolean; signedAgo: number }[];
    };
    const classes: ClassSpec[] = [
      {
        key: "mq101",
        title: "Machine Quilting 101",
        description: "Straight-line and walking-foot quilting on your own home machine. Two evenings, one finished table runner.",
        teacher: "Marlene Hartwell",
        supplies: "Your sewing machine with a walking foot, a basted table-runner top (kit available), 50wt thread, bobbins.",
        feeCents: 6500,
        seats: 8,
        status: "CLOSED",
        meetings: [{ day: -22, from: "18:00", to: "20:30" }, { day: -15, from: "18:00", to: "20:30" }],
        roster: [{ cust: "linda", signedAgo: 34, paid: true }, { cust: "nadia", signedAgo: 33, paid: true }, { cust: "carol", signedAgo: 30, paid: true }, { cust: "patricia", signedAgo: 29, paid: true }, { cust: "marybeth", signedAgo: 28, paid: true }],
      },
      {
        key: "paperpiece",
        title: "Paper Piecing Workshop",
        description: "Foundation paper piecing for sharp points: a 12-inch star block, start to finish, one Saturday morning.",
        teacher: "Priya Nair",
        supplies: "Sewing machine, small-stitch needle 90/14, paper-piecing pattern (provided), scraps of two or three colors.",
        feeCents: 4500,
        seats: 6,
        status: "CLOSED",
        meetings: [{ day: -9, from: "10:00", to: "13:00" }],
        roster: [{ cust: "beth", signedAgo: 20, paid: true }, { cust: "tamika", signedAgo: 18, paid: true }, { cust: "kristen", signedAgo: 15, paid: true }, { cust: "susan", signedAgo: 14, paid: true }],
      },
      {
        key: "beginner",
        title: "Beginner Quilting, 4 weeks",
        description: "From rotary cutter to finished lap quilt in four weekly evenings. We cover cutting, piecing, pressing, sandwiching and binding. Fee includes the pattern and a fabric kit ($145 class + $38 kit).",
        teacher: "Marlene Hartwell",
        supplies: "Sewing machine in good order, 1/4-inch foot, 45mm rotary cutter and 18x24 mat, 6.5 x 24 ruler, pins or clips, neutral thread. Fabric kit supplied.",
        feeCents: 18300,
        seats: 8,
        meetings: [4, 11, 18, 25].map((d) => ({ day: d, from: "18:00", to: "20:30" })),
        roster: [
          { cust: "nadia", signedAgo: 6, paid: true }, { cust: "tamika", signedAgo: 5, paid: true }, { cust: "kristen", signedAgo: 5, paid: true }, { cust: "marybeth", signedAgo: 4, paid: true },
          { cust: "susan", signedAgo: 3, paid: true }, { cust: "patricia", signedAgo: 2 }, { cust: "carol", signedAgo: 1 }, { cust: "joan", status: "WAITLIST", signedAgo: 0 },
        ].concat(guest ? [{ cust: "guest", signedAgo: 1 }] : []) as ClassSpec["roster"],
      },
      {
        key: "fmq",
        title: "Free-Motion Quilting",
        description: "Loosen up and draw with your needle. Stippling, pebbles, loops and feathers on a practice sandwich, using a darning foot on your own machine.",
        teacher: "Marlene Hartwell",
        supplies: "Machine with feed dogs that drop or a free-motion foot, darning foot, 4 practice sandwiches (we provide), gloves if you have them.",
        feeCents: 6500,
        seats: 6,
        meetings: [{ day: 7, from: "10:00", to: "13:00" }],
        roster: [{ cust: "linda", signedAgo: 9, paid: true }, { cust: "beth", signedAgo: 7, paid: true }, { cust: "janet", signedAgo: 6, paid: true }, { cust: "ruth", signedAgo: 2 }, { cust: "carol", status: "CANCELLED", signedAgo: 8 }],
      },
      {
        key: "embroidery",
        title: "Embroidery Machine Basics",
        description: "Hooping, stabilizer, thread and design placement on your embroidery machine, then a monogrammed towel. Two afternoons. Fee includes stabilizer and a blank (kit $10 + class $75).",
        teacher: "Gus Okafor",
        supplies: "Your embroidery machine with its hoop and embroidery foot, 40wt embroidery thread (shop has a selection), small scissors.",
        feeCents: 8500,
        seats: 6,
        meetings: [{ day: 5, from: "13:00", to: "15:30" }, { day: 12, from: "13:00", to: "15:30" }],
        roster: [
          { cust: "joan", signedAgo: 8, paid: true }, { cust: "beth", signedAgo: 7, paid: true }, { cust: "janet", signedAgo: 6, paid: true }, { cust: "susan", signedAgo: 6, paid: true },
          { cust: "tamika", signedAgo: 4, paid: true }, { cust: "kristen", signedAgo: 3, paid: true }, { cust: "marybeth", status: "WAITLIST", signedAgo: 1 },
        ],
      },
      {
        key: "botm",
        title: "Block of the Month",
        description: "A new sampler block each month, with fabric kit and a take-home pattern, plus an hour of sew-together. Monthly kit fee billed at sign-up.",
        teacher: "Priya Nair",
        supplies: "Your machine, a 1/4-inch foot, basic piecing supplies. The monthly kit is included.",
        feeCents: 2400,
        seats: 15,
        meetings: [{ day: 11, from: "18:00", to: "20:00" }, { day: 39, from: "18:00", to: "20:00" }, { day: 67, from: "18:00", to: "20:00" }],
        roster: ["linda", "joan", "beth", "ruth", "nadia", "carol", "patricia", "tamika", "susan", "janet", "kristen"].map((c, i) => ({ cust: c, signedAgo: 2 + (i % 9), paid: i < 8 })),
      },
    ];
    const classId: Record<string, string> = {};
    type EnrollSale = { enrollmentId: string; cust: string; title: string; feeCents: number; signedAgo: number };
    const enrollSales: EnrollSale[] = [];
    for (const c of classes) {
      const ms = c.meetings.map((m) => ({ startsAt: at(m.day, m.from), endsAt: at(m.day, m.to) }));
      const row = await db.shopClass.create({
        data: {
          shopId,
          title: c.title,
          description: c.description,
          teacher: c.teacher,
          location: "Classroom, back of the shop",
          supplies: c.supplies,
          feeCents: c.feeCents,
          taxable: false,
          seats: c.seats,
          waitlist: true,
          remind: "every",
          status: c.status ?? "OPEN",
          online: !c.status,
          firstAt: ms[0].startsAt,
          lastAt: ms[ms.length - 1].startsAt,
          createdById: marlene.id,
          createdAt: ago(45),
          meetings: { create: ms.map((m) => ({ shopId, startsAt: m.startsAt, endsAt: m.endsAt })) },
        },
        select: { id: true },
      });
      classId[c.key] = row.id;
      for (const r of c.roster) {
        const enr = await db.enrollment.create({
          data: {
            shopId,
            classId: row.id,
            customerId: cid[r.cust],
            name: cname[r.cust],
            status: r.status ?? "ENROLLED",
            feeCents: c.feeCents,
            taxable: false,
            source: r.signedAgo % 3 === 0 ? "online" : "counter",
            cancelledAt: r.status === "CANCELLED" ? ago(r.signedAgo - 1) : null,
            createdAt: ago(r.signedAgo, "14:15"),
            createdById: priya.id,
          },
          select: { id: true },
        });
        if (r.paid && !r.status) enrollSales.push({ enrollmentId: enr.id, cust: r.cust, title: c.title, feeCents: c.feeCents, signedAgo: r.signedAgo });
      }
    }

    // ---------- register sales: three weeks, with the class fees among them ----------
    type SaleSpec = { when: Date; cust: string | null; lines: { key?: string; desc?: string; qty: number; cents: number; enrollmentId?: string; taxable: boolean }[]; method: "CARD" | "CASH" | "CHECK"; user: string; note?: string };
    const sales: SaleSpec[] = [];
    const yardQty = [0.5, 0.75, 1, 1, 1.25, 1.5, 2, 2, 2.5, 3, 3.5, 4];
    const fabrics = ["pumpkin", "leaves", "navy", "cream", "gingham", "sage", "flannel", "batik"];
    const threads = ["th_white", "th_gray", "th_cin", "th_black", "th_bob", "th_wool"];
    const notions = ["blades", "clips", "ripper", "microtex", "pencils", "needles", "pins", "cutter", "mat"];
    const rulers = ["ruler1", "ruler2", "ruler3"];
    const pats = ["pat_runner", "pat_cabin", "pat_book", "pat_tote"];
    const precuts = ["fqb", "charm", "jelly", "layer"];
    const itemLine = (key: string, qty: number) => ({ key, qty, cents: itemByKey[key].priceCents, taxable: true });
    const staffIds = [marlene.id, priya.id, priya.id, marlene.id];
    const regulars = [null, null, null, "linda", "joan", "beth", "ruth", "nadia", "carol", "patricia", "tamika", "susan", "marybeth", "kristen", "janet", "guild"];
    for (let d = -21; d <= 0; d++) {
      if (dow(d) === 0 || dow(d) === 1) continue; // closed Sunday and Monday
      if (d === 0 && now < at(0, "10:15")) continue; // not open yet today
      const n = dow(d) === 6 ? between(5, 7) : between(2, 4);
      for (let i = 0; i < n; i++) {
        let when = at(d, `${String(between(10, 16)).padStart(2, "0")}:${String(between(0, 59)).padStart(2, "0")}`);
        if (d === 0 && when > now) when = new Date(Math.max(dayStartIn(dayYmd(0), TZ).getTime() + 5 * 60 * MIN, now.getTime() - between(15, 150) * MIN));
        if (when > now) continue;
        const kind = pick(["yardage", "yardage", "precut", "notions", "pattern", "batting", "thread"]);
        const lines: SaleSpec["lines"] = [];
        if (kind === "yardage") {
          for (let k = 0; k < between(1, 3); k++) lines.push(itemLine(pick(fabrics.filter((f) => !lines.some((l) => l.key === f))), pick(yardQty)));
          if (rnd() < 0.5) lines.push(itemLine(pick(threads), 1));
        } else if (kind === "precut") {
          lines.push(itemLine(pick(precuts), 1));
          lines.push(itemLine(pick(threads), 1));
          if (rnd() < 0.4) lines.push(itemLine(pick(pats), 1));
        } else if (kind === "notions") {
          for (const k of new Set([pick(notions), pick(notions), pick(rulers)])) lines.push(itemLine(k, 1));
        } else if (kind === "pattern") {
          lines.push(itemLine(pick(pats), 1));
          lines.push(itemLine(pick(fabrics), pick([1.5, 2, 3])));
        } else if (kind === "batting") {
          lines.push(itemLine(pick(["batq", "batyd", "batcrib"]), 1));
          lines.push(itemLine("backing", pick([2.5, 3, 4, 5])));
        } else {
          lines.push(itemLine(pick(threads), between(2, 4)));
          lines.push(itemLine(pick(["microtex", "needles"]), 1));
        }
        const cust = pick(regulars);
        sales.push({ when, cust, lines, method: rnd() < 0.7 ? "CARD" : "CASH", user: pick(staffIds) });
      }
    }
    // A machine sold, with a customer, eight days ago.
    sales.push({ when: ago(8, "14:40"), cust: "nadia", lines: [itemLine("m_janome", 1), itemLine("needles", 1), itemLine("th_white", 2)], method: "CARD", user: marlene.id, note: "Janome 3160QDC. Walked her through the threading." });
    sales.push({ when: ago(2, "11:20"), cust: "guild", lines: [itemLine("fqb", 3), itemLine("batq", 2)], method: "CHECK", user: priya.id, note: "Guild raffle quilt supplies, check #2203." });
    // Class fees (paid at the register when they signed up).
    for (const e of enrollSales) {
      sales.push({ when: ago(e.signedAgo, "14:30"), cust: e.cust, lines: [{ desc: `Class: ${e.title}`, qty: 1, cents: e.feeCents, enrollmentId: e.enrollmentId, taxable: false }], method: "CARD", user: priya.id });
    }
    sales.sort((a, b) => a.when.getTime() - b.when.getTime());
    let saleNo = 1000;
    let salesTotalCents = 0;
    for (const s of sales) {
      const lineRows = s.lines.map((l) => {
        const it = l.key ? itemByKey[l.key] : null;
        return {
          partId: l.key ? partId[l.key] : null,
          description: l.desc ?? it!.desc,
          partNumber: it?.number ?? null,
          qty: l.qty,
          unit: it?.unit ?? null,
          unitPriceCents: l.cents,
          taxable: l.taxable,
          costCents: it ? Math.round(it.priceCents * (it.costPct ?? 0.52)) : null,
          enrollmentId: l.enrollmentId ?? null,
          _key: l.key,
        };
      });
      const net = lineRows.map((l) => roundCents(l.qty * l.unitPriceCents));
      const subtotal = net.reduce((a, b) => a + b, 0);
      const taxable = lineRows.reduce((a, l, i) => a + (l.taxable ? net[i] : 0), 0);
      const tax = roundCents((taxable * Math.round(TAX * 10_000)) / 1_000_000);
      const total = subtotal + tax;
      const tendered = s.method === "CASH" ? Math.ceil(total / 500) * 500 : total;
      saleNo++;
      const sale = await db.sale.create({
        data: {
          shopId,
          number: saleNo,
          customerId: s.cust ? cid[s.cust] : null,
          userId: s.user,
          subtotalCents: subtotal,
          taxCents: tax,
          totalCents: total,
          taxRatePct: TAX,
          tenders: [{ method: s.method, amountCents: tendered, note: null }],
          changeCents: tendered - total,
          note: s.note ?? null,
          createdAt: s.when,
        },
        select: { id: true },
      });
      salesTotalCents += total;
      for (const l of lineRows) {
        const { _key, ...row } = l;
        const line = await db.saleLine.create({ data: { saleId: sale.id, ...row } });
        if (row.partId && _key) {
          sold[_key] += row.qty;
          await db.stockMove.create({ data: { shopId, partId: row.partId, qty: -row.qty, reason: "SOLD", userId: s.user, note: `Sale #${saleNo}`, createdAt: s.when } });
        }
        if (row.enrollmentId) {
          await db.enrollment.update({ where: { id: row.enrollmentId }, data: { paidCents: row.unitPriceCents, paidAt: s.when, paidLineId: line.id } });
        }
      }
    }
    // Stock on hand: what the shelves held at the start of the month, less what sold (with the delivery as a "received" move).
    for (const it of items) {
      const left = Math.max(0, Math.round((it.stock - sold[it.key]) * 100) / 100);
      await db.part.update({ where: { id: partId[it.key] }, data: { qtyOnHand: left } });
      await db.stockMove.create({ data: { shopId, partId: partId[it.key], qty: it.stock, reason: "RECEIVED", userId: marlene.id, note: "Opening count and last delivery", createdAt: ago(24) } });
    }
    await db.shop.update({ where: { id: shopId }, data: { nextSaleNumber: saleNo + 1 } });

    // ---------- repair tickets ----------
    const checklist = DEFAULT_CHECKLIST;
    const tickets: TicketSpec[] = [
      {
        cust: "linda", machine: "linda_mc", status: "COLLECTED", intakeAgo: 16, readyAgo: 11, closedAgo: 9, service: "Clean, oil, time and adjust - premium computerized",
        problem: "Skipping stitches on the walking foot; thread bunching under the plate.",
        diagnosis: "Lint packed in the hook race, bobbin case worn. Timing off by half a tooth.", workDone: "Cleaned and oiled, retimed hook, new bobbin case, tension set to spec.",
        lines: [{ kind: "SERVICE", d: "Clean, oil, time and adjust - premium computerized", cents: 24900, taxable: false }, { kind: "PART", d: "Bobbin case, Janome MC6700P", cents: 2650, taxable: true, partKey: "rp_bobcase" }],
        paid: "full", accessories: ["Power cord", "Foot control", "Presser feet", "Extension table"], checklist: 11, readings: { upperFoundG: 142, upperLeftG: 105, bobbinFoundG: 31, bobbinLeftG: 24 }, notes: "Needs service twice a year, she quilts for the fair.",
      },
      {
        cust: "joan", machine: "joan_pe", status: "COLLECTED", intakeAgo: 12, readyAgo: 7, closedAgo: 5, service: "Clean, oil, time and adjust - embroidery only",
        problem: "Needle thread breaking mid-design; hoop arm squeaks.",
        diagnosis: "Dry carriage rails, burr on the thread guide.", workDone: "Cleaned, oiled rails, polished guide, tension set. Test design stitched out cleanly.",
        lines: [{ kind: "SERVICE", d: "Clean, oil, time and adjust - embroidery only", cents: 17900, taxable: false }, { kind: "PART", d: "Embroidery hoop arm screw set, Brother PE770", cents: 1300, taxable: true, partKey: "rp_hoop" }],
        paid: "full", accessories: ["Power cord", "Foot control", "Hoop", "Embroidery unit"], checklist: 11, readings: { upperFoundG: 78, upperLeftG: 90, bobbinFoundG: 20, bobbinLeftG: 22 },
      },
      {
        cust: "ruth", machine: "ruth_b", status: "ON_BENCH", intakeAgo: 3, service: "Clean, oil, time and adjust - premium computerized",
        problem: "Stitch quality dropped after moving; bobbin area makes a clicking sound.",
        diagnosis: "Checking foot pressure and hook timing.", lines: [{ kind: "SERVICE", d: "Clean, oil, time and adjust - premium computerized", cents: 24900, taxable: false }],
        accessories: ["Power cord", "Foot control", "Presser feet", "Dust cover"], checklist: 5, notes: "Bernina 770 QE. Needs the tension disc looked at.",
      },
      {
        cust: "harold", machine: "harold_s", status: "WAITING_CUSTOMER_OK", intakeAgo: 4, service: "Clean, oil, time and adjust - other vintage",
        problem: "Motor runs hot and the belt slips.", diagnosis: "Belt is cracked and the motor needs new bushings. Found extra wear on the hand wheel clutch.",
        lines: [{ kind: "SERVICE", d: "Clean, oil, time and adjust - other vintage", cents: 13900, taxable: false }, { kind: "PART", d: "Motor belt, Singer 15-91", cents: 1650, taxable: true, partKey: "rp_belt" }, { kind: "LABOR", d: "Motor bushings and clutch repair", qty: 1.5, cents: 9800, taxable: false }],
        accessories: ["Power cord", "Foot control", "Manual"], checklist: 6, preApproved: 5000, approved: 0, notes: "Called Harold, left a message with the estimate. He likes to talk it over by phone.",
      },
      {
        cust: "walt", machine: "walt_s", status: "READY_FOR_PICKUP", intakeAgo: 10, readyAgo: 2, service: "Clean, oil, time and adjust - other vintage",
        problem: "Stiff handwheel, no power at the pedal.", diagnosis: "Motor brushes worn flat, hardened grease in the gearbox.", workDone: "Replaced brushes, re-greased gears, cleaned, timed and tested. Runs sweet.",
        lines: [{ kind: "SERVICE", d: "Clean, oil, time and adjust - other vintage", cents: 13900, taxable: false }, { kind: "PART", d: "Motor brush set, Singer 201-2", cents: 2400, taxable: true, partKey: "rp_brush" }],
        accessories: ["Power cord", "Foot control", "Case / bag"], checklist: 11, readings: { upperFoundG: 90, upperLeftG: 95, bobbinFoundG: 24, bobbinLeftG: 24 }, notes: "He will come by Saturday. Prepay by card.",
      },
      ...guestTicketSpecs,
    ];
    tickets.sort((a, b) => b.intakeAgo - a.intakeAgo);
    let ticketNo = 100;
    const ticketIdBy: Record<string, string> = {};
    for (const t of tickets) {
      ticketNo++;
      const intakeAt = ago(t.intakeAgo, "10:15");
      const rate = TAX;
      const lineNet = t.lines.map((l) => roundCents((l.qty ?? 1) * l.cents));
      const subtotal = lineNet.reduce((a, b) => a + b, 0);
      const taxable = t.lines.reduce((a, l, i) => a + ((l.taxable ?? true) ? lineNet[i] : 0), 0);
      const total = subtotal + roundCents((taxable * Math.round(rate * 10_000)) / 1_000_000);
      const done: Record<string, { done: boolean; by: string; at: string }> = {};
      checklist.slice(0, t.checklist).forEach((c, i) => (done[c] = { done: true, by: gus.name, at: new Date(intakeAt.getTime() + (i + 1) * 50 * MIN + 86_400_000).toISOString() }));
      const ticket = await db.ticket.create({
        data: {
          shopId,
          number: ticketNo,
          status: t.status,
          machineId: mid[t.machine],
          customerId: cid[t.cust],
          serviceRequested: t.service,
          problem: t.problem,
          diagnosis: t.diagnosis ?? null,
          workDone: t.workDone ?? null,
          preApprovedCents: t.preApproved ?? null,
          approvedCents: t.approved ?? null,
          accessories: t.accessories,
          accessoriesReturned: t.status === "COLLECTED" ? t.accessories : [],
          checklist: done,
          upperFoundG: t.readings?.upperFoundG ?? null,
          upperLeftG: t.readings?.upperLeftG ?? null,
          bobbinFoundG: t.readings?.bobbinFoundG ?? null,
          bobbinLeftG: t.readings?.bobbinLeftG ?? null,
          taxRatePct: rate,
          intakeAt,
          readyAt: t.readyAgo != null ? ago(t.readyAgo, "15:00") : null,
          pickupReadyAt: t.status === "READY_FOR_PICKUP" && t.readyAgo != null ? ago(t.readyAgo, "15:00") : null,
          closedAt: t.closedAgo != null ? ago(t.closedAgo, "11:30") : null,
          warrantyUntil: t.closedAgo != null ? new Date(ago(t.closedAgo, "11:30").getTime() + 90 * 86_400_000) : null,
          openedById: priya.id,
          techId: gus.id,
          notes: t.notes ?? null,
          createdAt: intakeAt,
        },
        select: { id: true },
      });
      ticketIdBy[t.machine] = ticket.id;
      for (const [i, l] of t.lines.entries()) {
        await db.ticketLine.create({
          data: { ticketId: ticket.id, kind: l.kind, description: l.d, qty: l.qty ?? 1, unitPriceCents: l.cents, taxable: l.taxable ?? true, partId: l.partKey ? partId[l.partKey] : null, createdAt: new Date(intakeAt.getTime() + i * MIN) },
        });
        if (l.partKey && t.status !== "WAITING_PARTS") {
          await db.part.update({ where: { id: partId[l.partKey] }, data: { qtyOnHand: { decrement: l.qty ?? 1 } } });
          await db.stockMove.create({ data: { shopId, partId: partId[l.partKey], qty: -(l.qty ?? 1), reason: "USED", ticketId: ticket.id, userId: gus.id, note: `Ticket #${ticketNo}`, createdAt: new Date(intakeAt.getTime() + 86_400_000) } });
        }
      }
      if (t.paid) {
        await db.payment.create({ data: { ticketId: ticket.id, method: "CARD", amountCents: total, paidAt: ago(t.closedAgo ?? 0, "11:30"), note: null } });
      }
      if (t.wait) {
        await db.partWait.create({
          data: { shopId, ticketId: ticket.id, partId: partId[t.wait.partKey], description: t.wait.description, qty: 1, supplier: t.wait.supplier, orderedAt: ago(t.wait.orderedAgo, "09:30"), expectedOn: dayYmd(t.wait.etaDays), note: "Ordered by phone, tracking to follow." },
        });
      }
    }
    await db.shop.update({ where: { id: shopId }, data: { nextTicketNumber: ticketNo + 1 } });

    // ---------- appointments and booking ----------
    const weekdays = (from: string, to: string) => [2, 3, 4, 5, 6].map((day) => ({ day, from, to }));
    const typeRow = async (name: string, minutes: number, feeCents: number, extra: { resource?: string; capacity?: number; hours?: object[]; online: boolean; sortOrder: number; location?: string }) =>
      (await db.appointmentType.create({ data: { shopId, name, minutes, feeCents, taxable: false, capacity: extra.capacity ?? 1, resource: extra.resource ?? null, hours: extra.hours ?? [], online: extra.online, sortOrder: extra.sortOrder, location: extra.location ?? "Bobbin & Bolt, front counter" }, select: { id: true } })).id;
    const tDrop = await typeRow("Machine drop-off", 15, 0, { capacity: 3, hours: weekdays("10:00", "16:45"), online: true, sortOrder: 1 });
    const tLong = await typeRow("Longarm rental, 2 hours", 120, 4000, { resource: "Longarm", capacity: 1, hours: weekdays("10:00", "17:00"), online: true, sortOrder: 2, location: "Longarm studio, back of the shop" });
    const tLesson = await typeRow("Private lesson on your machine, 1 hour", 60, 4500, { hours: [3, 4, 5, 6].map((day) => ({ day, from: "10:00", to: "16:00" })), online: true, sortOrder: 3 });
    const tPick = await typeRow("Machine pickup", 15, 0, { capacity: 3, hours: weekdays("10:00", "16:45"), online: false, sortOrder: 4 });
    const appt = async (typeId: string, cust: string | null, day: number, from: string, mins: number, status = "BOOKED", extra: Partial<{ title: string; resource: string; staff: string; fee: number; paid: boolean; blocked: boolean; ticketId: string; source: string; note: string }> = {}) => {
      const typeNames: Record<string, string> = { [tDrop]: "Machine drop-off", [tLong]: "Longarm rental, 2 hours", [tLesson]: "Private lesson on your machine, 1 hour", [tPick]: "Machine pickup" };
      const start = at(day, from);
      await db.appointment.create({
        data: {
          shopId,
          typeId: extra.blocked ? null : typeId,
          resource: extra.resource ?? (typeId === tLong ? "Longarm" : null),
          blocked: Boolean(extra.blocked),
          customerId: cust ? cid[cust] : null,
          name: cust ? cname[cust] : "",
          title: extra.title ?? typeNames[typeId],
          startsAt: start,
          endsAt: new Date(start.getTime() + mins * MIN),
          status,
          staffId: extra.staff ?? null,
          ticketId: extra.ticketId ?? null,
          feeCents: extra.fee ?? 0,
          paidCents: extra.paid ? extra.fee ?? 0 : null,
          paidAt: extra.paid ? start : null,
          source: extra.source ?? "counter",
          note: extra.note ?? null,
          createdById: priya.id,
          createdAt: new Date(start.getTime() - 3 * 86_400_000),
        },
      });
    };
    await appt(tLong, "janet", 0, "11:00", 120, "BOOKED", { fee: 4000, note: "Wedding quilt, 90x108. Bring the loaded top." });
    await appt(tLong, "linda", -3, "13:00", 120, "DONE", { fee: 4000, paid: true });
    await appt(tDrop, "ruth", -3, "10:30", 15, "DONE", { ticketId: ticketIdBy["ruth_b"] });
    await appt(tDrop, "kristen", 3, "10:30", 15, "BOOKED", { source: "online", note: "Brother XR9500, skipping stitches." });
    await appt(tLong, "linda", 3, "14:00", 120, "BOOKED", { fee: 4000, source: "online" });
    await appt(tLesson, "nadia", 4, "13:00", 60, "BOOKED", { fee: 4500, staff: priya.id, note: "Wants to learn her new Janome's needle threader and buttonholes." });
    await appt(tDrop, "patricia", 5, "11:30", 15, "BOOKED");
    await appt(tLong, "guild", 6, "10:00", 120, "BOOKED", { fee: 4000, note: "Guild charity quilts, three tops." });
    await appt(tLong, null, 5, "14:00", 120, "BOOKED", { blocked: true, title: "Longarm maintenance (Gus)", resource: "Longarm" });
    if (guest) await appt(tPick, "guest", 3, "11:00", 15, "BOOKED", { ticketId: ticketIdBy[guestTicketSpecs.find((t) => t.status === "READY_FOR_PICKUP")?.machine ?? "guest_0"], note: "Pickup of the ready machine." });
    await appt(tPick, "walt", 0, "15:30", 15, "BOOKED", { ticketId: ticketIdBy["walt_s"], source: "counter" });

    // ---------- shifts (two weeks around today) ----------
    const crew: { id: string; name: string; days: Record<number, { from: string; to: string; role: string }> }[] = [
      { id: marlene.id, name: marlene.name, days: { 2: { from: "10:00", to: "18:00", role: "Counter" }, 3: { from: "16:00", to: "20:30", role: "Classroom" }, 4: { from: "10:00", to: "17:00", role: "Counter" }, 6: { from: "09:30", to: "17:30", role: "Counter" } } },
      { id: priya.id, name: priya.name, days: { 2: { from: "09:30", to: "17:30", role: "Counter" }, 3: { from: "09:30", to: "17:30", role: "Counter" }, 5: { from: "09:30", to: "17:30", role: "Counter" }, 6: { from: "09:30", to: "17:30", role: "Counter" } } },
      { id: gus.id, name: gus.name, days: { 1: { from: "08:00", to: "16:00", role: "Bench" }, 2: { from: "08:00", to: "16:00", role: "Bench" }, 3: { from: "08:00", to: "16:00", role: "Bench" }, 4: { from: "08:00", to: "16:00", role: "Bench" }, 5: { from: "08:00", to: "16:00", role: "Bench" } } },
    ];
    for (let d = -8; d <= 14; d++) {
      for (const p of crew) {
        const s = p.days[dow(d)];
        if (s) await db.shift.create({ data: { shopId, userId: p.id, name: p.name, startsAt: at(d, s.from), endsAt: at(d, s.to), role: s.role, createdById: marlene.id } });
      }
    }

    // ---------- marketing ----------
    await db.messagingSettings.create({
      data: { shopId, emailOn: true, smtpPreset: "other", smtpHost: "smtp.example.com", fromName: "Bobbin & Bolt Quilt Co.", fromEmail: "hello@example.com", replyTo: "hello@example.com", replyWatchedAt: ago(10), replyWatchedBy: marlene.name, postalAddress: "214 Spool Street, Maple Hollow, WI 54999", tzConfirmedAt: ago(10), tzConfirmedBy: marlene.name, emailOkAt: ago(1) },
    });
    await db.campaign.create({
      data: {
        shopId,
        name: "Fall Shop Hop Weekend: 20% off fat quarters",
        channel: "email",
        subject: "Shop Hop weekend: 20% off every fat quarter",
        body: "Hi {first_name},\n\nIt is Shop Hop weekend here at {shop_name}. Come see us Friday through Sunday for 20% off every fat quarter and bundle in the shop, free cider, and a free pattern with any purchase over $25.\n\nOur classroom is also open for a peek at the October classes.\n\nHope to see you,\nThe Bobbin & Bolt crew\n{shop_phone}",
        audience: { kind: "bought", days: 365 },
        status: "DRAFT",
        createdById: marlene.id,
        createdAt: ago(1),
      },
    });
    const recipients = custs.filter((c) => c.email && c.key !== "guild");
    const sentCampaign = await db.campaign.create({
      data: {
        shopId,
        name: "October classes are open for sign-up",
        channel: "email",
        subject: "New classes at Bobbin & Bolt: Beginner Quilting, Free-Motion and more",
        body: "Hi {first_name},\n\nOur October classes are open: Beginner Quilting (4 weeks), Free-Motion Quilting, Embroidery Machine Basics and Block of the Month. Seats are limited, so sign up at the counter or online.\n\n{upcoming_classes}\n\nSee you in class!\n{shop_name}",
        audience: { kind: "all" },
        status: "SENT",
        members: recipients.map((c) => cid[c.key]),
        built: recipients.length,
        queuedAt: ago(6, "09:30"),
        finishedAt: ago(6, "09:36"),
        recipients: recipients.length,
        skipped: { no_address: custs.length - recipients.length },
        createdById: marlene.id,
        queuedById: marlene.id,
        createdAt: ago(7),
      },
      select: { id: true },
    });
    for (const [i, c] of recipients.entries()) {
      await db.outMessage.create({
        data: {
          shopId,
          channel: "email",
          purpose: "marketing",
          kind: "campaign",
          customerId: cid[c.key],
          address: c.email!,
          subject: "New classes at Bobbin & Bolt: Beginner Quilting, Free-Motion and more",
          body: `Hi ${c.name.split(" ")[0]},\n\nOur October classes are open: Beginner Quilting (4 weeks), Free-Motion Quilting, Embroidery Machine Basics and Block of the Month.`,
          status: i === 3 ? "SKIPPED" : "SENT",
          sendAfter: ago(6, "09:30"),
          sentAt: new Date(ago(6, "09:31").getTime() + i * 1500),
          campaignId: sentCampaign.id,
          refType: "class",
          byUserId: marlene.id,
          createdAt: ago(6, "09:30"),
        },
      });
    }

    console.log(`
Demo company ready: ${SHOP_NAME}
  company id   ${shopId}
  sign in      ${DEMO_EMAIL}  /  ${process.env.DEMO_PASSWORD ? "the DEMO_PASSWORD you chose" : password}
  customers    ${custs.length}${guest ? " (incl. the guest from guest.local.json)" : ""}
  stock items  ${items.length}, ${items.filter((i) => i.online).length} listed in the online shop
  sales        ${sales.length} over three weeks, ${money(salesTotalCents)} taken
  classes      ${classes.length}
  tickets      ${tickets.length}
  public pages /book/bobbin-and-bolt and /shop/bobbin-and-bolt
Remove it again with: npx tsx scripts/demo/seed-demo.ts --remove`);
  } finally {
    await db.$disconnect();
  }
}

void main();
