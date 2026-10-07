// Which off-site data backups are kept (later-round-1-design.md 1.4): 14 dailies, 8 Sundays, 12 firsts of the month. Pure.

export const KEEP_DAILY = 14;
export const KEEP_SUNDAYS = 8;
export const KEEP_MONTHS = 12;
/** Days a photo object stays after its row left the database. */
export const PHOTO_GRACE_DAYS = 400;

export type Dated = { name: string; at: Date };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The names to keep from a company's data backups (each with the time it was made): the newest backup of each of the last
 * 14 days that have one, of each of the last 8 Sundays and of each of the last 12 firsts of a month that have one. The
 * newest backup is always kept, so a good run can never leave the company with none.
 */
export function keepNames(backups: Dated[]): Set<string> {
  const newestFirst = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name));
  const keep = new Set<string>();
  if (newestFirst.length) keep.add(newestFirst[0].name);
  const take = (match: (d: Date) => boolean, key: (d: Date) => string, limit: number) => {
    const seen = new Set<string>();
    for (const b of newestFirst) {
      if (!match(b.at)) continue;
      const k = key(b.at);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.name);
    }
  };
  take(() => true, dayKey, KEEP_DAILY);
  take((d) => d.getUTCDay() === 0, dayKey, KEEP_SUNDAYS);
  take((d) => d.getUTCDate() === 1, (d) => d.toISOString().slice(0, 7), KEEP_MONTHS);
  return keep;
}
