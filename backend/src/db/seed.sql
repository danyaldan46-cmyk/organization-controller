-- Demo seed: one organization, a small hierarchy, a pay rule, some tasks.
-- Password for every seeded user is "password123" (bcrypt hash below).
-- Run AFTER schema.sql.

DO $$
DECLARE
  org_id UUID;
  head_id UUID;
  vp_id UUID;
  teacher_id UUID;
  pwd_hash TEXT := '$2a$10$CwTycUXWue0Thq9StjUM0uJ8O5Xz5Fz3f7q6yq6y6y6y6y6y6y6y6'; -- placeholder, replace via API signup in practice
BEGIN
  INSERT INTO organizations (name, slug) VALUES ('Riverside High School', 'riverside-high')
  RETURNING id INTO org_id;

  INSERT INTO people (organization_id, parent_id, path, role_title, name, email, password_hash, is_head)
  VALUES (org_id, NULL, 'root', 'Principal', 'Dana Whitfield', 'dana@riverside.edu', pwd_hash, true)
  RETURNING id INTO head_id;

  UPDATE people SET path = head_id::text::ltree WHERE id = head_id;

  INSERT INTO people (organization_id, parent_id, path, role_title, name, email, password_hash)
  VALUES (org_id, head_id, (head_id::text || '.' || replace(gen_random_uuid()::text,'-',''))::ltree, 'Vice Principal', 'Sam Okafor', 'sam@riverside.edu', pwd_hash)
  RETURNING id INTO vp_id;

  -- fix vp path to use its own id, not a random one
  UPDATE people SET path = (head_id::text || '.' || replace(id::text,'-',''))::ltree WHERE id = vp_id;

  INSERT INTO people (organization_id, parent_id, path, role_title, name, email, password_hash)
  VALUES (org_id, vp_id, (SELECT path FROM people WHERE id = vp_id)::text || '.placeholder', 'Mathematics Teacher', 'Priya Nair', 'priya@riverside.edu', pwd_hash)
  RETURNING id INTO teacher_id;

  UPDATE people SET path = ((SELECT path FROM people WHERE id = vp_id)::text || '.' || replace(id::text,'-',''))::ltree WHERE id = teacher_id;

  INSERT INTO profiles (person_id, organization_id, bio) VALUES (teacher_id, org_id, 'Mathematics teacher, 6 years experience.');

  INSERT INTO pay_rules (organization_id, scope, pay_type, base_rate, overtime_enabled, overtime_threshold_hrs, overtime_multiplier)
  VALUES (org_id, 'organization', 'hourly', 25.00, true, 40, 1.5);

  INSERT INTO pay_rules (organization_id, scope, role_title, pay_type, base_rate, overtime_enabled, overtime_threshold_hrs, overtime_multiplier)
  VALUES (org_id, 'role', 'Mathematics Teacher', 'hourly', 32.00, true, 35, 1.5);

  INSERT INTO task_entries (organization_id, person_id, description, start_time, end_time)
  VALUES (org_id, teacher_id, 'Took Mathematics class, Grade 10', now() - interval '5 hours', now() - interval '1 hour');
END $$;
