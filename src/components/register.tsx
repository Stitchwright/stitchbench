"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, CameraOff, CalendarDays, Gift, Trash2, Undo2, Wrench, Plus } from "lucide-react";
import {
  bookingsDue,
  completeSale,
  customerTaxExempt,
  findCustomers,
  findItems,
  itemByCode,
  pickupJobByTag,
  pickupJobs,
  quickAddCustomer,
  saleForReturn,
  type CustomerHit,
  type PickupJob,
  type SaleForReturn,
} from "@/actions/register";
import type { RegisterItem } from "@/lib/register-item";
import type { BookingDue } from "@/lib/booking-types";
import { enrollAtRegister, openClassSeats } from "@/actions/class-register";
import { giftCardByNumber, type GiftCardInfo } from "@/actions/gift-cards";
import { GIFT_MAX_CENTS, GIFT_MIN_CENTS, looksLikeGiftCard, type Issued } from "@/lib/gift-card-number";
import { beep, CAMERA_INSTEAD, useBarcodeCamera } from "@/components/barcode-camera";
import { InsecureNotice } from "@/components/secure-page";
import { VacSupplyPicker } from "@/components/vac/supply-picker";
import { ColorFinder } from "@/components/color-finder";
import { RegisterGiftLists, type GiftListPick } from "@/components/register-gift-lists";
import { RegisterCardReader, type ReaderSetup } from "@/components/register-card-reader";
import { ThreadPhotoMatch } from "@/components/thread-photo-match";
import { CustomerFits, GoesWith, StarterBundles } from "@/components/register-fits";
import { SoftwareLineFields } from "@/components/software-line";
import type { SoftwareLineInput } from "@/lib/software";
import { UnitTools, type TradeKind } from "@/components/units/unit-tools";
import { LayawayPanel, type LayawayDefaults } from "@/components/layaway-panel";
import { SpecialOrderPanel, type SpecialOrderDefaults } from "@/components/special-order-panel";
import { CustomerExtrasLines, useCustomerExtras, type ExtraLine } from "@/components/register-extras";
import { bestRule, type RuleCtx, type YardBreak } from "@/lib/price-rules";
import { holidayCovers, holidayDays, type Holiday } from "@/lib/tax-holiday-math";
import { bestDiscount, includedPromo, priceBeforeTax, type Promo } from "@/lib/promo-math";
import { RegisterApproval, overLimit, type ApprovalDraft, type ApprovalNeed } from "@/components/register-approval";
import { bringItHere } from "@/actions/transfers";
import { runAction } from "@/components/action-form";

const NO_PROMOS: Promo[] = [];
const NO_BREAKS: YardBreak[] = [];
import { money, toCents } from "@/lib/format";
import { parseScanCode } from "@/lib/scan-codes";
import { receiptStands } from "@/lib/sale-return";
import { nameOrPhone } from "@/lib/phone";
import { discountBase, inEighths, lineNet, qtyText, roundCents, saleTotals, tenderProblem, TENDER_LABEL, TENDER_METHODS, type Tender, type TenderMethod } from "@/lib/register-math";
import type { PlanCart, TradeInInput, UnitCartLine } from "@/lib/units/types";

type CartLine = {
  key: string;
  partId?: string;
  repairJobId?: string;
  pickedUp?: boolean;
  /** A repair's machine that already went home (this line pays the rest of its bill). */
  handedOver?: boolean;
  description: string;
  partNumber?: string;
  unit: string | null;
  qty: number;
  unitPriceCents: number;
  /** The item has a price in inventory: only an owner or admin changes it. */
  priced?: boolean;
  /** How many the shop had when the item was scanned (a warning when the sale asks for more). */
  onHand?: number;
  discountPct: number;
  taxable: boolean;
  consigned?: boolean;
  /** "used", "compatible, not genuine Brother"...: the receipt says it after the description. */
  disclosure?: string;
  /** Vac Shop: the customer's vacuum this supply is for. Any shop: a machine sold from stock; a trade-in taken as credit; a service plan. */
  machineId?: string | null;
  stockUnitId?: string;
  tradeIn?: TradeInInput;
  servicePlan?: PlanCart;
  /** What the line is reported under (a part's kind, UNIT, CLASS...): a tax holiday covers some kinds only. */
  kind?: string;
  /** A tax holiday covers it but the cashier charges the tax anyway. */
  taxAnyway?: boolean;
  /** The item's or machine's brand: a promotion may cover a brand. */
  brand?: string | null;
  /** A class seat or an appointment paid or refunded here (design 12.3): one each, priced by the server. */
  enrollmentId?: string;
  appointmentId?: string;
  /** A gift card sold, loaded or paid out on this line: untaxed, never discounted, one at a time (the server prices a payout). */
  giftCard?: { mode: "new" | "printed" | "load" | "cashout"; number?: string };
  /** The sale a scanned receipt brought this return line back from. */
  fromSale?: string;
  /** Software (shop-features-round-2-design.md 2.5): its code, "later", the machine, a renewal, a return's reason. */
  software?: SoftwareLineInput;
  /** A special order picked up (shop-features-round-2-design.md 1.2): its item at the order's price, and what was paid coming off. */
  specialOrderId?: string;
  depositUsed?: boolean;
  /** The item's wholesale price (a Wholesale group sells at it), and the cashier took the customer's price rule off this line. */
  wholesaleCents?: number | null;
  noRule?: boolean;
  /** The item's own per-yard break (1.6). */
  breakMinQty?: number | null;
  breakPriceCents?: number | null;
  /** A machine bought with a repair's trade-up credit (1.9): the ticket. */
  tradeUpTicketId?: string;
  /** Also listed on eBay, Etsy... (shop-features-round-2-design.md 9.7), and whether the cashier ticked it taken down. */
  listedOn?: string[];
  delisted?: boolean;
  /** From a customer's gift list (9.9): the list item it ticks off, and the list's name for the line. */
  registryItemId?: string;
  listName?: string;
  /** "Ship it to her from there" (7.3): the other store it ships from. */
  shipFromId?: string;
  shipFromName?: string;
};

type NewCustomer = { name: string; phone: string; email: string; address: string };
const EMPTY_CUSTOMER: NewCustomer = { name: "", phone: "", email: "", address: "" };

/** What a scanned receipt left out because it has its own way back (which settles the booking or the vacuum too). */
function leftOut(s: SaleForReturn): string {
  const booking = s.skippedBookingLines ? " A class or appointment on it was left out: refund it with Classes & appointments while returning." : "";
  const unit = s.skippedUnitLines ? " A machine, service plan or trade-in on it was left out: take a machine back with Return a machine; void the sale to undo a trade-in." : "";
  const layaway = s.skippedLayawayLines ? " A layaway payment on it was left out: settle it on the layaway's page." : "";
  return booking + unit + layaway;
}

/** A machine, or the last of an item, also listed elsewhere: ticked "taken down" before the sale (9.7). */
const mustDelist = (l: CartLine) => !!l.listedOn?.length && l.qty > 0 && (!!l.stockUnitId || (l.onHand ?? 0) - l.qty < 1);
const discountOf = (l: CartLine) => Math.round((Math.abs(roundCents(l.qty * l.unitPriceCents)) * l.discountPct) / 100);
const newKey = () => Math.random().toString(36).slice(2);
// Names a sale for the server, so one sent twice is made once. getRandomValues works on the shop's plain-http network.
const saleKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// A handheld scanner types a code much faster than anyone can, then presses Enter.
const SCAN_MIN_CHARS = 4;
const SCAN_MAX_GAP_MS = 60;
const SCAN_AVG_GAP_MS = 35;

// The payment box: the everyday ways to pay as big buttons, the rest smaller under the amount.
const BIG_METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK"];
const SMALL_METHODS = TENDER_METHODS.filter((m) => !BIG_METHODS.includes(m));

