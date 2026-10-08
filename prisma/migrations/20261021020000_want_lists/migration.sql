-- CreateTable
CREATE TABLE "WantItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partId" TEXT,
    "words" TEXT,
    "note" TEXT,
    "matchedPartId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "toldAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WantItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WantItem_shopId_doneAt_idx" ON "WantItem"("shopId", "doneAt");

-- CreateIndex
CREATE INDEX "WantItem_customerId_idx" ON "WantItem"("customerId");

-- AddForeignKey
ALTER TABLE "WantItem" ADD CONSTRAINT "WantItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WantItem" ADD CONSTRAINT "WantItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

