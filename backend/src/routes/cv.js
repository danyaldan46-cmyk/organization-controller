const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { pool } = require('../db/pool');
const { assertCanAccessPerson, assertCanManagePerson } = require('../utils/permissions');
const { extractCvData } = require('../services/geminiService');
const { uploadDocument, getDownloadUrl } = require('../services/storageService');

const router = express.Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB cap

// POST /cv/:personId/upload — upload a CV file, store it, run Gemini extraction,
// and save the result as a pending draft. Nothing touches the real profile yet.
router.post('/:personId/upload', upload.single('file'), async (req, res) => {
  const { personId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: personId });

    const storageKey = await uploadDocument({
      orgId, personId,
      originalFilename: req.file.originalname,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });

    const docRes = await client.query(
        `INSERT INTO documents (organization_id, person_id, kind, storage_key, original_filename, mime_type, uploaded_by)
         VALUES ($1,$2,'cv',$3,$4,$5,$6) RETURNING id`,
        [orgId, personId, storageKey, req.file.originalname, req.file.mimetype, requesterId]
    );
    const documentId = docRes.rows[0].id;

    let extracted;
    try {
      extracted = await extractCvData(req.file.buffer, req.file.mimetype);
    } catch (aiErr) {
      // The file is safely stored even if extraction fails — the person
      // can retry extraction or enter data manually.
      await client.query('COMMIT');
      return res.status(502).json({
        error: 'CV stored, but AI extraction failed. You can retry or enter details manually.',
        documentId,
        detail: aiErr.message,
      });
    }

    const draftRes = await client.query(
        `INSERT INTO cv_import_drafts (organization_id, person_id, document_id, extracted_data)
         VALUES ($1,$2,$3,$4) RETURNING id, extracted_data`,
        [orgId, personId, documentId, JSON.stringify(extracted)]
    );

    await client.query('COMMIT');
    res.status(201).json({ documentId, draft: draftRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to process CV' });
  } finally {
    client.release();
  }
});

// GET /cv/:personId/drafts — pending drafts awaiting confirmation.
router.get('/:personId/drafts', async (req, res) => {
  const { personId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
    await assertCanAccessPerson(client, { requesterId, requesterPath, isHead, targetPersonId: personId });
    const { rows } = await client.query(
        `SELECT id, extracted_data, status, created_at FROM cv_import_drafts
         WHERE organization_id = $1 AND person_id = $2 ORDER BY created_at DESC`,
        [orgId, personId]
    );
    await client.query('COMMIT');
    res.json({ drafts: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch drafts' });
  } finally {
    client.release();
  }
});

const confirmSchema = z.object({
  qualifications: z.array(z.record(z.any())).optional(),
  experience: z.array(z.record(z.any())).optional(),
  bio: z.string().optional(),
  phone: z.string().optional(),
});

// POST /cv/drafts/:draftId/confirm — the person (or a manager) reviews the
// AI-extracted draft, edits anything wrong, and confirms it into their
// real profile. This is the ONLY path that writes to `profiles` from CV data.
router.post('/drafts/:draftId/confirm', async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { draftId } = req.params;
  const { orgId, id: requesterId, path: requesterPath, isHead } = req.user;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);

    const { rows: draftRows } = await client.query(
        'SELECT person_id, extracted_data, status FROM cv_import_drafts WHERE id = $1 AND organization_id = $2',
        [draftId, orgId]
    );
    if (draftRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Draft not found' });
    }
    const draft = draftRows[0];
    if (draft.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Draft already ${draft.status}` });
    }

    await assertCanManagePerson(client, { requesterId, requesterPath, isHead, targetPersonId: draft.person_id });

    const finalQuals = parsed.data.qualifications ?? draft.extracted_data.qualifications ?? [];
    const finalExp = parsed.data.experience ?? draft.extracted_data.experience ?? [];

    await client.query(
        `INSERT INTO profiles (person_id, organization_id, qualifications, experience, bio, phone, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (person_id) DO UPDATE SET
          qualifications = $3, experience = $4,
                                        bio = COALESCE($5, profiles.bio), phone = COALESCE($6, profiles.phone),
                                        updated_at = now()`,
        [draft.person_id, orgId, JSON.stringify(finalQuals), JSON.stringify(finalExp), parsed.data.bio || null, parsed.data.phone || null]
    );

    await client.query(
        `UPDATE cv_import_drafts SET status = 'confirmed', reviewed_at = now(), reviewed_by = $1 WHERE id = $2`,
        [requesterId, draftId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm draft' });
  } finally {
    client.release();
  }
});

module.exports = router;
