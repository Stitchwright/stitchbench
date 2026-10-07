// The Assistant's features (ai-assistant-scope.md section 1) and what each is called. Pure.

/** The hub's model classes (it maps each to a model id: docs/plans/ai-assistant-scope.md 2.2). The program never names a model. */
export type ModelClass = "draft" | "suggest" | "read" | "manuals";

export const FEATURES = {
  draft_work_done: { label: "Draft: work done", cls: "draft", group: "draft" },
  draft_diagnosis: { label: "Draft: what we found", cls: "draft", group: "draft" },
  draft_partner_note: { label: "Draft: note to the sewing shop", cls: "draft", group: "draft" },
  draft_estimate: { label: "Draft: estimate message", cls: "draft", group: "draft" },
  draft_ready: { label: "Draft: ready message", cls: "draft", group: "draft" },
  likely_causes: { label: "What's likely wrong", cls: "suggest", group: "causes" },
  read_plate: { label: "Read the plate", cls: "read", group: "plate" },
  ask_manuals: { label: "Ask the manuals", cls: "manuals", group: "manuals" },
  looks_like: { label: "Looks like (parts)", cls: "read", group: "parts" },
  parts_for_job: { label: "Parts this job usually needs", cls: "suggest", group: "parts" },
  match_columns: { label: "Match the columns (inventory import)", cls: "read", group: "parts" },
  read_label: { label: "Read the bolt label", cls: "read", group: "fabric" },
  tag_fabric: { label: "Color and theme tags", cls: "read", group: "fabric" },
  read_invoice: { label: "Read the packing slip or invoice", cls: "read", group: "stock" },
} as const satisfies Record<string, { label: string; cls: ModelClass; group: FeatureGroup }>;

export type FeatureId = keyof typeof FEATURES;
export type FeatureGroup = "draft" | "causes" | "plate" | "manuals" | "parts" | "fabric" | "stock";
export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];
export const isFeature = (s: unknown): s is FeatureId => typeof s === "string" && Object.hasOwn(FEATURES, s);

/** What "Draft it" can write: the invoice's Work done and What we found, a partner repair's note, and the two customer messages. */
export const DRAFT_KINDS = ["work_done", "diagnosis", "partner_note", "estimate", "ready"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** One switch per group in Settings → Assistant (design 2.4). */
export const GROUP_LABEL: Record<FeatureGroup, { label: string; blurb: string }> = {
  draft: { label: "Draft it", blurb: "Turns a tech's shorthand into the invoice wording, a note to the sewing shop, or an estimate or ready message." },
  causes: { label: "What's likely wrong", blurb: "On a ticket: likely causes and the checks to make, from this shop's past tickets, gotcha notes, community notes and the specs." },
  plate: { label: "Read the plate", blurb: "At check-in: a photo of the rating plate fills in make, model and serial." },
  parts: { label: "Parts helpers", blurb: "\"Looks like\" suggestions on a part, \"Parts this job usually needs\" on a ticket, and \"Match the columns\" on the inventory import. Part numbers, descriptions and column headings only; never a customer." },
  fabric: { label: "Fabric helpers", blurb: "A photo of a bolt label fills in a new fabric (number, color, maker, width, content), and a fabric's swatch picture gets color and theme tags. Only the picture is sent; never a customer." },
  stock: { label: "Stock helpers", blurb: "A photo of a packing slip or invoice fills in receiving: the lines are matched to the order and your items by item number, and changed costs are shown. Only the picture is sent; never a customer." },
  manuals: { label: "Ask the manuals", blurb: "On a model page or ticket: answers a question from the text of your own indexed manuals, citing the pages. Only the few matching pages go to the model." },
};

/** Calls the shop's own plan allows each month before the hub says so (the hub's count is the authority). */
export const DEFAULT_MONTHLY_CALLS = 300;
export const FREE_PLATE_READS = 20;

export const OFFLINE_MESSAGE = "The Assistant needs the internet.";
