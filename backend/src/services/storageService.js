const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('crypto');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;

/**
 * Uploads a document scoped under the organization + person, so keys are
 * naturally namespaced per tenant even though the bucket itself is shared
 * infrastructure. Combined with DB-level org_id checks before ever handing
 * out a key, this keeps one tenant from guessing another's file paths.
 */
async function uploadDocument({ orgId, personId, originalFilename, buffer, mimeType }) {
  const key = `orgs/${orgId}/people/${personId}/documents/${randomUUID()}-${originalFilename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return key;
}

async function getDownloadUrl(key, expiresInSeconds = 300) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

module.exports = { uploadDocument, getDownloadUrl };
