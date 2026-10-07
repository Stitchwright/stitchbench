-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "certFor" TEXT;

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "equipment" TEXT NOT NULL,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" TEXT,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Certification_shopId_equipment_idx" ON "Certification"("shopId", "equipment");

-- CreateIndex
CREATE UNIQUE INDEX "Certification_shopId_customerId_equipment_key" ON "Certification"("shopId", "customerId", "equipment");

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every customer certified to rent the longarm today is certified on "Longarm" (Customer.longarmCertifiedAt stays and is
-- kept in step until it is removed).
INSERT INTO "Certification" ("id", "shopId", "customerId", "equipment", "certifiedAt")
SELECT 'c' || substr(md5(random()::text || c."id"), 1, 24), c."shopId", c."id", 'Longarm', c."longarmCertifiedAt"
FROM "Customer" c
WHERE c."longarmCertifiedAt" IS NOT NULL
ON CONFLICT DO NOTHING;
