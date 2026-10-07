// What a message is (scheduling-messaging-design.md section 3.1). Pure.
import type { SKIP_REASON_LABEL } from "@/lib/constants";

export type Channel = "email" | "sms";
export type Purpose = "notice" | "marketing";
export type MessageKind =
  | "ready"
  | "reminder"
  | "estimate"
  | "abandon"
  | "service_due"
  | "review"
  | "campaign"
  | "class_notice"
  | "booking_notice"
  | "consent_confirm"
  | "help_reply"
  | "bags_due"
  | "parts_in"
  | "order_in"
  | "order_notice"
  | "pay_link"
  | "owner_notice"
  | "software_renew"
  | "supplies_due"
  | "test";

export const MESSAGE_KINDS: MessageKind[] = ["ready", "reminder", "estimate", "abandon", "service_due", "review", "campaign", "class_notice", "booking_notice", "consent_confirm", "help_reply", "bags_due", "parts_in", "order_in", "order_notice", "pay_link", "owner_notice", "software_renew", "supplies_due", "test"];

/** Notices are about something the customer started or owns; marketing encourages buying (TCPA / CAN-SPAM rules apply). */
export const KIND_PURPOSE: Record<MessageKind, Purpose> = {
  ready: "notice",
  reminder: "notice",
  estimate: "notice",
  abandon: "notice",
  class_notice: "notice",
  booking_notice: "notice",
  consent_confirm: "notice",
  help_reply: "notice",
  parts_in: "notice",
  order_in: "notice",
  order_notice: "notice",
  // A pay link a staff member sends (shop-features-round-2-design.md 1.3): transactional, in the base.
  pay_link: "notice",
  // To the owner herself (more than one store, 7.5): an approval asked for, the daily summary.
  owner_notice: "notice",
  test: "notice",
  service_due: "marketing",
  review: "marketing",
  campaign: "marketing",
  bags_due: "marketing",
  // A friendly reminder that a software subscription renews (shop-features-round-2-design.md 2.5): it asks for a sale.
  software_renew: "marketing",
  // "Running low on filament?" sent by hand from Maker Shop's Supplies due list (6.3).
  supplies_due: "marketing",
};

/**
 * Kinds that go out without the Marketing module (pricing-review-2026-10.md, decided 7 Oct 2026: a repair tool's own
 * notices are in the base): ready for pickup, parts in, the estimate, a pay link staff send and "it's here" for a
 * special order or want list (both transactional, moved into the base on 7 Oct 2026 too), and what texting itself needs
 * (the sign-up confirmation, the HELP reply, a settings test). Every other kind needs Marketing (or Scheduling's own gate).
 */
export const BASE_KINDS: MessageKind[] = ["ready", "parts_in", "estimate", "pay_link", "order_in", "owner_notice", "consent_confirm", "help_reply", "test"];

/** The template kinds of BASE_KINDS (the estimate has a wording for installs without a public address too). */
export const BASE_TEMPLATE_KINDS: string[] = [...BASE_KINDS, "estimate_nolink"];

/** Texts of these kinds end with " Reply STOP to opt out." (marketing always; these notices are typed by staff). */
export const STOP_LINE_KINDS: MessageKind[] = ["class_notice", "booking_notice"];

/** Sent to an explicit address: only suppression is checked (queue and worker), even when customerId is set for the record. */
export const EXPLICIT_KINDS: MessageKind[] = ["consent_confirm", "help_reply", "owner_notice", "test"];

/** preferred: by notifyBy; every: every channel allowed() passes; one: text if allowed and preferred, else email; or a fixed list. */
export type ChannelMode = "preferred" | "every" | "one" | Channel[];

export type SkipReason = keyof typeof SKIP_REASON_LABEL;

export const isMessageKind = (s: unknown): s is MessageKind => typeof s === "string" && (MESSAGE_KINDS as string[]).includes(s);
export const isChannel = (s: unknown): s is Channel => s === "email" || s === "sms";
