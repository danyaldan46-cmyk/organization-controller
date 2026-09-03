import React, { useEffect, useState } from 'react';
import client from '../api/client';

const emptyForm = {
  scope: 'organization',
  roleTitle: '',
  personId: '',
  payType: 'hourly',
  baseRate: '',
  salaryPeriod: 'monthly',
  overtimeEnabled: true,
  overtimeThresholdHrs: 40,
  overtimeMultiplier: 1.5,
  flatBonus: '',
  perHourThreshold: '',
  perHourAmount: '',
};

export default function PayRules() {
  const [people, setPeople] = useState([]);
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  async function load() {
    try {
      const [{ data: peopleData }, { data: rulesData }] = await Promise.all([
        client.get('/people/tree'),
        client.get('/payroll/rules'),
      ]);
      setPeople(peopleData.people);
      setRules(rulesData.rules);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load pay rules');
    }
  }

  useEffect(() => { load(); }, []);

  const roleTitles = [...new Set(people.map((p) => p.role_title))];

  function update(field) {
    return (e) => {
      const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setForm((f) => ({ ...f, [field]: value }));
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const bonusRules = [];
    if (form.flatBonus !== '') {
      bonusRules.push({ type: 'flat', amount: Number(form.flatBonus) });
    }
    if (form.perHourThreshold !== '' && form.perHourAmount !== '') {
      bonusRules.push({
        type: 'per_hour_over',
        threshold: Number(form.perHourThreshold),
        amount: Number(form.perHourAmount),
      });
    }

    const payload = {
      scope: form.scope,
      payType: form.payType,
      baseRate: Number(form.baseRate),
      overtimeEnabled: form.overtimeEnabled,
      overtimeThresholdHrs: Number(form.overtimeThresholdHrs),
      overtimeMultiplier: Number(form.overtimeMultiplier),
      bonusRules,
    };
    if (form.scope === 'role') payload.roleTitle = form.roleTitle;
    if (form.scope === 'person') payload.personId = form.personId;
    if (form.payType === 'salary') payload.salaryPeriod = form.salaryPeriod;

    try {
      await client.post('/payroll/rules', payload);
      setSuccess('Pay rule created.');
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create pay rule');
    }
  }

  return (
    <div>
      <h1>Pay Rules</h1>
      <p style={{ color: 'var(--muted)' }}>
        Rules apply in order of specificity: person-specific overrides role-specific, which
        overrides the organization default. Role and organization rules can only be set by the Head.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="card" style={{ borderColor: 'var(--accent-2)', color: 'var(--accent-2)' }}>{success}</div>}

      <div className="card">
        <h3>New pay rule</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Scope</label>
            <select value={form.scope} onChange={update('scope')}>
              <option value="organization">Organization default</option>
              <option value="role">Role</option>
              <option value="person">Specific person</option>
            </select>
          </div>

          {form.scope === 'role' && (
            <div className="form-group">
              <label>Role title</label>
              <input
                list="role-options"
                value={form.roleTitle}
                onChange={update('roleTitle')}
                placeholder="e.g. Mathematics Teacher"
                required
              />
              <datalist id="role-options">
                {roleTitles.map((r) => <option key={r} value={r} />)}
              </datalist>
            </div>
          )}

          {form.scope === 'person' && (
            <div className="form-group">
              <label>Person</label>
              <select value={form.personId} onChange={update('personId')} required>
                <option value="" disabled>Select a person…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.role_title}</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Pay type</label>
              <select value={form.payType} onChange={update('payType')}>
                <option value="hourly">Hourly</option>
                <option value="salary">Salary</option>
              </select>
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>{form.payType === 'hourly' ? 'Rate per hour ($)' : 'Salary amount ($)'}</label>
              <input type="number" step="0.01" min="0" value={form.baseRate} onChange={update('baseRate')} required />
            </div>
            {form.payType === 'salary' && (
              <div className="form-group" style={{ flex: 1 }}>
                <label>Salary period</label>
                <select value={form.salaryPeriod} onChange={update('salaryPeriod')}>
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </select>
              </div>
            )}
          </div>

          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={form.overtimeEnabled}
                onChange={update('overtimeEnabled')}
                style={{ width: 'auto', marginRight: 8 }}
              />
              Enable overtime
            </label>
          </div>

          {form.overtimeEnabled && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Overtime threshold (hrs)</label>
                <input type="number" step="0.5" min="0" value={form.overtimeThresholdHrs} onChange={update('overtimeThresholdHrs')} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Overtime multiplier</label>
                <input type="number" step="0.1" min="1" value={form.overtimeMultiplier} onChange={update('overtimeMultiplier')} />
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Flat bonus per period ($, optional)</label>
            <input type="number" step="0.01" min="0" value={form.flatBonus} onChange={update('flatBonus')} placeholder="e.g. 100" />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Bonus: hours-over threshold (optional)</label>
              <input type="number" step="0.5" min="0" value={form.perHourThreshold} onChange={update('perHourThreshold')} placeholder="e.g. 160" />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Bonus: $ per hour over threshold</label>
              <input type="number" step="0.01" min="0" value={form.perHourAmount} onChange={update('perHourAmount')} placeholder="e.g. 5" />
            </div>
          </div>

          <button type="submit">Create pay rule</button>
        </form>
      </div>

      <div className="card">
        <h3>Existing rules</h3>
        {rules.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No pay rules yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Scope</th><th>Applies to</th><th>Type</th><th>Rate</th><th>Overtime</th><th>Bonus</th><th>Effective from</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td><span className="pill">{r.scope}</span></td>
                  <td>{r.scope === 'role' ? r.role_title : r.scope === 'person' ? r.person_name : 'Everyone'}</td>
                  <td>{r.pay_type}</td>
                  <td>${r.base_rate}{r.pay_type === 'salary' ? ` / ${r.salary_period}` : '/hr'}</td>
                  <td>{r.overtime_enabled ? `${r.overtime_threshold_hrs}hrs @ ${r.overtime_multiplier}x` : '—'}</td>
                  <td>{(r.bonus_rules || []).length > 0 ? `${r.bonus_rules.length} rule(s)` : '—'}</td>
                  <td>{r.effective_from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
