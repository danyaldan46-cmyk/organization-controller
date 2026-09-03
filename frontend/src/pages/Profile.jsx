import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import client from '../api/client';

export default function Profile() {
  const { id } = useParams();
  const [profile, setProfile] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const personId = id === 'me' ? null : id; // 'me' resolved server-side via /tasks/me pattern; profile route needs real id

  useEffect(() => {
    if (!personId) return; // "me" needs the requester's own id — see note below
    load();
  }, [personId]);

  async function load() {
    try {
      const [{ data: p }, { data: d }] = await Promise.all([
        client.get(`/people/${personId}/profile`),
        client.get(`/cv/${personId}/drafts`),
      ]);
      setProfile(p);
      setDrafts(d.drafts);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load profile');
    }
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      await client.post(`/cv/${personId}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function confirmDraft(draftId, data) {
    try {
      await client.post(`/cv/drafts/${draftId}/confirm`, {
        qualifications: data.qualifications,
        experience: data.experience,
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to confirm draft');
    }
  }

  if (id === 'me') {
    return (
      <div className="card">
        <p style={{ color: 'var(--muted)' }}>
          Open your profile from the hierarchy view (click your own name) to see this page with your real ID.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1>Profile</h1>
      {error && <div className="error-banner">{error}</div>}
      {profile && (
        <div className="card">
          <h2>{profile.name}</h2>
          <p className="pill">{profile.role_title}</p>
          <p>{profile.email}</p>
          {profile.bio && <p>{profile.bio}</p>}

          <h3>Qualifications</h3>
          <ul>
            {(profile.qualifications || []).map((q, i) => (
              <li key={i}>{q.degree} — {q.institution} ({q.year || 'n/a'})</li>
            ))}
          </ul>

          <h3>Experience</h3>
          <ul>
            {(profile.experience || []).map((exp, i) => (
              <li key={i}>{exp.title} at {exp.organization} ({exp.start || '?'}–{exp.end || 'present'})</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h3>Import CV</h3>
        <form onSubmit={handleUpload}>
          <div className="form-group">
            <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files[0])} />
          </div>
          <button type="submit" disabled={uploading}>{uploading ? 'Processing…' : 'Upload & extract with AI'}</button>
        </form>
      </div>

      {drafts.filter((d) => d.status === 'pending').map((draft) => (
        <div className="card" key={draft.id}>
          <h3>Pending CV import — review before confirming</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{JSON.stringify(draft.extracted_data, null, 2)}</pre>
          <button onClick={() => confirmDraft(draft.id, draft.extracted_data)}>Confirm into profile</button>
        </div>
      ))}
    </div>
  );
}
