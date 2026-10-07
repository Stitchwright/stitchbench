-- AlterTable
ALTER TABLE "ConsignItem" ADD COLUMN     "pendingAt" TIMESTAMP(3),
ADD COLUMN     "pendingReturn" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "costTenThou" INTEGER;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reversesId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesId_key" ON "Payment"("reversesId");

