-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "role" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "subjectLabel" TEXT,
    "changes" JSONB,
    "amountCents" INTEGER,
    "reason" TEXT,
    "ip" TEXT,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEntry_shopId_at_idx" ON "AuditEntry"("shopId", "at");

-- CreateIndex
CREATE INDEX "AuditEntry_shopId_subjectType_subjectId_idx" ON "AuditEntry"("shopId", "subjectType", "subjectId");


-- The audit log is append-only (later-round-1-design.md 4.2): the database refuses UPDATE, DELETE and TRUNCATE unless
-- the transaction has said it is pruning (set_config('stitchbench.audit_prune', 'on', true), src/lib/audit.ts).
CREATE FUNCTION "AuditEntry_guard"() RETURNS trigger AS $fn$
BEGIN
  IF current_setting('stitchbench.audit_prune', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit log cannot be changed or deleted';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEntry_no_change" BEFORE UPDATE OR DELETE ON "AuditEntry" FOR EACH ROW EXECUTE FUNCTION "AuditEntry_guard"();
CREATE TRIGGER "AuditEntry_no_truncate" BEFORE TRUNCATE ON "AuditEntry" FOR EACH STATEMENT EXECUTE FUNCTION "AuditEntry_guard"();
