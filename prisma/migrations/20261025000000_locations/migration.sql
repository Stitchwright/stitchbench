-- AlterEnum
ALTER TYPE "MoveReason" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "AccountEntry" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "CardReader" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "GiftCardEntry" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "Layaway" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "LiveSale" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "LongarmOrder" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "MakeJob" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "split" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "dailySummaryBy" TEXT NOT NULL DEFAULT 'email',
ADD COLUMN     "dailySummaryOn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "nextTransferNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "onlineLocationId" TEXT;

-- AlterTable
ALTER TABLE "ShopClass" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "SpecialOrder" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "UnitLoan" ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "approveCode" TEXT,
ADD COLUMN     "locationId" TEXT;

-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "main" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT,
    "phone" TEXT,
    "timeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "taxRatePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hours" TEXT,
    "receiptFooter" TEXT,
    "dailyAt" TEXT,
    "approveRefundCents" INTEGER,
    "approveDiscountPct" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "qtyOnHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorderAt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bin" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "note" TEXT,
    "neededBy" TEXT,
    "declineReason" TEXT,
    "forCustomerId" TEXT,
    "saleId" TEXT,
    "specialOrderId" TEXT,
    "poId" TEXT,
    "askedById" TEXT,
    "askedAt" TIMESTAMP(3),
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "arrivedById" TEXT,
    "arrivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "partId" TEXT,
    "unitId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "qtySent" DOUBLE PRECISION,
    "qtyArrived" DOUBLE PRECISION,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreNote" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "fromLocationId" TEXT,
    "toLocationId" TEXT,
    "userId" TEXT,
    "text" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreNoteRead" (
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreNoteRead_pkey" PRIMARY KEY ("noteId","userId")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "pct" DOUBLE PRECISION,
    "reason" TEXT,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "requestedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ASKED',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_shopId_sortOrder_idx" ON "Location"("shopId", "sortOrder");

-- CreateIndex
CREATE INDEX "StockLevel_shopId_locationId_idx" ON "StockLevel"("shopId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_partId_locationId_key" ON "StockLevel"("partId", "locationId");

-- CreateIndex
CREATE INDEX "StockTransfer_shopId_status_idx" ON "StockTransfer"("shopId", "status");

-- CreateIndex
CREATE INDEX "StockTransfer_shopId_toId_status_idx" ON "StockTransfer"("shopId", "toId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_shopId_number_key" ON "StockTransfer"("shopId", "number");

-- CreateIndex
CREATE INDEX "StockTransferLine_transferId_idx" ON "StockTransferLine"("transferId");

-- CreateIndex
CREATE INDEX "StoreNote_shopId_createdAt_idx" ON "StoreNote"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_shopId_status_idx" ON "Approval"("shopId", "status");

-- CreateIndex
CREATE INDEX "AccountEntry_shopId_locationId_idx" ON "AccountEntry"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "AppointmentType_shopId_locationId_idx" ON "AppointmentType"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "CardReader_shopId_locationId_idx" ON "CardReader"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "GiftCardEntry_shopId_locationId_idx" ON "GiftCardEntry"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "Layaway_shopId_locationId_idx" ON "Layaway"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "LiveSale_shopId_locationId_idx" ON "LiveSale"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "LongarmOrder_shopId_locationId_idx" ON "LongarmOrder"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "MakeJob_shopId_locationId_idx" ON "MakeJob"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shopId_locationId_idx" ON "PurchaseOrder"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "Sale_shopId_locationId_idx" ON "Sale"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "Shift_shopId_locationId_idx" ON "Shift"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "ShopClass_shopId_locationId_idx" ON "ShopClass"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "SpecialOrder_shopId_locationId_idx" ON "SpecialOrder"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "StockMove_shopId_locationId_idx" ON "StockMove"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "StockUnit_shopId_locationId_idx" ON "StockUnit"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "Ticket_shopId_locationId_idx" ON "Ticket"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "UnitLoan_shopId_locationId_idx" ON "UnitLoan"("shopId", "locationId");

-- CreateIndex
CREATE INDEX "WebOrder_shopId_locationId_idx" ON "WebOrder"("shopId", "locationId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreNote" ADD CONSTRAINT "StoreNote_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreNoteRead" ADD CONSTRAINT "StoreNoteRead_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "StoreNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreNoteRead" ADD CONSTRAINT "StoreNoteRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: one store per company, made from the company's own details (the main store), and every existing row that
-- belongs to a store assigned to it (shop-features-round-2-design.md 7.1). Nothing else changes: a company with one
-- store works exactly as before.
INSERT INTO "Location" ("id", "shopId", "name", "main", "address", "phone", "timeZone", "taxRatePct", "receiptFooter", "sortOrder")
SELECT 'loc' || substr(md5(random()::text || s."id"), 1, 22), s."id", 'Main store', true, s."address", s."phone", s."timeZone", s."taxRatePct", s."receiptNote", 0
FROM "Shop" s
WHERE NOT EXISTS (SELECT 1 FROM "Location" l WHERE l."shopId" = s."id" AND l."main");

UPDATE "Sale" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "Ticket" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "WebOrder" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "StockUnit" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "PurchaseOrder" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "ShopClass" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "AppointmentType" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "Shift" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "LongarmOrder" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "MakeJob" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "SpecialOrder" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "UnitLoan" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "GiftCardEntry" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "Layaway" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "LiveSale" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "AccountEntry" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "CardReader" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "StockMove" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
UPDATE "User" t SET "locationId" = l."id" FROM "Location" l WHERE l."shopId" = t."shopId" AND l."main" AND t."locationId" IS NULL;
