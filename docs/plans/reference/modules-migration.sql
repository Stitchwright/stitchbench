-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "bagReminderDays" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "checkInKind" TEXT NOT NULL DEFAULT 'sewing',
ADD COLUMN     "hubWritesOff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "details" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "equipment" TEXT NOT NULL DEFAULT 'SEWING',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'sewing';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "intake" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "jobType" TEXT NOT NULL DEFAULT 'BENCH',
ADD COLUMN     "readings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ServiceItem" ADD COLUMN     "equipmentKind" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "machineId" TEXT,
ADD COLUMN     "stockUnitId" TEXT,
ADD COLUMN     "tradeInUnitId" TEXT;

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "addedBy" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleGrant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "key" TEXT,
    "byEmail" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopEquipmentKind" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "equipment" TEXT NOT NULL DEFAULT 'APPLIANCE',
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "noun" TEXT,
    "types" TEXT[],
    "brands" TEXT[],
    "accessories" TEXT[],
    "defaultChecked" TEXT[],
    "checklist" TEXT[],
    "intakeFields" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopEquipmentKind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSite" (
    "ticketId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "contactName" TEXT,
    "contactPhone" TEXT,
    "accessNotes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketSite_pkey" PRIMARY KEY ("ticketId")
);

-- CreateTable
CREATE TABLE "StockUnit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "condition" TEXT NOT NULL DEFAULT 'NEW',
    "costCents" INTEGER,
    "priceCents" INTEGER,
    "warrantyMonths" INTEGER,
    "warrantyBy" TEXT,
    "soldLineId" TEXT,
    "soldAt" TIMESTAMP(3),
    "soldNetCents" INTEGER,
    "returnLineId" TEXT,
    "tradeInLineId" TEXT,
    "warrantyUntil" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "registrationRef" TEXT,
    "note" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VacCare" (
    "machineId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3),
    "contactedBy" TEXT,
    "contactNote" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "stopped" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VacCare_pkey" PRIMARY KEY ("machineId")
);

-- CreateIndex
CREATE UNIQUE INDEX "License_shopId_keyId_key" ON "License"("shopId", "keyId");

-- CreateIndex
CREATE INDEX "ModuleGrant_shopId_module_createdAt_idx" ON "ModuleGrant"("shopId", "module", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopEquipmentKind_shopId_key_key" ON "ShopEquipmentKind"("shopId", "key");

-- CreateIndex
CREATE INDEX "TicketSite_shopId_startsAt_idx" ON "TicketSite"("shopId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockUnit_machineId_key" ON "StockUnit"("machineId");

-- CreateIndex
CREATE INDEX "StockUnit_shopId_status_idx" ON "StockUnit"("shopId", "status");

-- CreateIndex
CREATE INDEX "VacCare_shopId_idx" ON "VacCare"("shopId");

-- CreateIndex
CREATE INDEX "Machine_shopId_equipment_idx" ON "Machine"("shopId", "equipment");

-- CreateIndex
CREATE INDEX "SaleLine_stockUnitId_idx" ON "SaleLine"("stockUnitId");

-- CreateIndex
CREATE INDEX "SaleLine_tradeInUnitId_idx" ON "SaleLine"("tradeInUnitId");

-- CreateIndex
CREATE INDEX "SaleLine_machineId_idx" ON "SaleLine"("machineId");

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleGrant" ADD CONSTRAINT "ModuleGrant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopEquipmentKind" ADD CONSTRAINT "ShopEquipmentKind_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSite" ADD CONSTRAINT "TicketSite_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSite" ADD CONSTRAINT "TicketSite_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VacCare" ADD CONSTRAINT "VacCare_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VacCare" ADD CONSTRAINT "VacCare_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing service menus are for sewing machines, except the fees that apply to anything brought in (storage, rush, diagnosis)
UPDATE "ServiceItem" SET "equipmentKind" = CASE WHEN "name" ~* '^(storage fee|rush|diagnosis)' THEN NULL ELSE 'sewing' END;
