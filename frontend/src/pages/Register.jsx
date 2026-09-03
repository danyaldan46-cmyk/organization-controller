import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import client from '../api/client';

export default function Register() {
  const [form, setForm] = useState({
    organizationName: '', headName: '', headTitle: 'Head', email: '', password: '',
  });
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await client.post('/auth/register-organization', form);
      localStorage.setItem('token', data.token);
      navigate('/tree');
    } catch (err) {
      setError(JSON.stringify(err.response?.data?.error) || 'Registration failed');
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <form className="card" style={{ width: 400 }} onSubmit={handleSubmit}>
        <h2>Register your organization</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="form-group">
          <label>Organization name</label>
          <input value={form.organizationName} onChange={update('organizationName')} required />
        </div>
        <div className="form-group">
          <label>Your name (Head of organization)</label>
          <input value={form.headName} onChange={update('headName')} required />
        </div>
        <div className="form-group">
          <label>Your title</label>
          <input value={form.headTitle} onChange={update('headTitle')} />
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={form.email} onChange={update('email')} required />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={form.password} onChange={update('password')} required minLength={8} />
        </div>
        <button type="submit" style={{ width: '100%' }}>Create organization</button>
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--muted)' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
