import "server-only";
// Ask your shop (shop-features-round-2-design.md 5.1): the body the Reports page's Ask box calls. Two calls through the
// hub, both logged as ask_shop and counted: the model picks one of the program's reports and its settings, the program
// runs it, and the model words the answer from those numbers. Owners and admins only (Reports is theirs). A question no
// report covers costs the one call and gets the list of what it can answer.
import { db } from "@/lib/db";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError, isUserError } from "@/lib/user-error";
import { askContext, runReport, type ReportResult } from "@/lib/reports/registry";
import { REPORT_DEFS } from "@/lib/reports/registry-defs";
import { runAssistant } from "./client";
import { buildAskChoose, buildAskWord, cleanAnswer, parseAskChoice } from "./ask-prompt";
import { namesToBlank } from "./redact";

export type AskResult = {
  answer: string;
  report: ReportResult | null;
  /** What it can answer, when no report covered the question. */
  cant: { label: string; example: string }[] | null;
  callIds: string[];
};

export const CANT_ANSWER = "I can't answer that from your reports yet.";

export async function askShop(user: Pick<CurrentUser, "id" | "shopId" | "role">, question: string): Promise<AskResult> {
  await requireOn(user as CurrentUser, "assistant");
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can ask about the reports.");
  const q = String(question ?? "").trim().replace(/\s+/g, " ");
  if (q.length < 3) throw new UserError("Type a question first, like \"Which fabric sold best this month?\"");
  if (q.length > 300) throw new UserError("Keep the question to a sentence or two (300 characters).");
  const [{ today, collections, stores }, everyone] = await Promise.all([askContext(user.shopId), db.customer.findMany({ where: { shopId: user.shopId }, select: { name: true }, take: 5000 })]);
  const redaction = { names: namesToBlank({ allCustomers: everyone.map((c) => c.name) }) };

  const first = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildAskChoose(q, today, collections, redaction, stores) });
  const choice = parseAskChoice(first.text, today, collections, stores);
  if (!choice || choice.report === "none") {
    return { answer: CANT_ANSWER, report: null, cant: REPORT_DEFS.map((d) => ({ label: d.label, example: d.example })), callIds: [first.row.id] };
  }
  const report = await runReport(user.shopId, choice.report, choice.params);
  try {
    const second = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildAskWord(q, report, redaction) });
    return { answer: cleanAnswer(second.text) || "Here is what the report shows.", report, cant: null, callIds: [first.row.id, second.row.id] };
  } catch (e) {
    // The numbers are the program's: they still show when the wording call fails.
    if (!isUserError(e)) throw e;
    return { answer: `Here is the report. (${e.message})`, report, cant: null, callIds: [first.row.id] };
  }
}
