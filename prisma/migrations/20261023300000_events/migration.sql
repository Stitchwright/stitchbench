-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "choices" JSONB;

-- AlterTable
ALTER TABLE "ShopClass" ADD COLUMN     "balanceDays" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "choices" JSONB,
ADD COLUMN     "depositCents" INTEGER,
ADD COLUMN     "depositRefundable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "doorCents" INTEGER,
ADD COLUMN     "earlyCents" INTEGER,
ADD COLUMN     "earlyUntil" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'CLASS';

-- CreateTable
CREATE TABLE "EventPayment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PAYMENT',
    "amountCents" INTEGER NOT NULL,
    "saleId" TEXT,
    "webOrderId" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventDraw" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prize" TEXT NOT NULL,
    "drawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "present" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "EventDraw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventPayment_enrollmentId_idx" ON "EventPayment"("enrollmentId");

-- CreateIndex
CREATE INDEX "EventPayment_shopId_webOrderId_idx" ON "EventPayment"("shopId", "webOrderId");

-- CreateIndex
CREATE INDEX "EventDraw_classId_drawnAt_idx" ON "EventDraw"("classId", "drawnAt");

-- AddForeignKey
ALTER TABLE "EventPayment" ADD CONSTRAINT "EventPayment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventPayment" ADD CONSTRAINT "EventPayment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDraw" ADD CONSTRAINT "EventDraw_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDraw" ADD CONSTRAINT "EventDraw_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ShopClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

