/*
  Warnings:

  - The `accessoriesReturned` column on the `Ticket` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "checklistItems" TEXT[];

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "bobbinFoundG" DOUBLE PRECISION,
ADD COLUMN     "bobbinLeftG" DOUBLE PRECISION,
ADD COLUMN     "checklist" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "upperFoundG" DOUBLE PRECISION,
ADD COLUMN     "upperLeftG" DOUBLE PRECISION,
DROP COLUMN "accessoriesReturned",
ADD COLUMN     "accessoriesReturned" TEXT[];

-- CreateTable
CREATE TABLE "MachinePhoto" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "ticketId" TEXT,
    "caption" TEXT,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachinePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachinePhoto_machineId_idx" ON "MachinePhoto"("machineId");

-- AddForeignKey
ALTER TABLE "MachinePhoto" ADD CONSTRAINT "MachinePhoto_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePhoto" ADD CONSTRAINT "MachinePhoto_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachinePhoto" ADD CONSTRAINT "MachinePhoto_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
