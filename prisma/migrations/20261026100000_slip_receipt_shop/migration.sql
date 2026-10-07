-- Slip receipts of companies deleted before this key existed
DELETE FROM "SlipReceipt" r WHERE NOT EXISTS (SELECT 1 FROM "Shop" s WHERE s."id" = r."shopId");

-- AddForeignKey
ALTER TABLE "SlipReceipt" ADD CONSTRAINT "SlipReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
