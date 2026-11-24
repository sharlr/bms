-- Per-user display preferences and job position (edited on "My profile").
ALTER TABLE users
  ADD COLUMN position text,
  ADD COLUMN theme    text NOT NULL DEFAULT 'gold' CHECK (theme IN ('gold','navy','emerald','crimson','slate')),
  ADD COLUMN language text NOT NULL DEFAULT 'en'   CHECK (language IN ('en','fr'));
