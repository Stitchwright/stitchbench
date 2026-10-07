import "server-only";
// The generic email connector (package F6): the purchase order as a formatted email body with the same order attached as
// a CSV, sent through the shop's own mail account (Settings -> Messages, the account its campaigns use) when it has one
// and the supplier has an order email; otherwise the order page offers a mailto link and the spreadsheet to attach.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { isSendError } from "@/lib/messaging/errors";
import { sendConfig } from "@/lib/messaging/settings";
import { openSmtp } from "@/lib/messaging/smtp";
import { textToHtml } from "@/lib/messaging/templates";
import { csvText, fileNameFor, orderEmailParts, orderRows } from "./layout";
import type { WholesalerConnector } from "./types";

export const emailConnector: WholesalerConnector = {
  id: "email",
  label: "Email the order",
  channel: "email",
  blurb: "Sends the order as an email with a spreadsheet attached, from your own mail account when Settings has one; otherwise opens your mail program.",
  exportOrder: (ctx, order) => ({ filename: fileNameFor(order), rows: orderRows(order, ctx.supplier.orderLayout, ctx.supplier.accountNumber) }),
  async placeOrder(ctx, order) {
    const to = ctx.supplier.orderEmail;
    const cfg = await sendConfig(ctx.shopId);
    if (!to) return { via: "mailto", note: `Order #${order.number} is marked sent. ${ctx.supplier.name} has no order email saved, so use "Email it" below (it opens your mail program) or print the order.` };
    if (!cfg.view.emailReady) return { via: "mailto", note: `Order #${order.number} is marked sent. Email isn't set up in Settings -> Messages, so use "Email it" below (it opens your mail program) and attach the spreadsheet.` };
    const shop = await db.shop.findUniqueOrThrow({ where: { id: ctx.shopId }, select: { phone: true, address: true } });
    const { subject, text } = orderEmailParts(order, ctx.supplier.accountNumber, shop);
    const file = emailConnector.exportOrder!(ctx, order);
    let session;
    try {
      session = await openSmtp(cfg);
      await session.send({
        to,
        toName: ctx.supplier.name,
        subject,
        text,
        html: textToHtml(text),
        headers: {},
        attachments: [{ filename: file.filename, content: csvText(file.rows, true), contentType: "text/csv; charset=utf-8" }],
      });
    } catch (e) {
      if (isSendError(e)) throw new UserError(`The order wasn't sent: ${e.message} It is still a draft; fix the mail settings and send again, or use "Mark sent by hand".`);
      throw e;
    } finally {
      session?.close();
    }
    return { via: "smtp", note: `Order #${order.number} was emailed to ${to} from your mail account, with the spreadsheet attached. Its yards now count as on order.` };
  },
};
