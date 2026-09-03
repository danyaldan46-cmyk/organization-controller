import React, { useEffect, useState } from 'react';
import client from '../api/client';

export default function TaskLog() {
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState({ description: '', startTime: '', endTime: '' });
  const [error, setError] = useState(null);

  async function load() {
    try {
      const { data } = await client.get('/tasks/me');
      setEntries(data.entries);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load tasks');
    }
  }

  useEffect(() => { load(); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      await client.post('/tasks', {
        description: form.description,
        startTime: new Date(form.startTime).toISOString(),
        endTime: new Date(form.endTime).toISOString(),
      });
      setForm({ description: '', startTime: '', endTime: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to log task');
    }
  }

  return (
    <div>
      <h1>Task / Duty Log</h1>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h3>Log a new entry</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Description</label>
            <input
              placeholder="Took Mathematics class, Grade 10"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              required
            />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Start time</label>
              <input type="datetime-local" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>End time</label>
              <input type="datetime-local" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} required />
            </div>
          </div>
          <button type="submit">Log entry</button>
        </form>
      </div>

      <div className="card">
        <h3>My recent entries</h3>
        <table>
          <thead>
            <tr><th>Description</th><th>Start</th><th>End</th><th>Duration</th><th>Logged at</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.description}</td>
                <td>{new Date(e.start_time).toLocaleString()}</td>
                <td>{new Date(e.end_time).toLocaleString()}</td>
                <td>{(e.duration_minutes / 60).toFixed(2)} hrs</td>
                <td>{new Date(e.logged_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
