-- Grouped deliveries (batching) removed: every delivery is now charged its own commission.
ALTER TABLE delivery_commissions DROP COLUMN IF EXISTS batch_id;
ALTER TABLE tickets DROP COLUMN IF EXISTS delivery_batch_id;
ALTER TABLE branches DROP COLUMN IF EXISTS delivery_batch_minutes;
DROP TABLE IF EXISTS delivery_batches;
