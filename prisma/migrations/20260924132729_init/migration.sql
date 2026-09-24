-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'TECH');

-- CreateEnum
CREATE TYPE "CustomerKind" AS ENUM ('RETAIL', 'TRADE');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('GOTCHA', 'FACT', 'TIP');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('AT_SHOP_AWAITING_PICKUP', 'IN_TRUCK', 'ON_BENCH', 'WAITING_CUSTOMER_OK', 'WAITING_PARTS', 'READY_IN_TRUCK', 'READY_FOR_PICKUP', 'COLLECTED', 'ABANDONED', 'RETURNED_UNREPAIRED');

-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('SERVICE', 'LABOR', 'PART', 'FEE', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'CASH', 'CHECK', 'SHOP_COLLECTED', 'INVOICE', 'OTHER');

-- CreateEnum
CREATE TYPE "MoveReason" AS ENUM ('RECEIVED', 'USED', 'RETURNED', 'ADJUSTED');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "laborRateCents" INTEGER NOT NULL DEFAULT 9800,
    "taxRatePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "partsMarkupPct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "warrantyDays" INTEGER NOT NULL DEFAULT 90,
    "abandonedAfterDays" INTEGER NOT NULL DEFAULT 60,
    "storageFeeCents" INTEGER NOT NULL DEFAULT 4500,
    "nextTicketNumber" INTEGER NOT NULL DEFAULT 51,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'TECH',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "CustomerKind" NOT NULL DEFAULT 'RETAIL',
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "code" TEXT,
    "commissionPct" DOUBLE PRECISION,
    "routeDay" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "serial" TEXT,
    "machineType" TEXT,
    "customerId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelNote" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "modelLabel" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL DEFAULT 'GOTCHA',
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TensionSpec" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "modelKeys" TEXT[],
    "machineType" TEXT,
    "upperMinG" DOUBLE PRECISION,
    "upperMaxG" DOUBLE PRECISION,
    "bobbinMinG" DOUBLE PRECISION,
    "bobbinMaxG" DOUBLE PRECISION,
    "upperPrinted" TEXT,
    "bobbinPrinted" TEXT,
    "upperText" TEXT,
    "upperConditions" TEXT,
    "bobbinText" TEXT,
    "bobbinConditions" TEXT,
    "otherSpecs" TEXT,
    "sourceFile" TEXT NOT NULL,
    "sourcePath" TEXT,
    "pages" TEXT,
    "docType" TEXT,
    "confidence" TEXT,
    "notes" TEXT,

    CONSTRAINT "TensionSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'ON_BENCH',
    "machineId" TEXT NOT NULL,
    "customerId" TEXT,
    "viaAccountId" TEXT,
    "serviceRequested" TEXT,
    "problem" TEXT,
    "diagnosis" TEXT,
    "workDone" TEXT,
    "preApprovedCents" INTEGER,
    "approvedCents" INTEGER,
    "accessories" TEXT[],
    "accessoriesReturned" BOOLEAN NOT NULL DEFAULT false,
    "taxRatePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "intakeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "warrantyUntil" TIMESTAMP(3),
    "openedById" TEXT,
    "techId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLine" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "LineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "partId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "brand" TEXT,
    "fits" TEXT,
    "location" TEXT,
    "qtyOnHand" INTEGER NOT NULL DEFAULT 0,
    "reorderAt" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER,
    "priceCents" INTEGER,
    "supplier" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMove" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reason" "MoveReason" NOT NULL,
    "ticketId" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Customer_shopId_name_idx" ON "Customer"("shopId", "name");

-- CreateIndex
CREATE INDEX "Machine_shopId_serial_idx" ON "Machine"("shopId", "serial");

-- CreateIndex
CREATE INDEX "Machine_shopId_brand_modelKey_idx" ON "Machine"("shopId", "brand", "modelKey");

-- CreateIndex
CREATE INDEX "ModelNote_shopId_brand_modelKey_idx" ON "ModelNote"("shopId", "brand", "modelKey");

-- CreateIndex
CREATE INDEX "TensionSpec_brand_idx" ON "TensionSpec"("brand");

-- CreateIndex
CREATE INDEX "Ticket_shopId_status_idx" ON "Ticket"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_shopId_number_key" ON "Ticket"("shopId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Part_shopId_partNumber_key" ON "Part"("shopId", "partNumber");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelNote" ADD CONSTRAINT "ModelNote_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelNote" ADD CONSTRAINT "ModelNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_viaAccountId_fkey" FOREIGN KEY ("viaAccountId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_techId_fkey" FOREIGN KEY ("techId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceItem" ADD CONSTRAINT "ServiceItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
