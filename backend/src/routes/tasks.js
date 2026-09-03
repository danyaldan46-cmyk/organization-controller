const express = require('express');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { assertCanAccessPerson, visibleSubtreeClause } = require('../utils/permissions');

const router = express.Router();

const logSchema = z.object({
  description: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});

// POST /tasks — a person logs their own entry. start/end are user-supplied
// (the actual class times), but `logged_at` is stamped by the DB default
// and is never accepted from the request body — that's the "not user
// editable" audit trail the spec calls for.
router.post('/', async (req, res) => {
  const parsed = logSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { description, startTime, endTime } = parsed.data;
  const { orgId, id: personId } = req.user;

  if (new Date(endTime) <= new Date(startTime)) {
    return res.status(400).json({ error: 'endTime must be after startTime' });
  }

  const { rows } = await pool.query(
      `INSERT INTO task_entries (organization_id, person_id, description, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)
         RETURNING id, description, start_time, end_time, duration_minutes, logged_at`,
      [orgId, personId, description, startTime, endTime]
  );
  res.status(201).json(rows[0]);
});

// GET /tasks/me — the requester's own log.
router.get('/me', async (req, res) => {
  const { orgId, id: personId } = req.user;
  const { rows } = await pool.query(
      `SELECT id, description, start_time, end_time, duration_minutes, logged_at
       FROM task_entries WHERE organization_id = $1 AND person_id = $2
       ORDER BY start_time DESC LIMIT 200`,
      [orgId, personId]
  );
  res.json({ entries: rows });
});

// GET /tasks/person/:id — view someone else's log, only if in visible subtree.
router.get('/person/:id', async (req, res) => {
  const { id: targetId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId: targetId });
    const { rows } = await client.query(
        `SELECT id, description, start_time, end_time, duration_minutes, logged_at
         FROM task_entries WHERE organization_id = $1 AND person_id = $2
         ORDER BY start_time DESC LIMIT 200`,
        [orgId, targetId]
    );
    await client.query('COMMIT');
    res.json({ entries: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  } finally {
    client.release();
  }
});

// GET /tasks/subtree — every task entry across the requester's whole
// visible subtree, useful for a manager's dashboard view.
router.get('/subtree', async (req, res) => {
  const { orgId, path, isHead } = req.user;
  const query = isHead
      ? `SELECT t.id, t.person_id, p.name AS person_name, t.description, t.start_time, t.end_time, t.duration_minutes
         FROM task_entries t JOIN people p ON p.id = t.person_id
         WHERE t.organization_id = $1 ORDER BY t.start_time DESC LIMIT 500`
      : `SELECT t.id, t.person_id, p.name AS person_name, t.description, t.start_time, t.end_time, t.duration_minutes
         FROM task_entries t JOIN people p ON p.id = t.person_id
         WHERE t.organization_id = $1 AND ${visibleSubtreeClause(2)}
         ORDER BY t.start_time DESC LIMIT 500`;
  const params = isHead ? [orgId] : [orgId, path];
  const { rows } = await pool.query(query, params);
  res.json({ entries: rows });
});

module.exports = router;
