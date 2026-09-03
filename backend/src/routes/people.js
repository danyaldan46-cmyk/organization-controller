const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { assertCanAccessPerson, assertCanManagePerson, visibleSubtreeClause } = require('../utils/permissions');

const router = express.Router();

// GET /people/tree — the requester's visible subtree (self + all descendants),
// shaped as a flat list with parent_id so the frontend can render it as a tree.
router.get('/tree', async (req, res) => {
  const { orgId, id: requesterId, path, isHead } = req.user;

  const query = isHead
      ? `SELECT id, parent_id, role_title, name, email, status, path::text AS path
         FROM people WHERE organization_id = $1 ORDER BY path`
      : `SELECT id, parent_id, role_title, name, email, status, path::text AS path
         FROM people WHERE organization_id = $1 AND ${visibleSubtreeClause(2)} ORDER BY path`;

  const params = isHead ? [orgId] : [orgId, path];
  const { rows } = await pool.query(query, params);
  res.json({ people: rows });
});

const createPersonSchema = z.object({
  parentId: z.string().uuid(),
  name: z.string().min(1),
  roleTitle: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

// POST /people — add a subordinate anywhere in the requester's visible subtree.
router.post('/', async (req, res) => {
  const parsed = createPersonSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { parentId, name, roleTitle, email, password } = parsed.data;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);

    // Can the requester manage the proposed parent? (must be self or a descendant)
    await assertCanManagePerson(client, {
      requesterId, requesterPath, isHead, targetPersonId: parentId,
    });

    const parentRes = await client.query('SELECT path FROM people WHERE id = $1 AND organization_id = $2', [parentId, orgId]);
    if (parentRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parent not found' });
    }
    const parentPath = parentRes.rows[0].path;

    const passwordHash = await bcrypt.hash(password, 10);

    const insertRes = await client.query(
        `INSERT INTO people (organization_id, parent_id, path, role_title, name, email, password_hash)
         VALUES ($1, $2, 'root', $3, $4, $5, $6) RETURNING id`,
        [orgId, parentId, roleTitle, name, email.toLowerCase(), passwordHash]
    );
    const newId = insertRes.rows[0].id;

    await client.query(
        `UPDATE people SET path = ($1::text || '.' || replace($2::text,'-',''))::ltree WHERE id = $2`,
        [parentPath, newId]
    );

    await client.query('COMMIT');
    res.status(201).json({ id: newId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create person' });
  } finally {
    client.release();
  }
});

const moveSchema = z.object({ newParentId: z.string().uuid() });

// PATCH /people/:id/move — reparent a person (and their whole subtree).
// Rewrites path for the person and every descendant in one statement.
router.patch('/:id/move', async (req, res) => {
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { id: targetId } = req.params;
  const { newParentId } = parsed.data;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);

    // Requester must manage both the person being moved and the new parent.
    await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: targetId });
    await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: newParentId });

    const [{ rows: targetRows }, { rows: parentRows }] = await Promise.all([
      client.query('SELECT path FROM people WHERE id = $1 AND organization_id = $2', [targetId, orgId]),
      client.query('SELECT path FROM people WHERE id = $1 AND organization_id = $2', [newParentId, orgId]),
    ]);
    if (targetRows.length === 0 || parentRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Person not found' });
    }
    const oldPath = targetRows[0].path;
    const newParentPath = parentRows[0].path;

    if (newParentPath === oldPath || newParentPath.startsWith(oldPath + '.')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot move a person under their own descendant' });
    }

    const newPath = `${newParentPath}.${targetId.replace(/-/g, '')}`;

    // Rewrite target + all descendants: replace the old path prefix with the new one.
    await client.query(
        `UPDATE people
         SET path = ($1::text || subpath(path, nlevel($2::ltree) - 1))::ltree,
           parent_id = CASE WHEN id = $3 THEN $4 ELSE parent_id END
       WHERE organization_id = $5 AND path <@ $2::ltree`,
        [newPath, oldPath, targetId, newParentId, orgId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to move person' });
  } finally {
    client.release();
  }
});

// GET /people/:id/profile — visible only if within requester's subtree (or self).
router.get('/:id/profile', async (req, res) => {
  const { id: targetId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId: targetId });

    const { rows } = await client.query(
        `SELECT p.id, p.name, p.role_title, p.email, pr.qualifications, pr.experience, pr.bio, pr.phone
         FROM people p LEFT JOIN profiles pr ON pr.person_id = p.id
         WHERE p.id = $1`,
        [targetId]
    );
    await client.query('COMMIT');
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  } finally {
    client.release();
  }
});

const updateRoleSchema = z.object({ roleTitle: z.string().min(1) });

router.patch('/:id/role', async (req, res) => {
  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { id: targetId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: targetId });
    await client.query('UPDATE people SET role_title = $1, updated_at = now() WHERE id = $2', [parsed.data.roleTitle, targetId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to update role' });
  } finally {
    client.release();
  }
});

module.exports = router;
