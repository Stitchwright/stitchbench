// The stages of an uncollected-machine notice (scheduling-messaging-design.md section 9.1). Pure: no database, no clock.
import { addDays, dayStart, ymdOf, zonedTime } from "@/lib/zoned";

export type AbandonStage = { key: "first" | "second" | "third" | "fourth" | "final"; day: number; due: Date; final: boolean };

const KEYS = ["first", "second", "third", "fourth"] as const;
const DAY = 86_400_000;
/** A stage still goes out automatically for this long after it fell due; later than that, a person decides. */
export const STAGE_WINDOW_DAYS = 7;

/**
 * The stages counted from the day the machine was ready (shop time): regular stage i is `days[i]` days after, the final
 * notice `finalNoticeDays` before the abandon date (dropped when that day isn't after the start); regular stages on or
 * after the final day are dropped. Each falls due at `hour` o'clock in the shop's zone.
 */
export function abandonStages(start: Date, days: number[], abandonedAfterDays: number, finalNoticeDays: number, hour: number, tz: string): AbandonStage[] {
  const startDay = ymdOf(start, tz);
  const finalDay = abandonedAfterDays - finalNoticeDays;
  const hasFinal = finalDay > 0;
  const out: AbandonStage[] = [];
  days.slice(0, KEYS.length).forEach((d, i) => {
    if (!Number.isInteger(d) || d < 1) return;
    if (hasFinal && d >= finalDay) return;
    out.push({ key: KEYS[i], day: d, due: zonedTime(addDays(startDay, d), hour * 60, tz), final: false });
  });
  if (hasFinal) out.push({ key: "final", day: finalDay, due: zonedTime(addDays(startDay, finalDay), hour * 60, tz), final: true });
  return out.sort((a, b) => a.day - b.day);
}

/** The start of the abandon day (shop time): `abandonedAfterDays` days after the day it was ready. */
export function abandonDate(start: Date, abandonedAfterDays: number, tz: string): Date {
  return dayStart(addDays(ymdOf(start, tz), abandonedAfterDays), tz);
}

/** What ties a message to a stage (OutMessage.refId): a new ready date makes a new key. */
export function stageKey(start: Date, s: AbandonStage): string {
  return `${start.getTime()}:${s.key}`;
}

/** The start time and stage name inside a stage key, or null for anything else. */
export function parseStageKey(k: string | null | undefined): { start: number; key: AbandonStage["key"] } | null {
  const m = /^(\d{1,16}):(first|second|third|fourth|final)$/.exec(k ?? "");
  return m ? { start: Number(m[1]), key: m[2] as AbandonStage["key"] } : null;
}

/**
 * The latest stage that has fallen due, and only while it is still in time: less than 7 days after its due date and
 * before the abandon date. Otherwise null: too late to send automatically (a "final notice ... by a date already past"
 * never goes out).
 */
export function sendable(stages: AbandonStage[], now: Date, abandonAt: Date): AbandonStage | null {
  let latest: AbandonStage | null = null;
  for (const s of stages) if (s.due.getTime() <= now.getTime() && (!latest || s.due.getTime() > latest.due.getTime())) latest = s;
  if (!latest) return null;
  const until = Math.min(latest.due.getTime() + STAGE_WINDOW_DAYS * DAY, abandonAt.getTime());
  return now.getTime() < until ? latest : null;
}

/** The stage a by-hand "send the current notice" means: the latest one fallen due, else the first coming. */
export function currentStage(stages: AbandonStage[], now: Date): AbandonStage | null {
  let latest: AbandonStage | null = null;
  for (const s of stages) if (s.due.getTime() <= now.getTime()) latest = s;
  return latest ?? stages[0] ?? null;
}
