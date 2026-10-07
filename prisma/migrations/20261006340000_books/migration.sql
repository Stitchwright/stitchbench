-- CreateTable
CREATE TABLE "BooksSettings" (
    "shopId" TEXT NOT NULL,
    "accounts" JSONB NOT NULL DEFAULT '{}',
    "byCategory" BOOLEAN NOT NULL DEFAULT false,
    "netDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "cardClearing" TEXT NOT NULL DEFAULT '',
    "exportedThrough" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BooksSettings_pkey" PRIMARY KEY ("shopId")
);

-- AddForeignKey
ALTER TABLE "BooksSettings" ADD CONSTRAINT "BooksSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

