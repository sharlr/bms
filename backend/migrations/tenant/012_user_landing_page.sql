-- Page a user lands on after signing in. 'auto' = decided by role (cashier → POS, kitchen → KDS, managers → Home).
ALTER TABLE users ADD COLUMN landing_page text NOT NULL DEFAULT 'auto'
  CHECK (landing_page IN ('auto','home','pos','kds','orders'));
