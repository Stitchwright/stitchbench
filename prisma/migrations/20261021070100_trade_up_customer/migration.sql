-- AddForeignKey
ALTER TABLE "TradeUpOffer" ADD CONSTRAINT "TradeUpOffer_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