/** Puts text back in a field the way typing would, so the page's own state follows. */
function setFieldText(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Register({
  taxRatePct,
  hasPartners,
  canSell,
  vac,
  unitKinds,
  layaway,
  holiday,
  lenders = [],
  promotions = NO_PROMOS,
  specialOrders = null,
  yardBreaks = NO_BREAKS,
  tradeInLessPct = 30,
  preload,
  preloadItems,
  tradeNote,
  sellers = [],
  me = "",
  houseAccounts = false,
  cardReader = null,
  threadPhoto = null,
  store = null,
}: {
  taxRatePct: number;
  hasPartners: boolean;
  canSell: boolean;
  vac?: "on" | "readonly" | "off";
  /** Machines for sale: the kinds the shop may sell and take in trade now (empty: returns only); absent while it has no machines for sale or plans. */
  unitKinds?: TradeKind[] | null;
  /** The shop's layaway defaults and today (in its zone), for the Layaway button. */
  layaway?: LayawayDefaults;
  /** The sales tax holiday in force today, if any: the lines it covers carry no tax. */
  holiday?: Holiday | null;
  /** The lenders the shop offers financing through: the Financing payment button shows when there are any. */
  lenders?: { id: string; name: string }[];
  /** The promotions in force today (percent or amount off, the price including the tax). */
  promotions?: Promo[];
  /** Special orders (shop-features-round-2-design.md 1.2): the shop's default deposit; absent for a shop without a counter. */
  specialOrders?: SpecialOrderDefaults | null;
  /** The shop's per-yard breaks (shop-features-round-2-design.md 1.6). */
  yardBreaks?: YardBreak[];
  /** The trade-in rule (1.9): what the shop expects to sell it for, less this percent. */
  tradeInLessPct?: number;
  preload?: BookingDue | null;
  /** Opened from the quilt planner's "Add all to the sale": each item with its quantity (yards for fabric). */
  preloadItems?: { item: RegisterItem; qty: number }[];
  /** The Assistant's trade-in condition note (shop-features-round-2-design.md 5.4), when it can be used here. */
  tradeNote?: { unavailable?: string } | null;
  /** Who can be picked as the seller (commissions, 9.7), and the person signed in (the default). */
  sellers?: { id: string; name: string }[];
  me?: string;
  /** House accounts are on (9.4): "On account" is offered once a customer is picked (the server checks her account). */
  houseAccounts?: boolean;
  /** The shop's card readers (4.8), when the card reader is on: Card reader sends the amount to one. */
  cardReader?: ReaderSetup | null;
  /** The Assistant's thread match from a photo (9.10): shown with the Fabric and thread helpers on; unavailable says why it can't run now. */
  threadPhoto?: { unavailable?: string } | null;
  /**
   * More than one store (shop-features-round-2-design.md 7.2, 7.3, 7.5): this store's name, its refund and discount
   * limits, and whether special orders can be brought over. Null with one store: nothing about stores shows.
   */
  store?: { name: string; limits: { refundCents: number | null; discountPct: number | null } } | null;
}) {
  const router = useRouter();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [soldBy, setSoldBy] = useState(me);

  const [returnMode, setReturnMode] = useState(false);
  // The sale a scanned receipt brought back: a return-only cart gives the tax back at that sale's rate (the server does the
  // same), while every return line on it came from that receipt (receiptOf below).
  const [returnOf, setReturnOf] = useState<{ id: string; taxRatePct: number } | null>(null);
  const [results, setResults] = useState<RegisterItem[]>([]);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  // A tax-exempt customer's sale charges no tax unless the cashier ticks "Charge tax anyway".
  const [chargeTax, setChargeTax] = useState(false);
  const customerId = customer?.id ?? null;
  const exemptKnown = customer ? customer.taxExemptId !== undefined : true;
  // A customer handed over without the answer (a booking, a sale found for a return): ask the server once.
  useEffect(() => {
    if (!customerId || exemptKnown) return;
    let live = true;
    customerTaxExempt(customerId).then((cert) => {
      if (live) setCustomer((c) => (c && c.id === customerId ? { ...c, taxExemptId: cert } : c));
    });
    return () => {
      live = false;
    };
  }, [customerId, exemptKnown]);
  const exemptCert = customer?.taxExemptId ?? null;
  const exemptOn = Boolean(exemptCert) && !chargeTax;
  const ratePct = exemptOn ? 0 : taxRatePct;
  const [custQ, setCustQ] = useState("");
  const [custHits, setCustHits] = useState<CustomerHit[]>([]);
  // The search the hits answer, so "No customer matches" shows only once the answer for what is typed is back.
  const [custSearched, setCustSearched] = useState("");
  // The "New customer" form: open with its fields, or closed.
  const [newCustomer, setNewCustomerForm] = useState<NewCustomer | null>(null);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const setNewCustomer = (open: boolean) => setNewCustomerForm(open ? EMPTY_CUSTOMER : null);
  const [orderDisc, setOrderDisc] = useState({ kind: "%" as "%" | "$", value: "" });
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [tenderAmt, setTenderAmt] = useState("");
  // Cash (or Card, Check, Other) pressed with no amount typed: that payment took what was due, and the amount box now
  // edits it, so "press Cash, then type what was handed over" works as well as typing first. `fullCents` is what it
  // took, put back when the box is emptied.
  const [editing, setEditing] = useState<{ index: number; fullCents: number } | null>(null);
  const tenderBox = useRef<HTMLInputElement>(null);
  const donePanel = useRef<HTMLDivElement>(null);
  // The gift card or store credit number for the next Gift card / Store credit payment, and the card last scanned.
  const [tenderCard, setTenderCard] = useState("");
  // The Financing payment's lender and approval number, while it is being filled in.
  const [fin, setFin] = useState<{ lenderId: string; approval: string } | null>(null);
  const [gcInfo, setGcInfo] = useState<GiftCardInfo | null>(null);
  const [gcPanel, setGcPanel] = useState<{ mode: "new" | "printed" | "load" | "cashout"; number: string; amount: string } | null>(null);
  const [misc, setMisc] = useState<{ description: string; price: string; taxable: boolean } | null>(null);
  const [jobs, setJobs] = useState<PickupJob[] | null>(null);
  // The "Classes & appointments" picker: what is owed (or refundable in return mode) and the classes with seats.
  const [bookings, setBookings] = useState<{ due: BookingDue[]; seats: Awaited<ReturnType<typeof openClassSeats>>; refunds: boolean } | null>(null);
  const [signup, setSignup] = useState<{ classId: string; name: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: number; change: number; cards: Issued[] } | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // A "Coming soon" item picked in the search: the special order panel opens on it (a pre-order).
  const [preorderItem, setPreorderItem] = useState<RegisterItem | null>(null);
  // More than one store (7.3, 7.5): an item none here but at another store; bringing it over for her; where shipped
  // lines go; a refund or discount waiting for its OK (and the OK it got).
  const [elsewhereItem, setElsewhereItem] = useState<RegisterItem | null>(null);
  const [bringFrom, setBringFrom] = useState<{ id: string; name: string } | null>(null);
  const [shipTo, setShipTo] = useState("");
  const [approvalAsk, setApprovalAsk] = useState<{ need: ApprovalNeed; draft: ApprovalDraft } | null>(null);
  const approvalId = useRef<string | null>(null);
  const code = useRef<HTMLInputElement>(null);
  const last = useRef({ code: "", at: 0 });
  // The sale as last sent and the key it went with: sent again unchanged (after a lost answer), it keeps the key.
  const pending = useRef<{ key: string; sent: string } | null>(null);

  // A partner's repair bill is paid as billed, and a trade-in is credit: a whole-sale discount doesn't come off them.
  // A promotion in force today gives an item its best percent or amount off, a tax holiday takes the tax off the lines
  // it covers, and a "price includes the tax" promotion backs the tax out of the price (the server applies the same rules
  // when the sale is saved; only the discount typed here is sent).
  // The chosen customer's extras (shop-features-round-2-design.md section 1): special orders waiting, her price group,
  // lifetime discounts; the rules price the lines as the server will (src/lib/price-rules.ts).
  const extras = useCustomerExtras(customer?.id ?? null);
  // Her birthday offer, used on this sale (a percent off): one tap on her quiet line.
  const [birthdayFor, setBirthdayFor] = useState<string | null>(null);
  const birthdayOn = !!customer && birthdayFor === customer.id && extras?.birthday?.kind === "pct";
  const ruleCtx = useMemo<RuleCtx>(
    () => ({ group: extras?.group?.inForce ? extras.group : null, lifetime: extras?.lifetime ?? [], yardBreaks, birthdayPct: birthdayOn ? (extras?.birthday?.value ?? null) : null }),
    [extras, yardBreaks, birthdayOn],
  );
  const lines = useMemo(
    () =>
      cart.map((l) => {
        const manual = discountOf(l);
        const start = { ...l, discountCents: manual, discountable: !l.repairJobId && !l.tradeIn && !l.enrollmentId && !l.appointmentId && !l.giftCard && !l.depositUsed };
        const item = start.qty > 0 && Boolean(start.partId || start.stockUnitId) && !returnOf && !start.specialOrderId;
        const best = item ? bestDiscount(promotions, start) : null;
        const promoLine = best && best.cents > manual ? { ...start, discountCents: best.cents } : start;
        // The customer's price rule (her group, a lifetime discount, a yard break, the birthday offer): the bigger wins.
        const hit = item && !l.noRule && l.kind !== "MEMBERSHIP" ? bestRule(ruleCtx, { ...promoLine, onPromo: !!best }) : null;
        const ruledHit = !!hit && hit.cents > promoLine.discountCents;
        const ruledLine = ruledHit ? { ...promoLine, discountCents: hit.cents } : promoLine;
        // A repair's trade-up credit on a machine (the server works out the same).
        const credit = l.tradeUpTicketId ? Math.min(Math.abs(roundCents(l.qty * l.unitPriceCents)), extras?.tradeUps.find((t) => t.ticketId === l.tradeUpTicketId)?.amountCents ?? 0) : 0;
        const tradeUp = credit > ruledLine.discountCents;
        const line = tradeUp ? { ...ruledLine, discountCents: credit } : ruledLine;
        const ruled = ruledHit || tradeUp;
        const covered = !!holiday && line.qty > 0 && holidayCovers(holiday, { ...line, kind: line.kind ?? "MISC" });
        const taxable = line.taxable && !(covered && !line.taxAnyway);
        const included = item && taxable && !covered && !line.discountCents && ratePct > 0 ? includedPromo(promotions, line) : null;
        return { ...line, manualDiscountCents: manual, promo: included?.name ?? (!ruled && best && best.cents > manual ? best.promo.name : null), rule: tradeUp ? "Trade-up credit" : ruled ? hit!.label : null, taxIncluded: !!included, holidayCovered: covered, taxable };
      }),
    [cart, holiday, promotions, returnOf, ratePct, ruleCtx, extras],
  );
  // The totals count a tax-included line at its price before tax (the tax is added back on top).
  const priced = lines.map((l) => (l.taxIncluded ? { ...l, unitPriceCents: priceBeforeTax(l.unitPriceCents, ratePct) } : l));
  const base = discountBase(priced);
  const orderDiscountCents =
    orderDisc.value === "" ? 0 : orderDisc.kind === "%" ? Math.round((base * Math.min(100, Number(orderDisc.value) || 0)) / 100) : Math.min(base, toCents(orderDisc.value) ?? 0);
  // The release keeps "tax as sold" only while every return line came from the scanned receipt (receiptOf); sales-features
  // totals the tax-included lines at their price before tax (priced). Both: the receipt's rate over the priced lines.
  const receiptOf = returnOf && receiptStands(returnOf.id, cart) ? returnOf : null;
  const receiptRate = receiptOf && lines.every((l) => l.qty < 0) ? receiptOf.taxRatePct : null;
  const t = saleTotals(priced, orderDiscountCents, receiptRate ?? ratePct, tenders);
  const refund = t.total < 0;
  // Why the payments so far can't settle the sale (the server checks the same); it can't be completed until there is none.
  const problem = tenderProblem(t, tenders);
  // Still to pay back on a refund: below 0 when too much was paid back.
  const refundLeft = t.paid - t.total;
  const editingTender = editing ? (tenders[editing.index] ?? null) : null;

  useEffect(() => code.current?.focus(), []);
  // The finished sale's panel (change due, Print receipt) is where the cashier looks next: bring it into view.
  useEffect(() => {
    if (done) donePanel.current?.scrollIntoView?.({ block: "nearest" });
  }, [done]);

  // Enter in a line's Qty, Price or Disc % field: back to the scan box for the next item.
  const backToScan = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") code.current?.focus();
  };

  /** An item scanned or picked, with the customer's vacuum it was bought for when the Vac Shop's picker found it. */
  function addItem(it: RegisterItem, machineId: string | null = null, qtyIn?: number) {
    const sign = returnMode ? -1 : 1;
    // A machine for sale is sold once, as one line of 1.
    if (it.stockUnitId) {
      if (cart.some((l) => l.stockUnitId === it.stockUnitId)) {
        toast.warning("That machine is already on this sale.");
        return;
      }
      setDone(null);
      setCart((c) => [...c, { key: newKey(), stockUnitId: it.stockUnitId!, description: it.description, unit: null, qty: 1, unitPriceCents: it.priceCents ?? 0, priced: it.priceCents != null, discountPct: 0, taxable: true, kind: "UNIT", brand: it.brand ?? null, listedOn: it.listedOn }]);
      return;
    }
    setDone(null);
    // Software is one licence a line, each with its own code.
    if (it.kind === "SOFTWARE") {
      setCart((c) => [...c, { key: newKey(), partId: it.id, description: it.description, partNumber: it.partNumber, unit: null, kind: it.kind, brand: it.brand ?? null, qty: sign, unitPriceCents: it.priceCents ?? 0, priced: it.priceCents != null, onHand: it.qtyOnHand, discountPct: 0, taxable: true, software: {} }]);
      if (it.priceCents == null) toast.warning(`${it.partNumber} has no price. Type the price on the line.`);
      return;
    }
    setCart((c) => {
      // The same item scanned again adds one more (not for fabric: each cut is its own line; not across vacuums: a
      // supply bought for another vacuum is its own line).
      const i = c.findIndex((l) => l.partId === it.id && it.unit !== "yd" && Math.sign(l.qty) === sign && (l.machineId ?? null) === machineId && !l.registryItemId);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + sign } : l));
      return [
        ...c,
        {
          key: newKey(),
          partId: it.id,
          description: it.description,
          partNumber: it.partNumber,
          unit: it.unit,
          kind: it.kind,
          brand: it.brand ?? null,
          qty: sign * (qtyIn ?? 1),
          unitPriceCents: it.priceCents ?? 0,
          priced: it.priceCents != null,
          onHand: it.qtyOnHand,
          discountPct: 0,
          // A membership isn't taxed (the server does the same).
          taxable: it.kind !== "MEMBERSHIP",
          consigned: it.consigned,
          disclosure: it.disclosure,
          wholesaleCents: it.wholesaleCents ?? null,
          breakMinQty: it.breakMinQty ?? null,
          breakPriceCents: it.breakPriceCents ?? null,
          machineId,
          listedOn: it.listedOn,
        },
      ];
    });
    if (it.priceCents == null) toast.warning(`${it.partNumber} has no price. Type the price on the line.`);
  }

  /** Lines from the customer's quiet lines (a special order waiting): added as they come, priced already. */
  function addExtraLines(more: ExtraLine[]) {
    setDone(null);
    setCart((c) => [...c, ...more.map((x) => ({ key: newKey(), discountPct: 0, priced: true, ...x }))]);
  }

  /** A gift bought from a customer's list (9.9): its own line, naming the list item. */
  function addGiftListLine(p: GiftListPick) {
    if (cart.some((l) => l.registryItemId === p.registryItemId)) {
      toast.warning("That one is already on this sale. Change its quantity on the line.");
      return;
    }
    setDone(null);
    setCart((c) => [...c, { key: newKey(), partId: p.partId, registryItemId: p.registryItemId, listName: p.listName, description: p.description, partNumber: p.partNumber ?? undefined, unit: null, qty: 1, unitPriceCents: p.priceCents ?? 0, priced: p.priceCents != null, onHand: p.inStock, discountPct: 0, taxable: true }]);
  }

  /** A unit, trade-in, plan or return line the machines-for-sale tools made: added as it comes. */
  function addLine(line: UnitCartLine) {
    setDone(null);
    setCart((c) => [...c, { key: newKey(), discountPct: 0, ...line, kind: line.servicePlan ? "SERVICE_PLAN" : line.stockUnitId ? "UNIT" : undefined }]);
  }

  /** A layaway's deposit, payment or pick-up rang up its own sale: show its receipt link and start the next one fresh. */
  function rungUp(r: { saleId: string; number: number }) {
    pending.current = null;
    setDone({ id: r.saleId, number: r.number, change: 0, cards: [] });
    setCart([]);
    setTenders([]);
    // The release's amount box may be editing a payment pressed first; the payments are gone with the sale.
    setEditing(null);
    setTenderAmt("");
    setFin(null);
    setOrderDisc({ kind: "%", value: "" });
    setCustomer(null);
    setChargeTax(false);
    setReturnMode(false);
    setReturnOf(null);
    code.current?.focus();
  }

  /** A class seat or appointment: one line, the booking's price and tax; a refund in return mode. */
  function addBooking(b: BookingDue, refund: boolean) {
    const id = b.kind === "enrollment" ? { enrollmentId: b.id } : { appointmentId: b.id };
    if (cart.some((l) => (b.kind === "enrollment" ? l.enrollmentId : l.appointmentId) === b.id)) {
      toast.warning(`${b.description} is already on this sale.`);
      return;
    }
    setDone(null);
    setCart((c) => [...c, { key: newKey(), ...id, description: b.description, unit: null, qty: refund ? -1 : 1, unitPriceCents: b.dueCents, priced: true, discountPct: 0, taxable: b.taxable, kind: b.kind === "enrollment" ? "CLASS" : "APPOINTMENT" }]);
    if (!customer && b.customerId) setCustomer({ id: b.customerId, name: b.customerName, phone: null });
  }

  /** The "Classes & appointments" button: what is owed (or refundable), and the classes with seats. */
  async function openBookings() {
    try {
      const refunds = returnMode;
      const [due, seats] = await Promise.all([bookingsDue(customer?.id ?? null, refunds), refunds ? Promise.resolve([]) : openClassSeats()]);
      setBookings({ due, seats, refunds });
      setJobs(null);
    } catch {
      toast.error("Couldn't load the classes and appointments. Check the connection, then try again.");
    }
  }

  /** "Sign up for a class" from the picker: the sign-up is made and its line added. */
  async function signUpHere(classId: string, who: { name: string; phone: string } | null) {
    const fd = new FormData();
    if (customer) fd.set("customerId", customer.id);
    else if (who) {
      fd.set("customerName", who.name);
      fd.set("customerPhone", who.phone);
    } else {
      // No customer on the sale: one form under the class asks who (no error alongside it).
      setSignup({ classId, ...nameOrPhone(custQ) });
      return;
    }
    const r = await enrollAtRegister(classId, fd);
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    toast.success(`Signed up: ${r.description}`);
    if (r.dueCents > 0) addBooking(r, false);
    else if (!customer && r.customerId) setCustomer({ id: r.customerId, name: r.customerName, phone: null });
    setSignup(null);
    setBookings(null);
  }

  // Opened from a roster's "Ring up": the line is on the sale once, then the address goes back to /register so the
  // next sale doesn't carry it.
  const preloaded = useRef(false);
  useEffect(() => {
    if (!preload || preloaded.current) return;
    preloaded.current = true;
    addBooking(preload, false);
    router.replace("/register");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  // Opened from the quilt planner's "Add all to the sale": its items go on the sale once, the same way.
  const itemsLoaded = useRef(false);
  useEffect(() => {
    if (!preloadItems?.length || itemsLoaded.current) return;
    // After the first paint (and once only, however often the effect runs in development).
    const t = setTimeout(() => {
      if (itemsLoaded.current) return;
      itemsLoaded.current = true;
      for (const p of preloadItems) addItem(p.item, null, p.qty);
      router.replace("/register");
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  /** The "New customer" form: adds the customer and puts them on the sale. */
  async function submitNewCustomer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newCustomer) return;
    setAddingCustomer(true);
    try {
      const fd = new FormData();
      for (const [k, v] of Object.entries(newCustomer)) fd.set(k, v);
      const r = await quickAddCustomer(fd);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setCustomer(r);
      setCustHits([]);
      setCustQ("");
      setNewCustomerForm(null);
      toast.success(`${r.name} added`);
    } catch {
      toast.error("Couldn't add the customer. Check the connection, then try again.");
    } finally {
      setAddingCustomer(false);
    }
  }

  // A claim tag's barcode (T<tag>, or plain digits typed by hand) found a repair to pay for: the same line "Repair
  // pickup" adds, so the tag doesn't have to be found in that list by hand.
  function addPickupLine(job: PickupJob) {
    if (cart.some((l) => l.repairJobId === job.id)) {
      toast.warning(`Tag ${job.tag} is already on this sale.`);
      return;
    }
    setDone(null);
    setCart((c) => [
      ...c,
      {
        key: newKey(),
        repairJobId: job.id,
        pickedUp: !job.pickedUp,
        handedOver: job.pickedUp,
        description: `Repair, tag ${job.tag}: ${job.machine}${job.paidCents > 0 ? " (rest of the bill)" : ""}`,
        unit: null,
        qty: 1,
        unitPriceCents: job.dueCents,
        discountPct: 0,
        taxable: false,
      },
    ]);
  }

  // A receipt's barcode (S<number>) found the sale it printed on: its lines come back in as a return, priced (and
  // discounted) exactly as they were sold, ready to adjust or remove before completing the refund.
  function loadReturnSale(sale: SaleForReturn) {
    if (!sale.lines.length) {
      toast.warning(
        sale.skippedRepairLines
          ? `Sale #${sale.number} only paid a repair bill. Sort that out with the repair shop.`
          : sale.skippedCardLines
            ? `Sale #${sale.number} only sold or paid out a gift card. Void the sale to take a card sale back.`
            : sale.skippedBookingLines || sale.skippedUnitLines || sale.skippedLayawayLines
              ? `Sale #${sale.number} has nothing to return from the receipt.${leftOut(sale)}`
              : `Sale #${sale.number} has nothing to return.`,
      );
      return;
    }
    setDone(null);
    setCart((c) => [
      ...c,
      ...sale.lines.map((l) => ({
        key: newKey(),
        partId: l.partId ?? undefined,
        description: l.description,
        partNumber: l.partNumber ?? undefined,
        unit: l.unit,
        // Already the return's own quantity (splitForReturn negates it server-side), not the original sale's.
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        priced: true,
        discountPct: 0,
        taxable: l.taxable,
        fromSale: sale.id,
      })),
    ]);
    setReturnMode(true);
    setReturnOf({ id: sale.id, taxRatePct: sale.taxRatePct });
    if (sale.customer) setCustomer(sale.customer);
    // Paid with a gift card or store credit: the way back is onto that card (press Gift card or Store credit).
    const back = sale.cardsPaid[0];
    if (back) {
      setTenderCard(back.number);
      toast.message(`Sale #${sale.number} was paid with ${back.kind === "credit" ? "store credit" : "a gift card"} (${money(back.amountCents)}). Press ${back.kind === "credit" ? "Store credit" : "Gift card"} to refund it onto the same card.`);
    }
    toast.success(
      `Sale #${sale.number}: ${sale.lines.length} item${sale.lines.length === 1 ? "" : "s"} added as a return.${sale.skippedRepairLines ? " A repair payment on it was left out; sort that out with the repair shop." : ""}${sale.skippedCardLines ? " A gift card on it was left out: void the sale or pay the card out to take that back." : ""}${leftOut(sale)}`,
    );
  }

  async function lookup(raw: string) {
    const c = raw.trim();
    if (!c) return;
    try {
      // A gift card or store credit number scanned: show what it holds, ready to pay with or to add money to.
      if (looksLikeGiftCard(c)) {
        const info = await giftCardByNumber(c, null, undefined);
        if (!("error" in info)) {
          beep(true);
          setResults([]);
          setMissing(null);
          setGcInfo(info);
          setTenderCard(info.number);
          return;
        }
      }
      const it = await itemByCode(c);
      if (it) {
        beep(true);
        setResults([]);
        setMissing(null);
        addItem(it);
        return;
      }
      const scan = parseScanCode(c);
      if (scan.kind === "tag") {
        const job = await pickupJobByTag(scan.tag);
        if (job) {
          beep(true);
          setResults([]);
          setMissing(null);
          addPickupLine(job);
          return;
        }
      } else if (scan.kind === "sale") {
        const sale = await saleForReturn(scan.number);
        if (sale) {
          beep(true);
          setResults([]);
          setMissing(null);
          loadReturnSale(sale);
          return;
        }
      }
      const hits = await findItems(c);
      beep(hits.length > 0);
      setResults(hits);
      setMissing(hits.length ? null : c);
    } catch {
      beep(false);
      toast.error(`Couldn't look up ${c.slice(0, 40)}. Check the connection, then scan it again.`);
    }
  }

  // A camera sees the same code many times a second: count it once. A handheld scanner's every scan counts.
  const { video: camVideo, on: camOn, page: camPage, start: camStart, stop: camStop } = useBarcodeCamera((c) => {
    if (c === last.current.code && Date.now() - last.current.at < 1500) return;
    last.current = { code: c, at: Date.now() };
    lookup(c);
  });

  // A scanner types into whatever has focus: a Qty or Disc % field just typed in, a payment button just clicked. A scan
  // that lands anywhere but the scan box is taken back out of that field and rung up.
  const onScan = useEffectEvent((scanned: string) => {
    code.current?.focus();
    lookup(scanned);
  });
  useEffect(() => {
    let burst = { text: "", start: 0, last: 0, target: null as EventTarget | null, before: null as string | null };
    function onKey(e: KeyboardEvent) {
      if (e.target === code.current || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
        burst.text = "";
        return;
      }
      if (e.key.length === 1) {
        if (!burst.text || e.target !== burst.target || e.timeStamp - burst.last > SCAN_MAX_GAP_MS) {
          // What the field held before this burst of keys, to put back if it turns out to be a scan.
          const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ? e.target : null;
          burst = { text: "", start: e.timeStamp, last: e.timeStamp, target: e.target, before: field ? field.value : null };
        }
        burst.text += e.key;
        burst.last = e.timeStamp;
        return;
      }
      const scanned =
        e.key === "Enter" &&
        burst.text.length >= SCAN_MIN_CHARS &&
        e.timeStamp - burst.last <= SCAN_MAX_GAP_MS &&
        (burst.last - burst.start) / (burst.text.length - 1) <= SCAN_AVG_GAP_MS;
      if (scanned) {
        e.preventDefault();
        e.stopPropagation();
        const { text, target, before } = burst;
        if (before != null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) setFieldText(target, before);
        onScan(text);
      }
      if (e.key !== "Shift") burst.text = "";
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function setLine(key: string, patch: Partial<CartLine>) {
    setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function addTender(method: TenderMethod) {
    // A payment still being typed for is finished by pressing the next way to pay: what is in the box is already its
    // amount, so the new one starts blank (what is still due).
    const typedText = editing ? "" : tenderAmt;
    if (editing) {
      setEditing(null);
      setTenderAmt("");
    }
    const typed = toCents(typedText);
    // Something typed that isn't an amount is not the same as blank (which takes what is still to pay).
    if (typedText.trim() && typed == null) return toast.error("Type the amount like 12.50, or leave it blank.");
    // A refund is paid out in negative amounts, whatever sign was typed. Blank is what is still to pay (back).
    let amount = typed != null ? (refund ? -Math.abs(typed) : typed) : refund ? -refundLeft : t.due;
    let card: { cardNumber: string; last4: string } | null = null;
    if (method === "GIFT" || method === "CREDIT") {
      const number = tenderCard.trim();
      if (method === "GIFT" && !number) return toast.error("Scan or type the gift card number first.");
      // A refund to store credit needs no number (the customer's card, or a new slip); every other way names a card.
      if (!refund || number || method === "GIFT") {
        try {
          const info = await giftCardByNumber(number, customer?.id ?? null, method);
          if ("error" in info) return toast.error(info.error);
          if (!refund) {
            if (typed == null) amount = Math.min(info.balanceCents, t.due);
            if (amount > info.balanceCents) return toast.error(`That card has only ${money(info.balanceCents)} left.`);
          }
          card = { cardNumber: info.number, last4: info.last4 };
        } catch {
          return toast.error("Couldn't look the card up. Check the connection, then try again.");
        }
      }
    }
    if (!amount) return;
    if (refund && amount > 0) return toast.error(`Already refunded ${money(amount)} too much. Take a payment off first.`);
    setTenders((x) => [...x, { method, amountCents: amount, ...(card ?? {}) }]);
    setTenderAmt("");
    setTenderCard("");
    setGcInfo(null);
    if (typed == null && method !== "GIFT" && method !== "CREDIT") {
      // Pressed first: the amount box now edits this payment (type what the customer handed over; the change shows).
      setEditing({ index: tenders.length, fullCents: amount });
      tenderBox.current?.focus();
      return;
    }
    // Ready for the next scan (a scanner's Enter on this button would take the payment again).
    code.current?.focus();
  }

  /** The amount box: typed before a payment button, it waits; after one (Cash pressed first), it changes that payment. */
  function typeTenderAmount(v: string) {
    setTenderAmt(v);
    if (!editing) return;
    const cents = toCents(v);
    const amount = !v.trim() ? editing.fullCents : cents == null || cents === 0 ? null : refund ? -Math.abs(cents) : cents;
    if (amount != null) setTenders((ts) => ts.map((x, i) => (i === editing.index ? { ...x, amountCents: amount } : x)));
  }

  /** A Financing payment: the lender pays the shop; the approval number is kept with it. */
  function addFinanced() {
    if (!fin) return;
    const lender = lenders.find((l) => l.id === fin.lenderId);
    if (!lender) return toast.error("Pick the lender.");
    if (!fin.approval.trim()) return toast.error(`Type ${lender.name}'s approval number.`);
    // Like addTender: while the amount box is editing a payment pressed first (Cash, then the amount), it isn't this one's.
    const typedText = editing ? "" : tenderAmt;
    if (editing) setEditing(null);
    const typed = toCents(typedText);
    if (typedText.trim() && typed == null) return toast.error("Type the amount like 12.50, or leave it blank.");
    const amount = typed != null ? (refund ? -Math.abs(typed) : typed) : refund ? -refundLeft : t.due;
    if (!amount) return;
    setTenders((x) => [...x, { method: "FINANCED", amountCents: amount, lenderId: lender.id, lender: lender.name, note: fin.approval.trim() }]);
    setTenderAmt("");
    setFin(null);
    code.current?.focus();
  }

  /** The gift card panel's "Add to sale": a card sold, loaded or paid out becomes a line (the server decides a payout's amount). */
  async function addGiftLine(e: React.FormEvent) {
    e.preventDefault();
    if (!gcPanel) return;
    const { mode, number } = gcPanel;
    let cents = toCents(gcPanel.amount);
    if (mode !== "cashout") {
      if (cents == null || cents < GIFT_MIN_CENTS || cents > GIFT_MAX_CENTS) return toast.error(`A gift card is from ${money(GIFT_MIN_CENTS)} to ${money(GIFT_MAX_CENTS)}.`);
    }
    if (mode !== "new" && !number.trim()) return toast.error("Scan or type the card number.");
    let description = "Gift card";
    if (mode === "load" || mode === "cashout") {
      const info = await giftCardByNumber(number, null, undefined);
      if ("error" in info) return toast.error(info.error);
      if (info.status !== "active") return toast.error("That card is void.");
      if (mode === "cashout") {
        if (info.balanceCents <= 0) return toast.error("That card has nothing left to pay out.");
        cents = info.balanceCents;
        description = `${info.kind === "credit" ? "Store credit" : "Gift card"} balance paid out (ending ${info.last4})`;
      } else {
        if (info.kind !== "gift") return toast.error("Store credit is given as a refund, not loaded.");
        description = `Gift card loaded (ending ${info.last4})`;
      }
    } else if (mode === "printed") description = "Gift card (pre-printed)";
    setDone(null);
    setCart((c) => [
      ...c,
      { key: newKey(), description, unit: null, qty: mode === "cashout" ? -1 : 1, unitPriceCents: cents ?? 0, priced: mode === "cashout", discountPct: 0, taxable: false, giftCard: { mode, number: number.trim() || undefined } },
    ]);
    setGcPanel(null);
    code.current?.focus();
  }

  /** The card reader approved a payment (4.8): on the sale, which finishes itself once nothing is left to pay. */
  function readerApproved(p: { amountCents: number; stripeIntent: string; last4: string | null }) {
    const next: Tender[] = [...tenders, { method: "CARD", amountCents: p.amountCents, stripeIntent: p.stripeIntent, ...(p.last4 ? { last4: p.last4 } : {}) }];
    setTenders(next);
    setTenderAmt("");
    setEditing(null);
    if (!tenderProblem(saleTotals(priced, orderDiscountCents, receiptRate ?? ratePct, next), next) && !busy) finish(next);
  }

  async function finish(withTenders?: Tender[]) {
    // Over this store's limit (7.5): the OK first (a manager's code or the owner's), then the sale goes through.
    const need = store
      ? overLimit(store.limits, {
          refundCents: t.total < 0 ? -t.total : 0,
          discountCents: lines.reduce((a, l) => a + (l.qty > 0 ? Math.max(0, l.manualDiscountCents) : 0), 0) + orderDiscountCents,
          grossCents: lines.reduce((a, l) => a + (l.qty > 0 ? Math.round(l.qty * l.unitPriceCents) : 0), 0),
        })
      : null;
    if (need && !approvalId.current) {
      setApprovalAsk({ need, draft: { lines: lines.map((l) => ({ description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountCents: l.manualDiscountCents })), customer: customer?.name ?? null, totalCents: t.total } });
      return;
    }
    setBusy(true);
    setDone(null);
    const sale = {
      customerId: customer?.id ?? null,
      birthday: birthdayOn,
      chargeTax: Boolean(exemptCert) && chargeTax,
      returnOfSaleId: receiptOf?.id ?? null,
      lines: lines.map((l) => ({
        giftCard: l.giftCard ?? null,
        partId: l.partId ?? null,
        repairJobId: l.repairJobId ?? null,
        pickedUp: l.pickedUp,
        description: l.description,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.manualDiscountCents,
        taxable: l.taxable,
        machineId: l.machineId ?? null,
        stockUnitId: l.stockUnitId ?? null,
        tradeIn: l.tradeIn ?? null,
        servicePlan: l.servicePlan ?? null,
        taxAnyway: l.taxAnyway ?? false,
        enrollmentId: l.enrollmentId ?? null,
        appointmentId: l.appointmentId ?? null,
        software: l.software ?? null,
        specialOrderId: l.specialOrderId ?? null,
        depositUsed: l.depositUsed ?? false,
        noRule: l.noRule ?? false,
        tradeUpTicketId: l.tradeUpTicketId ?? null,
        delisted: l.delisted ?? false,
        registryItemId: l.registryItemId ?? null,
        shipFromId: l.shipFromId ?? null,
      })),
      soldById: soldBy || null,
      shipTo: lines.some((l) => l.shipFromId) ? shipTo : null,
      approvalId: approvalId.current,
      orderDiscountCents,
      tenders: withTenders ?? tenders,
    };
    const sent = JSON.stringify(sale);
    if (pending.current?.sent !== sent) pending.current = { key: saleKey(), sent };
    try {
      const r = await completeSale({ ...sale, clientKey: pending.current.key });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      pending.current = null;
      approvalId.current = null;
      setApprovalAsk(null);
      setShipTo("");
      setDone({ id: r.saleId, number: r.number, change: r.changeCents, cards: r.cards ?? [] });
      toast.success(`Sale #${r.number} done${r.changeCents ? `. Change: ${money(r.changeCents)}` : ""}`);
      setCart([]);
      setTenders([]);
      setEditing(null);
      setTenderAmt("");
      setTenderCard("");
      setGcInfo(null);
      setGcPanel(null);
      setOrderDisc({ kind: "%", value: "" });
      setCustomer(null);
      setChargeTax(false);
      setReturnMode(false);
      setReturnOf(null);
      setJobs(null);
      setBookings(null);
      code.current?.focus();
    } catch {
      toast.error("The sale didn't go through (no connection, or a problem on the server). Press Complete sale again: a sale that did save won't be saved twice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // At 1024 wide (a tablet held sideways, the menu folded) the sale table and the 20rem payment column both fit.
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = code.current!.value;
            code.current!.value = "";
            lookup(v);
          }}
        >
          <div className="field min-w-64 flex-1">
            <label htmlFor="register-code" className="label">
              Scan a barcode or search
            </label>
            <input id="register-code" ref={code} autoComplete="off" className="input mono text-lg" placeholder="Scan, or type a number, words, a claim tag, or a receipt number" />
          </div>
          <button className="btn btn-primary">Add</button>
          <button type="button" className="btn" onClick={() => (camOn ? camStop() : camStart())}>
            {camOn ? <CameraOff size={14} aria-hidden /> : <Camera size={14} aria-hidden />} {camOn ? "Stop camera" : "Camera"}
          </button>
        </form>
        <InsecureNotice what="The camera" instead={CAMERA_INSTEAD} page={camPage} />
        <video ref={camVideo} className={camOn ? "w-full max-w-sm rounded border border-line" : "hidden"} muted playsInline aria-label="Camera" />

        {holiday && (
          <p className="card card-pad text-sm" role="status">
            <span className="pill tone-ready mr-2">Tax holiday today</span>
            {holiday.name} ({holidayDays(holiday)}): the items it covers{holiday.maxUnitCents != null ? `, ${money(holiday.maxUnitCents)} or less each,` : ""} carry no sales tax.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setMisc({ description: "", price: "", taxable: true })}>
            <Plus size={14} aria-hidden /> Other item (type a price)
          </button>
          <button type="button" className="btn btn-sm" aria-expanded={gcPanel != null} onClick={() => setGcPanel((p) => (p ? null : { mode: "new", number: "", amount: "" }))}>
            <Gift size={14} aria-hidden /> Gift card
          </button>
          {hasPartners && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                try {
                  setJobs(await pickupJobs());
                } catch {
                  toast.error("Couldn't load the repairs. Check the connection, then try again.");
                }
              }}
            >
              <Wrench size={14} aria-hidden /> Repair pickup
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={openBookings}>
            <CalendarDays size={14} aria-hidden /> Classes &amp; appointments
          </button>
          <ColorFinder customerId={customer?.id ?? null} customerName={customer?.name ?? null} returnMode={returnMode} onAdd={(it) => addItem(it)} />
          <RegisterGiftLists returnMode={returnMode} onAdd={addGiftListLine} />
          {threadPhoto && <ThreadPhotoMatch unavailable={threadPhoto.unavailable} returnMode={returnMode} onAdd={(it) => addItem(it)} />}
          {vac === "on" && <VacSupplyPicker customerId={customer?.id ?? null} returnMode={returnMode} onAdd={(it, m) => addItem(it, m)} />}
          {unitKinds && <UnitTools kinds={unitKinds} returnMode={returnMode} customerId={customer?.id ?? null} inCart={cart} onAdd={addLine} onNeedCustomer={() => setNewCustomer(true)} tradeNote={tradeNote} tradeInLessPct={tradeInLessPct} />}
          {specialOrders && !returnMode && (
            <SpecialOrderPanel
              customerId={customer?.id ?? null}
              customerName={customer?.name ?? null}
              defaults={specialOrders}
              item={preorderItem}
              canPrice={canSell}
              onNeedCustomer={() => setNewCustomer(true)}
              onClose={() => {
                setPreorderItem(null);
                setBringFrom(null);
              }}
              onDone={async (r, o) => {
                setPreorderItem(null);
                if (r) setDone({ id: r.saleId, number: r.number, change: 0, cards: [] });
                // Brought over from another store (7.3): that store is asked to send it, holding it for her.
                if (bringFrom) {
                  const from = bringFrom;
                  setBringFrom(null);
                  const b = await runAction(() => bringItHere(o.id, from.id));
                  if (b.error) toast.error(b.error);
                  else if (b.note) toast.success(b.note, { duration: 10000 });
                }
                toast.message(`Print the slip for special order ${o.number} from its page.`, { action: { label: "Open it", onClick: () => window.open(`/special-orders/${o.id}`, "_blank") } });
              }}
            />
          )}
          {layaway && !returnMode && (
            <LayawayPanel
              customerId={customer?.id ?? null}
              customerName={customer?.name ?? null}
              cart={lines}
              priceCents={t.subtotal - t.orderDiscount}
              totalCents={t.total}
              defaults={layaway}
              onNeedCustomer={() => setNewCustomer(true)}
              onDone={rungUp}
            />
          )}
          <button
            type="button"
            className={`btn btn-sm ${returnMode ? "btn-primary" : ""}`}
            aria-pressed={returnMode}
            onClick={() => {
              // Stopping returns lets go of the scanned receipt: its rate no longer applies.
              if (returnMode) setReturnOf(null);
              setReturnMode(!returnMode);
            }}
          >
            <Undo2 size={14} aria-hidden /> {returnMode ? "Stop returning" : "Return an item"}
          </button>
        </div>
        {missing && (
          <p className="card card-pad text-sm" role="alert">
            Nothing matches <span className="mono">{missing}</span>.{" "}
            <Link href={`/parts?new=${encodeURIComponent(missing)}#add`} className="link" target="_blank">
              Add it to inventory
            </Link>{" "}
            (a store barcode can be looked up online there), or ring it up with &quot;Other item&quot;.
            {unitKinds && unitKinds.length > 0 && (
              <>
                {" "}
                A machine for sale? Add it under{" "}
                <Link href="/units" className="link" target="_blank">
                  Machines for sale
                </Link>
                .
              </>
            )}
          </p>
        )}
        {gcPanel && (
          <form className="card card-pad flex flex-wrap items-end gap-2 text-sm" onSubmit={addGiftLine} aria-label="Gift card">
            <div className="field">
              <label htmlFor="gc-mode" className="label">
                Gift card
              </label>
              <select id="gc-mode" className="select" value={gcPanel.mode} onChange={(e) => setGcPanel({ ...gcPanel, mode: e.target.value as "new" | "printed" | "load" | "cashout" })}>
                <option value="new">Sell a new card</option>
                <option value="printed">Sell a pre-printed card (scan its number)</option>
                <option value="load">Add money to a card</option>
                {canSell && <option value="cashout">Pay out a balance in cash</option>}
              </select>
            </div>
            {gcPanel.mode !== "new" && (
              <div className="field">
                <label htmlFor="gc-number" className="label">
                  Card number
                </label>
                <input id="gc-number" className="input mono" autoComplete="off" value={gcPanel.number} onChange={(e) => setGcPanel({ ...gcPanel, number: e.target.value })} />
              </div>
            )}
            {gcPanel.mode !== "cashout" && (
              <div className="field">
                <label htmlFor="gc-amount" className="label">
                  Amount ({money(GIFT_MIN_CENTS)} to {money(GIFT_MAX_CENTS)})
                </label>
                <input id="gc-amount" inputMode="decimal" className="input num w-28" value={gcPanel.amount} onChange={(e) => setGcPanel({ ...gcPanel, amount: e.target.value })} />
              </div>
            )}
            <button className="btn btn-primary btn-sm">Add to sale</button>
            <button type="button" className="btn btn-sm" onClick={() => setGcPanel(null)}>
              Cancel
            </button>
            <p className="muted w-full text-xs">Selling a card isn&apos;t a sale of goods: no tax, no discount. It never expires and has no fees.</p>
          </form>
        )}
        {gcInfo && (
          <div className="card card-pad flex flex-wrap items-center gap-3 text-sm" role="status">
            <span>
              {gcInfo.kind === "credit" ? "Store credit" : "Gift card"} ending <span className="mono">{gcInfo.last4}</span>
              {gcInfo.customerName ? ` (${gcInfo.customerName})` : ""}: <span className="num font-bold">{money(gcInfo.balanceCents)}</span>
              {gcInfo.status !== "active" && " (void)"}
            </span>
            {gcInfo.status === "active" && lines.length > 0 && gcInfo.balanceCents > 0 && !refund && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => addTender(gcInfo.kind === "credit" ? "CREDIT" : "GIFT")}>
                Pay with it
              </button>
            )}
            {gcInfo.status === "active" && gcInfo.kind === "gift" && (
              <button type="button" className="btn btn-sm" onClick={() => setGcPanel({ mode: "load", number: gcInfo.number, amount: "" })}>
                Add money
              </button>
            )}
            <button type="button" className="link text-xs" onClick={() => setGcInfo(null)}>
              Dismiss
            </button>
          </div>
        )}
        {returnMode && (
          <p className="tone-wait rounded px-3 py-2 font-semibold">Returning: scan what comes back. It comes off the sale and goes back on the shelf.</p>
        )}
        {/* What fits her machines, and what goes with a machine being sold (shop-features-round-2-design.md 2.4). */}
        {!returnMode && <CustomerFits customerId={customer?.id ?? null} customerName={customer?.name ?? null} onAdd={(it) => addItem(it)} />}
        {!returnMode && (
          <CustomerExtrasLines
            extras={customer ? extras : null}
            customerId={customer?.id ?? null}
            birthdayOn={birthdayOn}
            onBirthday={(on) => setBirthdayFor(on && customer ? customer.id : null)}
            machineOnSale={cart.some((l) => l.stockUnitId && l.qty > 0 && !l.tradeUpTicketId)}
            onTradeUp={(ticketId) =>
              setCart((c) => {
                const i = c.findIndex((l) => l.stockUnitId && l.qty > 0 && !l.tradeUpTicketId);
                return i < 0 ? c : c.map((l, j) => (j === i ? { ...l, tradeUpTicketId: ticketId } : l));
              })
            }
            inCart={cart.flatMap((l) => [l.specialOrderId, l.kind === "MEMBERSHIP" && l.partId ? `member:${l.partId}` : null, l.tradeUpTicketId ? `tradeup:${l.tradeUpTicketId}` : null]).filter((x): x is string => !!x)}
            onAdd={addExtraLines}
          />
        )}
        {!returnMode && <GoesWith unitIds={cart.filter((l) => l.stockUnitId && l.qty > 0).map((l) => l.stockUnitId!)} onAdd={(it) => addItem(it)} />}
        {!returnMode && <StarterBundles unitIds={cart.filter((l) => l.stockUnitId && l.qty > 0).map((l) => l.stockUnitId!)} onAdd={(it) => addItem(it)} />}

        {elsewhereItem && (
          <div className="card card-pad space-y-3 text-base" role="region" aria-label="At another store" data-testid="elsewhere-panel">
            <h2 className="h2">
              <span className="mono">{elsewhereItem.partNumber}</span> {elsewhereItem.description}
            </h2>
            <p>
              None here. {elsewhereItem.elsewhere!.map((o) => `At ${o.name}: ${qtyText(o.qty, elsewhereItem.unit)}`).join(" · ")}.
            </p>
            {elsewhereItem.elsewhere!.map((o) => (
              <div key={o.id} className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  disabled={!specialOrders}
                  onClick={() => {
                    // A special order for her here (she pays now or leaves a deposit), and the other store sends it over.
                    setBringFrom({ id: o.id, name: o.name });
                    setPreorderItem(elsewhereItem);
                    setElsewhereItem(null);
                  }}
                >
                  Bring it here for her from {o.name}
                </button>
                <button
                  type="button"
                  className="btn min-h-11"
                  onClick={() => {
                    addItem(elsewhereItem);
                    setCart((c) => c.map((l, i) => (i === c.length - 1 && l.partId === elsewhereItem.id ? { ...l, shipFromId: o.id, shipFromName: o.name, onHand: o.qty } : l)));
                    setElsewhereItem(null);
                  }}
                >
                  Ship it to her from {o.name}
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-3 text-sm">
              <button
                type="button"
                className="link"
                onClick={() => {
                  addItem(elsewhereItem);
                  setElsewhereItem(null);
                }}
              >
                It&apos;s here after all: sell it
              </button>
              <button type="button" className="link" onClick={() => setElsewhereItem(null)}>
                Never mind
              </button>
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="card">
            <ul className="divide-y divide-line text-sm" aria-label="Search results">
              {results.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2"
                    onClick={() => {
                      // Coming soon and none on the shelf: a pre-order (the special order panel opens on it).
                      if (it.comingSoonOn && it.qtyOnHand <= 0 && specialOrders && !returnMode) setPreorderItem(it);
                      // None here, some at another store (7.3): bring it here for her, or ship it to her from there.
                      else if (store && !returnMode && !it.stockUnitId && it.qtyOnHand <= 0 && it.elsewhere?.length) setElsewhereItem(it);
                      else addItem(it);
                      setResults([]);
                      code.current?.focus();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {it.colorHex ? (
                        <span aria-hidden="true" className="h-10 w-10 shrink-0 rounded border border-line" style={{ backgroundColor: it.colorHex }} />
                      ) : (
                        it.photoId && (
                          // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
                          <img src={`/api/parts/photo/${it.photoId}`} alt="" className="h-10 w-10 shrink-0 rounded border border-line object-cover" loading="lazy" />
                        )
                      )}
                      <span className="min-w-0">
                      <span className="mono">{it.partNumber}</span> {it.description}
                      {it.disclosure && <span className="pill tone-wait ml-1">{it.disclosure}</span>}
                      {it.consigned && <span className="pill tone-neutral ml-1">consigned</span>}
                      {it.comingSoonOn && it.qtyOnHand <= 0 && <span className="pill tone-wait ml-1">Coming soon ({it.comingSoonText}): take a pre-order</span>}
                      {it.details && <span className="block text-sm">{it.details}</span>}
                      </span>
                    </span>
                    <span className="num">
                      {money(it.priceCents)}
                      {it.unit === "yd" ? "/yd" : ""} · {it.stockUnitId ? (it.elsewhere?.length ? `at ${it.elsewhere[0].name}` : "in stock") : `${qtyText(it.qtyOnHand, it.unit)} ${store ? "in this store" : "on hand"}`}
                      {store && !it.stockUnitId && it.elsewhere?.length ? <span className="muted block text-xs">{it.elsewhere.map((o) => `At ${o.name}: ${qtyText(o.qty, it.unit)}`).join(" · ")}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {misc && (
          <form
            className="card card-pad flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const price = toCents(misc.price);
              if (!misc.description.trim() || price == null) return toast.error("Give the item a description and a price.");
              setDone(null);
              setCart((c) => [
                ...c,
                { key: newKey(), description: misc.description.trim(), unit: null, qty: returnMode ? -1 : 1, unitPriceCents: price, discountPct: 0, taxable: misc.taxable },
              ]);
              setMisc(null);
              code.current?.focus();
            }}
          >
            <div className="field min-w-48 flex-1">
              <label htmlFor="misc-desc" className="label">
                Description
              </label>
              <input id="misc-desc" autoFocus className="input" value={misc.description} onChange={(e) => setMisc({ ...misc, description: e.target.value })} />
            </div>
            <div className="field w-28">
              <label htmlFor="misc-price" className="label">
                Price
              </label>
              <input id="misc-price" inputMode="decimal" className="input num" value={misc.price} onChange={(e) => setMisc({ ...misc, price: e.target.value })} />
            </div>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={misc.taxable} onChange={(e) => setMisc({ ...misc, taxable: e.target.checked })} /> Taxable
            </label>
            <button className="btn btn-primary btn-sm">Add to sale</button>
            <button type="button" className="btn btn-sm" onClick={() => setMisc(null)}>
              Cancel
            </button>
          </form>
        )}

        {jobs && (
          <div className="card card-pad space-y-2">
            <strong className="text-sm">Repairs ready to pay for</strong>
            {jobs.length === 0 ? (
              <p className="muted text-sm">No repairs are back and waiting for payment.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      Tag <strong>{j.tag}</strong> · {j.customerName} · {j.machine}
                      {j.paidCents > 0 && <span className="muted"> · paid {money(j.paidCents)} here before the repair shop added to the bill</span>}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={cart.some((l) => l.repairJobId === j.id)}
                      onClick={() => {
                        addPickupLine(j);
                        setJobs(null);
                      }}
                    >
                      Add {money(j.dueCents)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {bookings && (
          <div className="card card-pad space-y-3">
            <div className="space-y-2">
              <strong className="text-sm">{bookings.refunds ? "Paid here and refundable" : "Owed"}</strong>
              {bookings.due.length === 0 ? (
                <p className="muted text-sm">{bookings.refunds ? "Nothing paid here to refund." : customer ? `${customer.name} owes nothing for classes or appointments.` : "Nothing owed for classes or appointments."}</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {bookings.due.map((b) => (
                    <li key={`${b.kind}:${b.id}`} className="flex items-center justify-between gap-2 py-1.5">
                      <span>
                        {b.description} · {b.customerName}
                      </span>
                      <button type="button" className="btn btn-sm" disabled={cart.some((l) => (b.kind === "enrollment" ? l.enrollmentId : l.appointmentId) === b.id)} onClick={() => { addBooking(b, bookings.refunds); setBookings(null); }}>
                        {bookings.refunds ? `Refund ${money(b.dueCents)}` : `Add ${money(b.dueCents)}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!bookings.refunds && (
              <div className="space-y-2">
                <strong className="text-sm">Sign up for a class</strong>
                {bookings.seats.length === 0 ? (
                  <p className="muted text-sm">No open classes with seats.</p>
                ) : (
                  <ul className="divide-y divide-line text-sm">
                    {bookings.seats.map((c) => (
                      <li key={c.id} className="space-y-1 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            {c.title}
                            {c.firstAt ? ` · ${new Date(c.firstAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}` : ""} · {c.seatsLeft} seat{c.seatsLeft === 1 ? "" : "s"} left{c.feeCents ? ` · ${money(c.feeCents)}` : ""}
                          </span>
                          <button type="button" className="btn btn-sm" onClick={() => signUpHere(c.id, null)}>
                            Sign up{customer ? ` ${customer.name.split(" ")[0]}` : ""}
                          </button>
                        </div>
                        {signup?.classId === c.id && !customer && (
                          <form
                            className="space-y-2 rounded border border-line p-3"
                            aria-label={`Who is signing up for ${c.title}`}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void signUpHere(c.id, { name: signup.name, phone: signup.phone });
                            }}
                          >
                            <p className="font-semibold">Who is signing up? Type their name and phone.</p>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="field">
                                <label htmlFor={`signup-name-${c.id}`} className="label">
                                  Name
                                </label>
                                <input id={`signup-name-${c.id}`} className="input" autoFocus autoComplete="off" value={signup.name} onChange={(e) => setSignup({ ...signup, name: e.target.value })} required />
                              </div>
                              <div className="field">
                                <label htmlFor={`signup-phone-${c.id}`} className="label">
                                  Phone
                                </label>
                                <input id={`signup-phone-${c.id}`} type="tel" className="input" value={signup.phone} onChange={(e) => setSignup({ ...signup, phone: e.target.value })} required />
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button type="submit" className="btn btn-primary">
                                Sign up
                              </button>
                              <button type="button" className="btn" onClick={() => setSignup(null)}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        <div className="card overflow-x-auto">
          <table className="table w-full [&_td]:px-2 [&_th]:px-2" aria-label="Sale">
            <thead>
              <tr>
                <th>Item</th>
                <th className="w-24">Qty</th>
                <th className="w-24">Price</th>
                <th className="w-20">% off</th>
                <th className="w-24 text-right">Line total</th>
                <th className="w-12">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted py-6 text-center">
                    Scan an item to start a sale.
                  </td>
                </tr>
              )}
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    {l.partNumber && <span className="mono mr-1">{l.partNumber}</span>}
                    {l.description}
                    {l.disclosure && <span className="pill tone-wait ml-1">{l.disclosure}</span>}
                    {l.promo && <span className="pill tone-ready ml-1">{l.taxIncluded ? `${l.promo}: price includes tax` : l.promo}</span>}
                    {l.rule && (
                      <button type="button" className="pill tone-ready ml-1" title="Tap to take it off this line" aria-label={`${l.rule}: take it off this line`} onClick={() => setLine(l.key, l.tradeUpTicketId ? { tradeUpTicketId: undefined } : { noRule: true })}>
                        {l.rule} ×
                      </button>
                    )}
                    {l.consigned && <span className="pill tone-neutral ml-1">consigned</span>}
                    {l.listName && <span className="pill tone-ready ml-1">gift: {l.listName}</span>}
                    {l.shipFromName && <span className="pill tone-wait ml-1">ships from {l.shipFromName}</span>}
                    {mustDelist(l) && (
                      <label className="ml-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold">
                        <input type="checkbox" className="check" checked={l.delisted === true} onChange={(e) => setLine(l.key, { delisted: e.target.checked })} /> Take it down on {l.listedOn!.join(", ")} first: done
                      </label>
                    )}
                    {l.kind === "SOFTWARE" && l.partId && (
                      <SoftwareLineFields partId={l.partId} customerId={customer?.id ?? null} value={l.software ?? {}} returning={l.qty < 0} canOverride={canSell} onChange={(v) => setLine(l.key, { software: v })} />
                    )}
                    {l.repairJobId && !l.handedOver && (
                      <label className="ml-2 inline-flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={l.pickedUp !== false} onChange={(e) => setLine(l.key, { pickedUp: e.target.checked })} /> taking the machine home
                      </label>
                    )}
                    {l.holidayCovered && !l.taxAnyway ? (
                      <span className="ml-1 inline-flex items-center gap-1 text-xs">
                        <span className="pill tone-ready">Tax holiday</span>
                        <button type="button" className="link" onClick={() => setLine(l.key, { taxAnyway: true })}>
                          Charge tax anyway
                        </button>
                      </span>
                    ) : l.holidayCovered ? (
                      <span className="ml-1 inline-flex items-center gap-1 text-xs">
                        <span className="muted">tax charged</span>
                        <button type="button" className="link" onClick={() => setLine(l.key, { taxAnyway: false })}>
                          Undo
                        </button>
                      </span>
                    ) : (
                      !l.taxable && <span className="muted ml-1 text-xs">(no tax)</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Qty for ${l.description}`}
                      className="input num min-w-[4.5rem]"
                      step={l.unit === "yd" ? 0.125 : 1}
                      // A repair is paid as one line; a machine from stock, a trade-in or a plan is one; a class seat or appointment is one each.
                      disabled={Boolean(l.repairJobId || l.stockUnitId || l.tradeIn || l.servicePlan || l.enrollmentId || l.appointmentId || l.giftCard || l.specialOrderId)}
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: Number(e.target.value) })}
                      onKeyDown={backToScan}
                    />
                    {l.unit === "yd" &&
                      (inEighths(l.qty) ? <div className="muted text-xs">{qtyText(l.qty, "yd")}</div> : <div className="text-xs text-[var(--bad)]">Use 1/8 yd steps (a remnant sells whole)</div>)}
                    {l.partId && l.onHand != null && l.qty > l.onHand && (
                      <div className="text-xs text-[var(--bad)]">
                        Only {qtyText(Math.max(0, l.onHand), l.unit)} {l.consigned ? "left on the shelf" : "on hand"}
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      aria-label={`Price for ${l.description}`}
                      inputMode="decimal"
                      className="input num min-w-[4.5rem]"
                      // A tech can type the price of an item that has none, not change one that has. A booking is priced by
                      // the server; an owner or admin may lower a refund (a cancellation fee).
                      disabled={(!canSell && l.priced) || Boolean(l.repairJobId || l.specialOrderId) || l.giftCard?.mode === "cashout" || ((Boolean(l.enrollmentId) || Boolean(l.appointmentId)) && (l.qty > 0 || !canSell))}
                      defaultValue={(l.unitPriceCents / 100).toFixed(2)}
                      onBlur={(e) => {
                        const cents = toCents(e.target.value);
                        if (cents == null) {
                          toast.error("Type the price like 12.50.");
                          e.target.value = (l.unitPriceCents / 100).toFixed(2);
                        } else setLine(l.key, { unitPriceCents: cents });
                      }}
                      onKeyDown={backToScan}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`% off for ${l.description}`}
                      className="input num min-w-14"
                      min={0}
                      max={100}
                      disabled={!canSell || Boolean(l.repairJobId || l.enrollmentId || l.appointmentId || l.giftCard || l.depositUsed)}
                      value={l.discountPct || ""}
                      onChange={(e) => setLine(l.key, { discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                      onKeyDown={backToScan}
                    />
                  </td>
                  <td className="num text-right">{money(lineNet(l))}</td>
                  <td>
                    <button type="button" className="btn btn-sm" aria-label={`Remove ${l.description}`} onClick={() => setCart((c) => c.filter((x) => x.key !== l.key && !(l.specialOrderId && x.specialOrderId === l.specialOrderId)))}>
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <aside className="space-y-3">
        {done && (
          // Stays until the next item goes on (or New sale): the change due is the one number the cashier needs.
          <div ref={donePanel} className="card card-pad space-y-3 border-2" style={{ borderColor: "var(--ok)" }} role="status">
            <p className="text-lg">
              Sale #{done.number} done.
              {done.change ? (
                <>
                  {" "}Change due{" "}
                  <span className="num block text-4xl font-bold text-[var(--ok)]" data-testid="change-due">
                    {money(done.change)}
                  </span>
                </>
              ) : (
                " No change due."
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/register/sales/${done.id}`} className="btn btn-primary btn-lg flex-1">
                Print receipt
              </Link>
              <button
                type="button"
                className="btn btn-lg flex-1"
                onClick={() => {
                  setDone(null);
                  code.current?.focus();
                }}
              >
                New sale
              </button>
            </div>
            {done.cards
              .filter((c) => c.what !== "paid-out")
              .map((c) => (
                <p key={c.cardId + c.what}>
                  <Link href={`/register/gift-cards/${c.cardId}/print`} className="link">
                    Print {c.kind === "credit" ? "store credit slip" : c.what === "loaded" ? "the loaded card" : "the gift card"} ({money(c.amountCents)})
                  </Link>
                </p>
              ))}
          </div>
        )}
        <div className="card card-pad space-y-2">
          <div className="field">
            <label htmlFor="register-customer" className="label">
              Customer (optional)
            </label>
            {exemptCert && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={chargeTax} onChange={(e) => setChargeTax(e.target.checked)} />
                <span>
                  Tax exempt, certificate <strong>{exemptCert}</strong>. Charge tax anyway
                </span>
              </label>
            )}
            {customer ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {customer.name} {customer.phone && <span className="muted">{customer.phone}</span>}
                </span>
                <button type="button" className="link text-xs" onClick={() => { setCustomer(null); setChargeTax(false); }}>
                  change
                </button>
              </div>
            ) : (
              <div className="flex items-end gap-2">
                <input
                  id="register-customer"
                  className="input min-w-0 flex-1"
                  placeholder="Name or phone"
                  autoComplete="off"
                  value={custQ}
                  onChange={async (e) => {
                    const v = e.target.value;
                    setCustQ(v);
                    const hits = await findCustomers(v);
                    setCustHits(hits);
                    setCustSearched(v.trim().length >= 2 ? v.trim() : "");
                  }}
                />
                <button type="button" className="btn btn-sm whitespace-nowrap" aria-expanded={Boolean(newCustomer)} onClick={() => setNewCustomer(!newCustomer)}>
                  <Plus size={14} aria-hidden /> New customer
                </button>
              </div>
            )}
            {!customer && !newCustomer && custSearched && custSearched === custQ.trim() && custHits.length === 0 && (
              <p className="text-sm">
                No customer matches &lsquo;{custSearched}&rsquo;.{" "}
                <button type="button" className="link" onClick={() => setNewCustomerForm({ ...EMPTY_CUSTOMER, ...nameOrPhone(custSearched) })}>
                  Add &lsquo;{custSearched}&rsquo; as a new customer
                </button>
              </p>
            )}
            {!customer && newCustomer && (
              <form className="space-y-2 rounded border border-line p-2" onSubmit={submitNewCustomer} aria-label="New customer">
                <div className="field">
                  <label htmlFor="new-customer-name" className="label">
                    Name
                  </label>
                  <input id="new-customer-name" autoFocus className="input" value={newCustomer.name} onChange={(e) => setNewCustomerForm({ ...newCustomer, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-phone" className="label">
                    Phone
                  </label>
                  <input id="new-customer-phone" type="tel" className="input" value={newCustomer.phone} onChange={(e) => setNewCustomerForm({ ...newCustomer, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-email" className="label">
                    Email
                  </label>
                  <input id="new-customer-email" type="email" className="input" value={newCustomer.email} onChange={(e) => setNewCustomerForm({ ...newCustomer, email: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="new-customer-address" className="label">
                    Address
                  </label>
                  <input id="new-customer-address" className="input" value={newCustomer.address} onChange={(e) => setNewCustomerForm({ ...newCustomer, address: e.target.value })} />
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-primary btn-sm" disabled={addingCustomer}>
                    {addingCustomer ? "Adding..." : "Add customer"}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setNewCustomerForm(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {!customer && custHits.length > 0 && (
              <ul className="divide-y divide-line rounded border border-line text-sm">
                {custHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1 text-left hover:bg-surface-2"
                      onClick={() => {
                        setCustomer(c);
                        setCustHits([]);
                        setCustQ("");
                      }}
                    >
                      {c.name} <span className="muted">{c.phone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {sellers.length > 1 && (
          <div className="card card-pad">
            <div className="field">
              <label htmlFor="register-sold-by" className="label">
                Sold by
              </label>
              <select id="register-sold-by" className="select" value={soldBy} onChange={(e) => setSoldBy(e.target.value)}>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="card card-pad space-y-1">
          <Row k="Subtotal" v={money(t.subtotal)} />
          <div className="flex items-center justify-between gap-2">
            <span>Take money off the sale</span>
            <span className="flex items-center gap-1">
              <input
                aria-label="Money off the whole sale"
                inputMode="decimal"
                className="input num w-20"
                disabled={!canSell}
                value={orderDisc.value}
                onChange={(e) => setOrderDisc({ ...orderDisc, value: e.target.value })}
              />
              <select
                aria-label="Percent or dollars off"
                className="select w-16"
                disabled={!canSell}
                value={orderDisc.kind}
                onChange={(e) => setOrderDisc({ ...orderDisc, kind: e.target.value as "%" | "$" })}
              >
                <option>%</option>
                <option>$</option>
              </select>
            </span>
          </div>
          {t.orderDiscount > 0 && <Row k="" v={`-${money(t.orderDiscount)}`} />}
          <Row k={receiptRate != null ? `Tax as sold (${receiptRate}%)` : exemptOn ? `Tax exempt (certificate ${exemptCert})` : `Tax (${taxRatePct}%)`} v={money(t.tax)} />
          <div className="flex justify-between border-t border-line pt-1 text-2xl font-bold">
            <span>{t.total < 0 ? "Refund" : "Total"}</span>
            <span className="num" data-testid="sale-total">
              {money(Math.abs(t.total))}
            </span>
          </div>
        </div>

        <section className="card card-pad space-y-3" aria-label="Payment">
          <h2 className="text-lg font-semibold">{refund ? "Pay the refund" : "Payment"}</h2>
          {/* The everyday ways to pay, big. Press one, then type what was handed over (or type first, then press). */}
          <div className="grid grid-cols-3 gap-2">
            {BIG_METHODS.map((m) => (
              <button key={m} type="button" className="btn btn-lg" disabled={!lines.length} onClick={() => addTender(m)}>
                {TENDER_LABEL[m]}
              </button>
            ))}
            {cardReader && !refund && (
              <RegisterCardReader
                setup={cardReader}
                amountCents={(editing ? null : toCents(tenderAmt)) ?? t.due}
                disabled={!lines.length}
                onApproved={readerApproved}
              />
            )}
            {houseAccounts && customer && (
              <button type="button" className="btn btn-sm" disabled={!lines.length} onClick={() => addTender("ACCOUNT")}>
                {TENDER_LABEL.ACCOUNT}
              </button>
            )}
            {lenders.length > 0 && (
              <button type="button" className={`btn btn-sm ${fin ? "btn-primary" : ""}`} disabled={!lines.length} aria-expanded={!!fin} onClick={() => setFin(fin ? null : { lenderId: lenders.length === 1 ? lenders[0].id : "", approval: "" })}>
                {TENDER_LABEL.FINANCED}
              </button>
            )}
          </div>
          {fin && (
            <div className="flex flex-wrap items-end gap-2 rounded border border-line p-2" aria-label="Financing">
              <div className="field">
                <label htmlFor="fin-lender" className="label">
                  Lender
                </label>
                <select id="fin-lender" className="select" value={fin.lenderId} onChange={(e) => setFin({ ...fin, lenderId: e.target.value })}>
                  <option value="">-</option>
                  {lenders.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="fin-approval" className="label">
                  Approval number
                </label>
                <input id="fin-approval" className="input mono" autoComplete="off" value={fin.approval} onChange={(e) => setFin({ ...fin, approval: e.target.value })} />
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={addFinanced}>
                Add {money(Math.abs((editing ? null : toCents(tenderAmt)) ?? (refund ? refundLeft : t.due)))}
              </button>
            </div>
          )}
          <div className="field">
            <label htmlFor="tender-amount" className="label">
              {editingTender
                ? editingTender.method === "CASH"
                  ? refund
                    ? "Cash handed back"
                    : "Cash handed over"
                  : `${TENDER_LABEL[editingTender.method]} amount`
                : refund
                  ? `Refund amount (leave blank for ${money(Math.max(0, refundLeft))})`
                  : `Payment amount (leave blank for the full ${money(t.due)})`}
            </label>
            <input id="tender-amount" ref={tenderBox} inputMode="decimal" autoComplete="off" className="input num text-lg" value={tenderAmt} onChange={(e) => typeTenderAmount(e.target.value)} />
          </div>
          {t.change > 0 && !problem && (
            <div className="flex items-baseline justify-between text-2xl font-bold text-[var(--ok)]" data-testid="change-now">
              <span>Change due</span>
              <span className="num text-3xl">{money(t.change)}</span>
            </div>
          )}
          {tenders.length > 0 && (
            <ul>
              {tenders.map((x, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span>
                    {TENDER_LABEL[x.method]}
                    {x.lender ? ` (${x.lender})` : ""}
                    {x.last4 ? ` ending ${x.last4}` : ""}{" "}
                    <button
                      type="button"
                      className="link text-sm"
                      onClick={() => {
                        setTenders((ts) => ts.filter((_, j) => j !== i));
                        if (editing) {
                          setEditing(null);
                          setTenderAmt("");
                        }
                      }}
                    >
                      remove
                    </button>
                  </span>
                  <span className="num">{money(x.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {t.total >= 0 && t.due > 0 && tenders.length > 0 && <Row k="Still due" v={money(t.due)} />}
          {problem && tenders.length > 0 && (refund || t.due === 0) && (
            <p className="text-[var(--bad)]" role="alert">
              {problem}
            </p>
          )}
          {lines.some((l) => l.shipFromId) && (
            <div className="field">
              <label htmlFor="ship-to" className="label">
                Ship to (her address)
              </label>
              <textarea id="ship-to" rows={2} className="textarea" value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="12 Main St, Naples FL 34102" />
              <p className="muted text-sm">{[...new Set(lines.filter((l) => l.shipFromId).map((l) => l.shipFromName))].join(" and ")} gets a Ship this job with the tracking number to fill in.</p>
            </div>
          )}
          {approvalAsk && (
            <RegisterApproval
              need={approvalAsk.need}
              draft={approvalAsk.draft}
              onCancel={() => setApprovalAsk(null)}
              onApproved={(id) => {
                approvalId.current = id;
                setApprovalAsk(null);
                finish();
              }}
            />
          )}
          <button type="button" className="btn btn-primary btn-lg w-full" disabled={busy || !lines.length || Boolean(problem) || lines.some((l) => mustDelist(l) && !l.delisted)} onClick={() => finish()}>
            {busy ? "Saving..." : t.total < 0 ? "Complete refund" : "Complete sale"}
          </button>
          <div className="space-y-2 border-t border-line pt-3">
            <p className="label">Gift card, store credit or other</p>
            <div className="flex flex-wrap gap-2">
              {SMALL_METHODS.map((m) => (
                <button key={m} type="button" className="btn btn-sm" disabled={!lines.length} onClick={() => addTender(m)}>
                  {TENDER_LABEL[m]}
                </button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="tender-card" className="label">
                Gift card or store credit number (scan it; leave blank to use the customer&apos;s store credit)
              </label>
              <input id="tender-card" className="input mono" autoComplete="off" value={tenderCard} onChange={(e) => setTenderCard(e.target.value)} />
            </div>
          </div>
          <p className="muted text-sm">Cards run on your own card reader; record them here as Card.</p>
        </section>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
