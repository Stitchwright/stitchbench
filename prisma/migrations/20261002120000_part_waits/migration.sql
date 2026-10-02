-- CreateTable
CREATE TABLE "PartWait" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "supplier" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedOn" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "noticedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "PartWait_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartWait_shopId_receivedAt_cancelledAt_idx" ON "PartWait"("shopId", "receivedAt", "cancelledAt");

-- CreateIndex
CREATE INDEX "PartWait_ticketId_idx" ON "PartWait"("ticketId");

-- CreateIndex
CREATE INDEX "PartWait_partId_idx" ON "PartWait"("partId");

-- AddForeignKey
ALTER TABLE "PartWait" ADD CONSTRAINT "PartWait_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartWait" ADD CONSTRAINT "PartWait_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartWait" ADD CONSTRAINT "PartWait_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

