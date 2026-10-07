-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "sameAs" TEXT[] DEFAULT ARRAY[]::TEXT[];

