const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../db/pool');

const router = express.Router();

const registerOrgSchema = z.object({
  organizationName: z.string().min(2),
  headName: z.string().min(2),
  headTitle: z.string().min(2).default('Head'),
  email: z.string().email(),
  password: z.string().min(8),
});

// Creates a brand-new tenant with its Head as the first person (root of the tree).
router.post('/register-organization', async (req, res) => {
  const parsed = registerOrgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { organizationName, headName, headTitle, email, password } = parsed.data;

  const slug = organizationName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const passwordHash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orgResult = await client.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      [organizationName, slug]
    );
    const orgId = orgResult.rows[0].id;

    // Insert head with a placeholder path, then fix path to its own id.
    const headResult = await client.query(
      `INSERT INTO people (organization_id, parent_id, path, role_title, name, email, password_hash, is_head)
       VALUES ($1, NULL, 'root', $2, $3, $4, $5, true) RETURNING id`,
      [orgId, headTitle, headName, email.toLowerCase(), passwordHash]
    );
    const headId = headResult.rows[0].id;

    await client.query(
      `UPDATE people SET path = $1::text::ltree WHERE id = $1`,
      [headId]
    );

    await client.query('COMMIT');

    const token = jwt.sign({ sub: headId }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });

    res.status(201).json({ token, organizationId: orgId, personId: headId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Organization name or email already in use' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to register organization' });
  } finally {
    client.release();
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  const { rows } = await pool.query(
    'SELECT id, password_hash, status FROM people WHERE email = $1',
    [email.toLowerCase()]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

  const person = rows[0];
  const valid = await bcrypt.compare(password, person.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  if (person.status !== 'active') return res.status(403).json({ error: 'Account is not active' });

  const token = jwt.sign({ sub: person.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });

  res.json({ token });
});

module.exports = router;
