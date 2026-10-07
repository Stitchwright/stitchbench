-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "unitLoanId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "loanerDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "loanerDepositCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "use" TEXT NOT NULL DEFAULT 'SALE';

-- CreateTable
CREATE TABLE "UnitLoan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'LOAN',
    "customerId" TEXT,
    "ticketId" TEXT,
    "outAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueOn" TEXT,
    "backAt" TIMESTAMP(3),
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "cardNote" TEXT,
    "conditionOut" TEXT,
    "conditionBack" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitLoan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitLoan_shopId_backAt_idx" ON "UnitLoan"("shopId", "backAt");

-- CreateIndex
CREATE INDEX "UnitLoan_unitId_idx" ON "UnitLoan"("unitId");

-- CreateIndex
CREATE INDEX "UnitLoan_customerId_idx" ON "UnitLoan"("customerId");

-- AddForeignKey
ALTER TABLE "UnitLoan" ADD CONSTRAINT "UnitLoan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitLoan" ADD CONSTRAINT "UnitLoan_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

