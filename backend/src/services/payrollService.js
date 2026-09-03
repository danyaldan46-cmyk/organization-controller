/**
 * Resolves the applicable pay rule for a person, in precedence order:
 *   1. person-specific rule (scope='person', person_id = them)
 *   2. role-specific rule   (scope='role', role_title = their current title)
 *   3. organization default (scope='organization')
 * Only rules whose effective date range covers `asOfDate` are considered.
 * Ties within a scope are broken by most recent effective_from.
 */
async function resolvePayRule(client, { orgId, personId, roleTitle, asOfDate }) {
  const { rows } = await client.query(
    `SELECT * FROM pay_rules
     WHERE organization_id = $1
       AND effective_from <= $2
       AND (effective_to IS NULL OR effective_to >= $2)
       AND (
         (scope = 'person' AND person_id = $3) OR
         (scope = 'role' AND role_title = $4) OR
         (scope = 'organization')
       )
     ORDER BY
       CASE scope WHEN 'person' THEN 0 WHEN 'role' THEN 1 ELSE 2 END,
       effective_from DESC
     LIMIT 1`,
    [orgId, asOfDate, personId, roleTitle]
  );
  return rows[0] || null;
}

/**
 * Applies a rule's bonus_rules array to a computed hours/pay summary.
 * Supported bonus types (extend as needed):
 *   - { type: 'flat', amount }                         — fixed amount per period
 *   - { type: 'per_hour_over', threshold, amount }      — amount per hour worked beyond threshold
 */
function computeBonus(bonusRules, { totalHours }) {
  let bonus = 0;
  for (const rule of bonusRules || []) {
    if (rule.type === 'flat') {
      bonus += Number(rule.amount) || 0;
    } else if (rule.type === 'per_hour_over') {
      const extra = Math.max(0, totalHours - Number(rule.threshold || 0));
      bonus += extra * (Number(rule.amount) || 0);
    }
  }
  return bonus;
}

/**
 * Computes pay for one person over [periodStart, periodEnd] (inclusive dates)
 * from their logged task_entries and their resolved pay rule.
 */
async function computePayrollForPerson(client, { orgId, personId, roleTitle, periodStart, periodEnd }) {
  const rule = await resolvePayRule(client, { orgId, personId, roleTitle, asOfDate: periodEnd });
  if (!rule) {
    return { error: 'No applicable pay rule found', personId };
  }

  const { rows } = await client.query(
    `SELECT COALESCE(SUM(duration_minutes), 0) AS total_minutes
     FROM task_entries
     WHERE organization_id = $1 AND person_id = $2
       AND start_time::date >= $3 AND start_time::date <= $4`,
    [orgId, personId, periodStart, periodEnd]
  );
  const totalHours = Number(rows[0].total_minutes) / 60;

  let regularHours = totalHours;
  let overtimeHours = 0;
  let basePay = 0;
  let overtimePay = 0;

  if (rule.pay_type === 'hourly') {
    if (rule.overtime_enabled && totalHours > Number(rule.overtime_threshold_hrs)) {
      regularHours = Number(rule.overtime_threshold_hrs);
      overtimeHours = totalHours - regularHours;
    }
    basePay = regularHours * Number(rule.base_rate);
    overtimePay = overtimeHours * Number(rule.base_rate) * Number(rule.overtime_multiplier || 1.5);
  } else {
    // salary: base pay is the configured amount regardless of hours logged,
    // but overtime can still apply on top if enabled (e.g. salaried staff
    // who also get paid extra for covering additional shifts).
    basePay = Number(rule.base_rate);
    if (rule.overtime_enabled && totalHours > Number(rule.overtime_threshold_hrs)) {
      overtimeHours = totalHours - Number(rule.overtime_threshold_hrs);
      const impliedHourlyRate = Number(rule.base_rate) / Number(rule.overtime_threshold_hrs || 1);
      overtimePay = overtimeHours * impliedHourlyRate * Number(rule.overtime_multiplier || 1.5);
    }
    regularHours = totalHours - overtimeHours;
  }

  const bonusPay = computeBonus(rule.bonus_rules, { totalHours });

  return {
    personId,
    ruleId: rule.id,
    regularHours: Number(regularHours.toFixed(2)),
    overtimeHours: Number(overtimeHours.toFixed(2)),
    basePay: Number(basePay.toFixed(2)),
    overtimePay: Number(overtimePay.toFixed(2)),
    bonusPay: Number(bonusPay.toFixed(2)),
    totalPay: Number((basePay + overtimePay + bonusPay).toFixed(2)),
  };
}

module.exports = { resolvePayRule, computeBonus, computePayrollForPerson };
