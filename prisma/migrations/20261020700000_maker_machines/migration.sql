-- CreateTable
CREATE TABLE "StarterBundle" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StarterBundle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StarterBundle_shopId_kind_idx" ON "StarterBundle"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "StarterBundle_shopId_name_key" ON "StarterBundle"("shopId", "name");

-- AddForeignKey
ALTER TABLE "StarterBundle" ADD CONSTRAINT "StarterBundle_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

