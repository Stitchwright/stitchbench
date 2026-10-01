import Link from "next/link";
import type { TicketStatus } from "@/generated/prisma/enums";
import { JOB_STATUS_LABEL, ORDER_STATUS_LABEL, SITE_STATUS_LABEL, STATUS_LABEL, STATUS_TONE } from "@/lib/constants";

export function PageHeader({
  title,
  sub,
  actions,
  back,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="link no-print text-sm">
            &larr; {back.label}
          </Link>
        )}
        <h1 className="h1">{title}</h1>
        {sub && <div className="muted mt-1 text-sm">{sub}</div>}
      </div>
      {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A ticket's status; `site` uses the central vac install names (Booked, In progress, Completed). */
export function StatusPill({ status, site = false }: { status: TicketStatus; site?: boolean }) {
  return <span className={`pill tone-${STATUS_TONE[status]}`}>{site ? SITE_STATUS_LABEL[status] : STATUS_LABEL[status]}</span>;
}

/** A partner repair job's status, in the sewing shop's words or the repair shop's. */
export function JobStatusPill({ status, side }: { status: string; side: string }) {
  const s = status as TicketStatus;
  const label = (side === "retail" ? JOB_STATUS_LABEL[s] : STATUS_LABEL[s]) ?? status;
  return <span className={`pill tone-${STATUS_TONE[s] ?? "neutral"}`}>{label}</span>;
}

const ORDER_TONE: Record<string, string> = { PLACED: "wait", ACCEPTED: "work", DELIVERED: "ready", RECEIVED: "done", CANCELLED: "bad" };

export function OrderStatusPill({ status }: { status: string }) {
  return <span className={`pill tone-${ORDER_TONE[status] ?? "neutral"}`}>{ORDER_STATUS_LABEL[status] ?? status}</span>;
}

export function Section({
  title,
  actions,
  children,
  id,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="h2">{title}</h2>
        {actions}
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted text-sm">{children}</p>;
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="label">{k}</div>
      <div className="mt-0.5">{v || <span className="muted">-</span>}</div>
    </div>
  );
}

/** The model page; a non-sewing kind goes in the query (no kind means sewing). */
export function modelHref(brand: string, model: string, kind?: string | null) {
  const base = `/models/${encodeURIComponent(brand)}/${encodeURIComponent(model)}`;
  return kind && kind !== "sewing" ? `${base}?kind=${encodeURIComponent(kind)}` : base;
}
