const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

/**
 * Verifies the JWT, then re-reads the person's current path/role/status
 * from the DB on every request (not just at login) so that a demotion,
 * move in the tree, or suspension takes effect immediately — permissions
 * are always computed from *current* hierarchy position, per the spec,
 * not from a stale claim baked into the token at login time.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      `SELECT id, organization_id, path, role_title, name, email, is_head, status
       FROM people WHERE id = $1`,
      [payload.sub]
    );

    if (rows.length === 0) return res.status(401).json({ error: 'Account not found' });
    const person = rows[0];
    if (person.status !== 'active') return res.status(403).json({ error: 'Account is not active' });

    req.user = {
      id: person.id,
      orgId: person.organization_id,
      path: person.path,
      roleTitle: person.role_title,
      name: person.name,
      email: person.email,
      isHead: person.is_head,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate };
