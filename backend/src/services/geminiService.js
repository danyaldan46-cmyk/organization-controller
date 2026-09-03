const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const EXTRACTION_PROMPT = `You are extracting structured data from a CV/resume for an HR system.
Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "name": "string",
  "email": "string or null",
  "phone": "string or null",
  "qualifications": [ { "degree": "string", "institution": "string", "year": "string or null" } ],
  "experience": [ { "title": "string", "organization": "string", "start": "string or null", "end": "string or null", "description": "string or null" } ]
}

If a field cannot be determined, use null or an empty array. Do not invent information not present in the document.`;

/**
 * Sends CV file bytes to Gemini and returns parsed structured data.
 * This ALWAYS produces a draft for human review — nothing here writes
 * directly to a person's profile. See cv_import_drafts table + routes/cv.js.
 */
async function extractCvData(fileBuffer, mimeType) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await model.generateContent([
    { inlineData: { data: fileBuffer.toString('base64'), mimeType } },
    { text: EXTRACTION_PROMPT },
  ]);

  const text = result.response.text().trim();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Gemini did not return valid JSON: ' + text.slice(0, 200));
  }
  return parsed;
}

module.exports = { extractCvData };
