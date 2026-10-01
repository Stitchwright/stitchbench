-- The schedulers' date scans (review requests, uncollected machines) walk these columns every few minutes.
CREATE INDEX "Ticket_shopId_status_closedAt_idx" ON "Ticket"("shopId", "status", "closedAt");
CREATE INDEX "RepairJob_shopId_side_backAt_idx" ON "RepairJob"("shopId", "side", "backAt");
CREATE INDEX "RepairJob_shopId_side_pickedUpAt_idx" ON "RepairJob"("shopId", "side", "pickedUpAt");
