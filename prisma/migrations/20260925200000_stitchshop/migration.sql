-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MoveReason" ADD VALUE 'SOLD';
ALTER TYPE "MoveReason" ADD VALUE 'CONSIGNED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PartKind" ADD VALUE 'NOTION';
ALTER TYPE "PartKind" ADD VALUE 'FABRIC';
ALTER TYPE "PartKind" ADD VALUE 'THREAD';
ALTER TYPE "PartKind" ADD VALUE 'PATTERN';

-- AlterTable
ALTER TABLE "HubState" ADD COLUMN     "partnerCursor" TEXT,
ADD COLUMN     "partnerError" TEXT,
ADD COLUMN     "partnerSyncAt" TIMESTAMP(3),
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'member';

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "consignItemKey" TEXT,
ADD COLUMN     "consignLinkId" TEXT,
ADD COLUMN     "offerToPartners" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "wholesaleCents" INTEGER,
ALTER COLUMN "qtyOnHand" SET DEFAULT 0,
ALTER COLUMN "qtyOnHand" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "reorderAt" SET DEFAULT 0,
ALTER COLUMN "reorderAt" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "doesRepair" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "nextOrderNumber" INTEGER NOT NULL DEFAULT 1001,
ADD COLUMN     "nextSaleNumber" INTEGER NOT NULL DEFAULT 1001,
ADD COLUMN     "nextTagNumber" INTEGER NOT NULL DEFAULT 101,
ADD COLUMN     "receiptNote" TEXT,
ADD COLUMN     "sellsRetail" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockMove" ALTER COLUMN "qty" SET DATA TYPE DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "userId" TEXT,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "taxRatePct" DOUBLE PRECISION NOT NULL,
    "tenders" JSONB NOT NULL DEFAULT '[]',
    "changeCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "voidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "partNumber" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "unitPriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "costCents" INTEGER,
    "consignLinkId" TEXT,
    "consignItemKey" TEXT,
    "repairJobId" TEXT,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "terms" JSONB NOT NULL DEFAULT '{}',
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "accepted" JSONB NOT NULL DEFAULT '{}',
    "proposedTerms" JSONB,
    "proposedBy" TEXT,
    "accountId" TEXT,
    "catalog" JSONB,
    "catalogAt" TIMESTAMP(3),
    "catalogHash" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerOutbox" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "PartnerOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AT_SHOP_AWAITING_PICKUP',
    "customerId" TEXT,
    "machineId" TEXT,
    "customerName" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT,
    "machineType" TEXT,
    "problem" TEXT,
    "serviceRequested" TEXT,
    "accessories" TEXT[],
    "preApprovedCents" INTEGER,
    "ticketId" TEXT,
    "ticketNumber" INTEGER,
    "totalCents" INTEGER,
    "taxCents" INTEGER,
    "lines" JSONB,
    "commissionPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionCents" INTEGER,
    "repairNote" TEXT,
    "approval" TEXT,
    "approvedCents" INTEGER,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidWhere" TEXT,
    "pickedUpAt" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "sentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepairJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLACED',
    "lines" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "note" TEXT,
    "sellerNote" TEXT,
    "carrier" TEXT,
    "tracking" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "partId" TEXT,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "placed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "returned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "countedQty" DOUBLE PRECISION,
    "countedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsignItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsignSale" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "saleNumber" INTEGER,
    "soldAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsignSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "netCents" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "note" TEXT,
    "byName" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sale_shopId_createdAt_idx" ON "Sale"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_shopId_number_key" ON "Sale"("shopId", "number");

-- CreateIndex
CREATE INDEX "PartnerLink_shopId_idx" ON "PartnerLink"("shopId");

-- CreateIndex
CREATE INDEX "PartnerOutbox_sentAt_createdAt_idx" ON "PartnerOutbox"("sentAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepairJob_ticketId_key" ON "RepairJob"("ticketId");

-- CreateIndex
CREATE INDEX "RepairJob_shopId_status_idx" ON "RepairJob"("shopId", "status");

-- CreateIndex
CREATE INDEX "RepairJob_shopId_linkId_idx" ON "RepairJob"("shopId", "linkId");

-- CreateIndex
CREATE INDEX "PartnerOrder_shopId_linkId_idx" ON "PartnerOrder"("shopId", "linkId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsignItem_shopId_linkId_itemKey_key" ON "ConsignItem"("shopId", "linkId", "itemKey");

-- CreateIndex
CREATE INDEX "ConsignSale_shopId_linkId_soldAt_idx" ON "ConsignSale"("shopId", "linkId", "soldAt");

-- CreateIndex
CREATE INDEX "Settlement_shopId_linkId_idx" ON "Settlement"("shopId", "linkId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerLink" ADD CONSTRAINT "PartnerLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerOutbox" ADD CONSTRAINT "PartnerOutbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairJob" ADD CONSTRAINT "RepairJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairJob" ADD CONSTRAINT "RepairJob_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairJob" ADD CONSTRAINT "RepairJob_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerOrder" ADD CONSTRAINT "PartnerOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignItem" ADD CONSTRAINT "ConsignItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsignSale" ADD CONSTRAINT "ConsignSale_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

