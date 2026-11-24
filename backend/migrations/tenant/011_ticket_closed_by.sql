-- Which cashier closed (settled) each ticket — for the staff activity report.
ALTER TABLE tickets ADD COLUMN closed_by bigint REFERENCES users(id);
UPDATE tickets t SET closed_by = p.created_by
  FROM (SELECT DISTINCT ON (ticket_id) ticket_id, created_by FROM payments WHERE kind = 'payment' AND created_by IS NOT NULL
        ORDER BY ticket_id, id DESC) p
 WHERE p.ticket_id = t.id AND t.status = 'paid';
CREATE INDEX ON tickets (closed_by);
CREATE INDEX ON ticket_lines (kitchen_by);
