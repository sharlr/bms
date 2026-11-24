-- Any number of preparation stations (kitchens, bars, grill, pastry…) instead of a fixed kitchen + bar.
CREATE TABLE prep_stations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#2563eb',
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);
-- The two former fixed routes become the first two stations of every company.
INSERT INTO prep_stations (company_id, name, color, sort)
SELECT id, 'Kitchen', '#2563eb', 1 FROM companies UNION ALL SELECT id, 'Bar', '#0891b2', 2 FROM companies;

CREATE FUNCTION pg_temp.station_for(p_company bigint, p_route text) RETURNS bigint LANGUAGE sql AS $$
  SELECT id FROM prep_stations WHERE company_id = p_company
     AND name = CASE p_route WHEN 'kitchen' THEN 'Kitchen' WHEN 'beverage' THEN 'Bar' END
$$;

-- Menu: category → station (NULL = no kitchen ticket); item → own station, inherit, or no ticket.
ALTER TABLE menu_categories ADD COLUMN station_id bigint REFERENCES prep_stations(id);
UPDATE menu_categories SET station_id = pg_temp.station_for(company_id, kot_route);
ALTER TABLE menu_categories DROP COLUMN kot_route;

ALTER TABLE menu_items ADD COLUMN station_id bigint REFERENCES prep_stations(id), ADD COLUMN no_kot boolean NOT NULL DEFAULT false;
UPDATE menu_items SET station_id = pg_temp.station_for(company_id, kot_route), no_kot = coalesce(kot_route = 'none', false);
ALTER TABLE menu_items DROP COLUMN kot_route;

-- Order lines remember the station they were sent to (NULL = no kitchen ticket).
ALTER TABLE ticket_lines ADD COLUMN station_id bigint REFERENCES prep_stations(id);
UPDATE ticket_lines l SET station_id = pg_temp.station_for(t.company_id, l.kot_route) FROM tickets t WHERE t.id = l.ticket_id;
ALTER TABLE ticket_lines DROP COLUMN kot_route;

-- Printers: 'kot' printers serve one station (a station may have several printers); 'receipt' printers none.
ALTER TABLE printers ADD COLUMN station_id bigint REFERENCES prep_stations(id);
ALTER TABLE printers DROP CONSTRAINT printers_kind_check;
UPDATE printers p SET station_id = pg_temp.station_for(b.company_id, p.kind) FROM branches b WHERE b.id = p.branch_id AND p.kind IN ('kitchen','beverage');
UPDATE printers SET kind = 'kot' WHERE kind IN ('kitchen','beverage');
ALTER TABLE printers ADD CONSTRAINT printers_kind_check CHECK (kind IN ('kot','receipt')),
                     ADD CONSTRAINT printers_station_check CHECK ((kind = 'kot') = (station_id IS NOT NULL));

-- Kitchen order tickets: one per station.
ALTER TABLE kot_orders ADD COLUMN station_id bigint REFERENCES prep_stations(id);
UPDATE kot_orders k SET station_id = pg_temp.station_for(b.company_id, k.route) FROM branches b WHERE b.id = k.branch_id;
ALTER TABLE kot_orders ALTER COLUMN station_id SET NOT NULL, DROP COLUMN route;
CREATE INDEX ON kot_orders (branch_id, station_id, status);
