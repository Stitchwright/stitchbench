-- CreateTable
CREATE TABLE "ClubPayment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paymentIntent" TEXT,
    "saleId" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubPayment_shopId_memberId_month_idx" ON "ClubPayment"("shopId", "memberId", "month");

-- CreateIndex
CREATE INDEX "ClubPayment_shopId_paymentIntent_idx" ON "ClubPayment"("shopId", "paymentIntent");

-- CreateIndex
CREATE UNIQUE INDEX "ClubPayment_shopId_invoiceId_key" ON "ClubPayment"("shopId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubPayment_shopId_saleId_key" ON "ClubPayment"("shopId", "saleId");

-- AddForeignKey
ALTER TABLE "ClubPayment" ADD CONSTRAINT "ClubPayment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPayment" ADD CONSTRAINT "ClubPayment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "ClubMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

