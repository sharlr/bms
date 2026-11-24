-- Menu item photos stored in the tenant DB (so tenant backups include them), served by the app.
CREATE TABLE item_images (
  item_id    bigint PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
