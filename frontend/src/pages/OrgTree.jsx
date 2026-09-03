import React, { useEffect, useState } from 'react';
import client from '../api/client';
import TreeView from '../components/TreeView.jsx';

export default function OrgTree() {
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [addingUnder, setAddingUnder] = useState(null); // person object or null
  const [form, setForm] = useState({ name: '', roleTitle: '', email: '', password: '' });

  async function load() {
    try {
      const { data } = await client.get('/people/tree');
      setPeople(data.people);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load hierarchy');
    }
  }

  useEffect(() => { load(); }, []);

  async function handleAddSubmit(e) {
    e.preventDefault();
    try {
      await client.post('/people', { parentId: addingUnder.id, ...form });
      setAddingUnder(null);
      setForm({ name: '', roleTitle: '', email: '', password: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add person');
    }
  }

  return (
    <div>
      <h1>Organization Hierarchy</h1>
      <p style={{ color: 'var(--muted)' }}>
        You see yourself and everyone below you in the tree. Click a name to view their profile.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {people.length === 0 ? <p>Loading…</p> : <TreeView people={people} onAddChild={setAddingUnder} />}
      </div>

      {addingUnder && (
        <div className="card">
          <h3>Add subordinate under {addingUnder.name}</h3>
          <form onSubmit={handleAddSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Role title</label>
              <input value={form.roleTitle} onChange={(e) => setForm({ ...form, roleTitle: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Temporary password</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
            </div>
            <button type="submit">Add</button>{' '}
            <button type="button" className="secondary" onClick={() => setAddingUnder(null)}>Cancel</button>
          </form>
        </div>
      )}
    </div>
  );
}
