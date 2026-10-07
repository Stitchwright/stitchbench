import Link from "next/link";

/** "History" for one record, from the audit log (owners and admins only: the page itself refuses a tech). */
export function HistoryLink({ role, type, id }: { role: string; type: string; id: string }) {
  if (role === "TECH") return null;
  return (
    <Link href={`/settings/audit?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`} className="link link-target no-print text-sm">
      History
    </Link>
  );
}
