-- Restaurant plan drawing per floor: walls, rooms/zones, bar counter, doors, plants, labels (tables stay in dining_tables).
ALTER TABLE floors
  ADD COLUMN layout jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN width  int   NOT NULL DEFAULT 1200 CHECK (width BETWEEN 400 AND 5000),
  ADD COLUMN height int   NOT NULL DEFAULT 800  CHECK (height BETWEEN 300 AND 5000);
