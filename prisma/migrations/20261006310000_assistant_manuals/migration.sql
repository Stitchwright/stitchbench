-- AlterTable
ALTER TABLE "AssistantSettings" ADD COLUMN     "manualsOn" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ManualPage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "ManualPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualIndexDoc" (
    "shopId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "totalPages" INTEGER NOT NULL DEFAULT 0,
    "donePages" INTEGER NOT NULL DEFAULT 0,
    "blankPages" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualIndexDoc_pkey" PRIMARY KEY ("shopId","docId")
);

-- CreateIndex
CREATE INDEX "ManualPage_shopId_docId_idx" ON "ManualPage"("shopId", "docId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualPage_shopId_docId_page_key" ON "ManualPage"("shopId", "docId", "page");

-- CreateIndex
CREATE INDEX "ManualIndexDoc_shopId_status_idx" ON "ManualIndexDoc"("shopId", "status");

-- AddForeignKey
ALTER TABLE "ManualPage" ADD CONSTRAINT "ManualPage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualIndexDoc" ADD CONSTRAINT "ManualIndexDoc_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Full-text search over the extracted page text (Prisma can't express an expression index; the search queries use the same expression).
CREATE INDEX "ManualPage_text_fts" ON "ManualPage" USING GIN (to_tsvector('english', "text"));
