-- Demo data for the reference audience API. Safe to re-run: it recreates its own schema only.
DROP SCHEMA IF EXISTS reference_demo CASCADE;
CREATE SCHEMA reference_demo;

CREATE TABLE reference_demo.universities (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE reference_demo.courses (id text PRIMARY KEY, name text NOT NULL);

CREATE TABLE reference_demo.students (
  id text PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  display_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  phone text,
  password_hash text NOT NULL,
  university_id text REFERENCES reference_demo.universities (id),
  course_id text REFERENCES reference_demo.courses (id),
  semester integer,
  joined_on date,
  withdrawn boolean NOT NULL DEFAULT false,
  whatsapp_consent boolean,
  sms_consent boolean
);

-- Extra enrollments beyond a student's primary course.
CREATE TABLE reference_demo.enrollments (
  student_id text NOT NULL REFERENCES reference_demo.students (id),
  course_id text NOT NULL REFERENCES reference_demo.courses (id)
);

-- The course dimension matches the primary course or any enrollment, and each student stays one row.
CREATE VIEW reference_demo.student_courses AS
  SELECT id AS student_id, course_id FROM reference_demo.students WHERE course_id IS NOT NULL
  UNION
  SELECT student_id, course_id FROM reference_demo.enrollments;

CREATE TABLE reference_demo.devices (
  id serial PRIMARY KEY,
  student_id text NOT NULL REFERENCES reference_demo.students (id),
  token text,
  platform text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE reference_demo.purchases (
  id serial PRIMARY KEY,
  student_id text NOT NULL REFERENCES reference_demo.students (id),
  is_active boolean NOT NULL,
  expiry_date date
);

INSERT INTO reference_demo.universities VALUES ('u1', 'Alpha University'), ('u2', 'Beta University');
INSERT INTO reference_demo.courses VALUES ('c1', 'Medicine'), ('c2', 'Nursing'), ('c3', 'Pharmacy');

INSERT INTO reference_demo.students
  (id, first_name, last_name, email, email_verified, phone, password_hash, university_id, course_id, semester, joined_on, withdrawn, whatsapp_consent, sms_consent) VALUES
  ('s001', 'Asha', 'Rao', 'asha@example.test', true, '+91 90000 00001', 'secret-hash-1', 'u1', 'c1', 3, '2025-06-01', false, true, true),
  ('s002', 'Bala', 'Iyer', 'bala@example.test', false, '919000000002', 'secret-hash-2', 'u1', 'c1', 3, '2025-06-02', false, false, true),
  ('s003', 'Chitra', 'Nair', 'chitra@example.test', true, NULL, 'secret-hash-3', 'u1', 'c2', 4, '2025-07-01', false, NULL, NULL),
  ('s004', 'Dev', 'Menon', 'dev@example.test', true, '919000000004', 'secret-hash-4', 'u2', 'c2', 4, '2025-07-15', true, true, true),
  ('s005', 'Esha', 'Pillai', NULL, false, '919000000005', 'secret-hash-5', 'u2', 'c3', 5, '2025-08-01', false, true, false),
  ('s006', 'Farid', 'Khan', 'farid@example.test', true, '919000000006', 'secret-hash-6', 'u2', NULL, NULL, NULL, false, true, true);

INSERT INTO reference_demo.enrollments VALUES ('s001', 'c3'), ('s003', 'c1'), ('s006', 'c3');

INSERT INTO reference_demo.devices (student_id, token, platform, active) VALUES
  ('s001', 'tok-s001-a', 'android', true),
  ('s001', 'tok-s001-old', 'android', false),
  ('s002', 'tok-s002', 'ios', true),
  ('s003', NULL, 'android', true),
  ('s004', 'tok-s004', 'ios', true);

INSERT INTO reference_demo.purchases (student_id, is_active, expiry_date) VALUES
  ('s001', true, NULL),
  ('s002', true, '2000-01-01'),
  ('s003', false, NULL),
  ('s004', true, '2999-01-01');
