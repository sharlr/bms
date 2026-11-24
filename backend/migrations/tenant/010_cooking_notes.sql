-- Predefined cooking notes offered as a drop-down on the POS (staff can still type their own).
CREATE TABLE cooking_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  text       text NOT NULL,
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, text)
);

INSERT INTO cooking_notes (company_id, text, sort)
SELECT c.id, n.text, n.sort FROM companies c CROSS JOIN (VALUES
  ('Well done', 1), ('Medium', 2), ('Rare', 3), ('No onions', 4), ('No garlic', 5), ('No salt', 6),
  ('Extra spicy', 7), ('Not spicy', 8), ('Extra cheese', 9), ('Sauce on the side', 10), ('No ice', 11), ('Less sugar', 12)
) AS n(text, sort)
ON CONFLICT DO NOTHING;
