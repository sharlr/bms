-- Prices can differ per order type (dine-in / takeaway / delivery). NULL = applies to every order type.
ALTER TABLE item_prices ADD COLUMN order_type text CHECK (order_type IN ('dine_in','takeaway','delivery'));
DROP INDEX item_prices_uq;
CREATE UNIQUE INDEX item_prices_uq ON item_prices (item_id, coalesce(size_id, 0), coalesce(branch_id, 0), coalesce(order_type, ''));
