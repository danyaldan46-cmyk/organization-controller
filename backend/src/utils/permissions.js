/**
 * Hierarchy-based access control.
 *
 * The rule from the spec: a person can see themselves and everyone
 * BELOW them in the tree. Never above, never sideways.
 *
 * Implementation: every person row has a materialized `path` (ltree),
 * e.g. 'head_id.vp_id.teacher_id'. "Is X in Y's visible set?" becomes
 * a single indexed query: X.path <@ Y.path  (ltree "descendant-of-or-equal").
 *
 * We centralize every subtree check here so there is exactly one place
 * that can get this wrong, and it's unit-testable in isolation from
 * routes/HTTP concerns.
 */

/**
 * Returns true if `targetPath` is the same person as, or a descendant of,
 * `requesterPath`. Both are ltree strings like '1234.5678'.
 */
function isSelfOrDescendant(requesterPath, targetPath) {
  return targetPath === requesterPath || targetPath.startsWith(requesterPath + '.');
}

/**
 * SQL fragment + param for "give me every row visible to this requester".
 * Use with a query like:
 *   SELECT * FROM people WHERE organization_id = $1 AND path <@ $2::ltree
 */
function visibleSubtreeClause(paramIndex) {
  return `path <@ $${paramIndex}::ltree`;
}

/**
 * Fetches the requester's own row (id, path, is_head) and asserts the
 * target person_id is within their visible subtree. Throws a 403-flavored
 * error if not. Call this at the top of any route that reads/writes a
 * specific person's data (profile, tasks, payroll, documents).
 */
async function assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId }) {
  if (isHead) return; // Head sees everyone in the org — no further check needed.

  if (requesterId === targetPersonId) return; // always see self

  const { rows } = await client.query(
    'SELECT path FROM people WHERE id = $1',
    [targetPersonId]
  );
  if (rows.length === 0) {
    const err = new Error('Person not found');
    err.status = 404;
    throw err;
  }

  if (!isSelfOrDescendant(requesterPath, rows[0].path)) {
    const err = new Error('Forbidden: outside your visible hierarchy');
    err.status = 403;
    throw err;
  }
}

/**
 * Returns true if `requesterId` is a direct or indirect manager of
 * `targetPersonId` — i.e. allowed to edit them (move in tree, change role,
 * set pay rules), as opposed to merely viewing. Same subtree rule applies;
 * kept as a separate function name so route code reads intention clearly
 * and so write-vs-read permissions can diverge later without confusion.
 */
async function assertCanManagePerson(client, ctx) {
  return assertCanAccessPerson(client, ctx);
}

module.exports = {
  isSelfOrDescendant,
  visibleSubtreeClause,
  assertCanAccessPerson,
  assertCanManagePerson,
};
