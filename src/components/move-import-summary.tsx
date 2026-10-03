// A company import's progress line and, at the end, its summary (company-move-design.md section 4: what came in, what
// was left out, what to enter again, which modules need a key). Shown by the Windows program's /move-in page and the
// hosted Companies page's import card. Plain markup: safe on the server and in the browser.
import type { ImportSummary } from "@/lib/move/import";

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export function MoveImportProgress({ p }: { p: { status: string; table: string | null; rowsDone: number; rowsTotal: number; bytesRead: number; bytesTotal: number } }) {
  if (p.status === "checking") {
    return <p className="text-sm">Checking the file{p.bytesTotal ? `: ${mb(p.bytesRead)} of ${mb(p.bytesTotal)} MB` : "..."} Nothing is written until every line has been checked.</p>;
  }
  if (p.status === "importing") {
    return (
      <p className="text-sm">
        Importing{p.table ? ` ${p.table}` : ""}: {p.rowsDone.toLocaleString()} of {p.rowsTotal.toLocaleString()} rows. All of it goes in at once at the end, or none of it.
      </p>
    );
  }
  return null;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export function MoveImportSummary({ summary }: { summary: ImportSummary }) {
  const tables = Object.entries(summary.tables).filter(([, n]) => n > 0);
  return (
    <div className="space-y-3 text-sm">
      <p>
        <strong>{summary.shopName}</strong> is on this install now: {summary.rows.toLocaleString()} rows, every id as it was ({summary.from}).
        {summary.owners.length > 0 && <> Sign in as {summary.owners.join(" or ")}, with the same password as before.</>}
      </p>
      <List title="Enter again" items={summary.reenter} />
      <List title="What changed" items={summary.notes} />
      <List title="From the old install" items={summary.warnings} />
      <details>
        <summary className="cursor-pointer">Rows per table</summary>
        <table className="table mt-2 text-xs">
          <tbody>
            {tables.map(([t, n]) => (
              <tr key={t}>
                <td>{t}</td>
                <td className="num text-right">{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
