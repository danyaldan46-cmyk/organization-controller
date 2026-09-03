const express = require('express');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { assertCanAccessPerson, assertCanManagePerson } = require('../utils/permissions');
const { computePayrollForPerson } = require('../services/payrollService');

const router = express.Router();

const computeSchema = z.object({
  personId: z.string().uuid(),
  periodStart: z.string(), // YYYY-MM-DD
  periodEnd: z.string(),
  persist: z.boolean().optional().default(false),
});

// POST /payroll/compute — compute (and optionally save) pay for one person.
router.post('/compute', async (req, res) => {
  const parsed = computeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { personId, periodStart, periodEnd, persist } = parsed.data;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId: personId });

    const { rows: personRows } = await client.query('SELECT role_title FROM people WHERE id = $1', [personId]);
    if (personRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Person not found' });
    }

    const result = await computePayrollForPerson(client, {
      orgId, personId, roleTitle: personRows[0].role_title, periodStart, periodEnd,
    });

    if (result.error) {
      await client.query('ROLLBACK');
      return res.status(422).json(result);
    }

    if (persist) {
      await client.query(
          `INSERT INTO payroll_runs
           (organization_id, person_id, period_start, period_end, regular_hours, overtime_hours, base_pay, overtime_pay, bonus_pay, pay_rule_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (organization_id, person_id, period_start, period_end)
         DO UPDATE SET regular_hours=$5, overtime_hours=$6, base_pay=$7, overtime_pay=$8, bonus_pay=$9, pay_rule_id=$10, computed_at=now()`,
          [orgId, personId, periodStart, periodEnd, result.regularHours, result.overtimeHours, result.basePay, result.overtimePay, result.bonusPay, result.ruleId]
      );
    }

    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to compute payroll' });
  } finally {
    client.release();
  }
});

// GET /payroll/history/:personId — saved payroll runs for a person.
router.get('/history/:personId', async (req, res) => {
  const { personId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId: personId });
    const { rows } = await client.query(
        `SELECT period_start, period_end, regular_hours, overtime_hours, base_pay, overtime_pay, bonus_pay, total_pay, computed_at
       FROM payroll_runs WHERE organization_id = $1 AND person_id = $2 ORDER BY period_start DESC`,
        [orgId, personId]
    );
    await client.query('COMMIT');
    res.json({ runs: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payroll history' });
  } finally {
    client.release();
  }
});

// GET /payroll/rules — list pay rules the requester is allowed to see.
// Head sees every rule in the organization. A non-Head sees organization-
// and role-scoped rules (informational — they apply broadly) plus any
// person-scoped rule where the target person is in their visible subtree.
router.get('/rules', async (req, res) => {
  const { orgId, path, isHead } = req.user;

  const query = isHead
      ? `SELECT pr.id, pr.scope, pr.role_title, pr.person_id, p.name AS person_name,
              pr.pay_type, pr.base_rate, pr.salary_period, pr.overtime_enabled,
              pr.overtime_threshold_hrs, pr.overtime_multiplier, pr.bonus_rules,
              pr.effective_from, pr.effective_to
       FROM pay_rules pr LEFT JOIN people p ON p.id = pr.person_id
       WHERE pr.organization_id = $1
       ORDER BY pr.scope, pr.effective_from DESC`
      : `SELECT pr.id, pr.scope, pr.role_title, pr.person_id, p.name AS person_name,
              pr.pay_type, pr.base_rate, pr.salary_period, pr.overtime_enabled,
              pr.overtime_threshold_hrs, pr.overtime_multiplier, pr.bonus_rules,
              pr.effective_from, pr.effective_to
       FROM pay_rules pr LEFT JOIN people p ON p.id = pr.person_id
       WHERE pr.organization_id = $1
         AND (pr.scope IN ('organization','role') OR (pr.scope = 'person' AND p.path <@ $2::ltree))
       ORDER BY pr.scope, pr.effective_from DESC`;

  const params = isHead ? [orgId] : [orgId, path];
  const { rows } = await pool.query(query, params);
  res.json({ rules: rows });
});

const payRuleSchema = z.object({
  scope: z.enum(['organization', 'role', 'person']),
  roleTitle: z.string().optional(),
  personId: z.string().uuid().optional(),
  payType: z.enum(['hourly', 'salary']),
  baseRate: z.number().nonnegative(),
  salaryPeriod: z.enum(['monthly', 'annual']).optional(),
  overtimeEnabled: z.boolean().default(false),
  overtimeThresholdHrs: z.number().positive().optional(),
  overtimeMultiplier: z.number().positive().optional(),
  bonusRules: z.array(z.record(z.any())).optional().default([]),
  effectiveFrom: z.string().optional(),
});

// POST /payroll/rules — create a pay rule at org, role, or person scope.
// Only Head or a manager of the target person may set a person-scoped rule;
// role/org scoped rules are restricted to Head to avoid a mid-tree manager
// silently repricing an entire role across the organization.
router.post('/rules', async (req, res) => {
  const parsed = payRuleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  if (data.scope !== 'person' && !isHead) {
    return res.status(403).json({ error: 'Only the organization Head can set role- or organization-wide pay rules' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);

    if (data.scope === 'person') {
      await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: data.personId });
    }

    const { rows } = await client.query(
        `INSERT INTO pay_rules
        (organization_id, scope, role_title, person_id, pay_type, base_rate, salary_period,
         overtime_enabled, overtime_threshold_hrs, overtime_multiplier, bonus_rules, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, CURRENT_DATE))
       RETURNING id`,
        [orgId, data.scope, data.roleTitle || null, data.personId || null, data.payType, data.baseRate,
          data.salaryPeriod || null, data.overtimeEnabled, data.overtimeThresholdHrs || 40,
          data.overtimeMultiplier || 1.5, JSON.stringify(data.bonusRules || []), data.effectiveFrom || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to create pay rule' });
  } finally {
    client.release();
  }
});

module.exports = router;
