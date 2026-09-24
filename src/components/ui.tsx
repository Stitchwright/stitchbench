import Link from "next/link";
import type { TicketStatus } from "@/generated/prisma/enums";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/constants";

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

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`pill tone-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
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

export function modelHref(brand: string, model: string) {
  return `/models/${encodeURIComponent(brand)}/${encodeURIComponent(model)}`;
}
