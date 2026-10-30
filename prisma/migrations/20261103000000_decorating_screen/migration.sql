-- AlterTable
ALTER TABLE "DecorOrder" ADD COLUMN     "screenCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DecorPlacement" ADD COLUMN     "underbase" BOOLEAN NOT NULL DEFAULT false;

