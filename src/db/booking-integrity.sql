CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_end_after_start CHECK (end_time > start_time);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    business_id WITH =,
    (COALESCE(staff_user_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status <> 'cancelled');