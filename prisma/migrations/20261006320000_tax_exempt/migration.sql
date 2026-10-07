-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "taxExemptId" TEXT,
ADD COLUMN     "taxExemptUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "taxExemptId" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "taxExemptId" TEXT;

