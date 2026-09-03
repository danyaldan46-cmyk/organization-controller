import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../api/client';

export default function Payroll() {
  const [people, setPeople] = useState([]);
  const [personId, setPersonId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    client.get('/people/tree').then(({ data }) => setPeople(data.people)).catch(() => {});
  }, []);

  async function handleCompute(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      const { data } = await client.post('/payroll/compute', {
        personId, periodStart, periodEnd, persist: true,
      });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to compute payroll');
    }
  }

  return (
      <div>
        <h1>Payroll Calculator</h1>
        <p style={{ color: 'var(--muted)' }}>
          Computes pay from logged hours using the applicable pay rule
          (person-specific &gt; role-specific &gt; organization default).
          No rule for someone yet? <Link to="/pay-rules">Set one up here</Link>.
        </p>
        {error && <div className="error-banner">{error}</div>}

        <div className="card">
          <form onSubmit={handleCompute}>
            <div className="form-group">
              <label>Person</label>
              <select value={personId} onChange={(e) => setPersonId(e.target.value)} required>
                <option value="" disabled>Select a person…</option>
                {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} — {p.role_title}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Period start</label>
                <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Period end</label>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
              </div>
            </div>
            <button type="submit">Compute & save</button>
          </form>
        </div>

        {result && (
            <div className="card">
              <h3>Result</h3>
              <table>
                <tbody>
                <tr><td>Regular hours</td><td>{result.regularHours}</td></tr>
                <tr><td>Overtime hours</td><td>{result.overtimeHours}</td></tr>
                <tr><td>Base pay</td><td>${result.basePay}</td></tr>
                <tr><td>Overtime pay</td><td>${result.overtimePay}</td></tr>
                <tr><td>Bonus pay</td><td>${result.bonusPay}</td></tr>
                <tr><td><strong>Total pay</strong></td><td><strong>${result.totalPay}</strong></td></tr>
                </tbody>
              </table>
            </div>
        )}
      </div>
  );
}
