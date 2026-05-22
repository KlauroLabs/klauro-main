import * as fs from 'fs-extra';
import * as path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface S3ArtifactUpload {
  localPath: string;
  key: string;
  contentType: string;
}

export async function mirrorArtifactsToS3(uploads: S3ArtifactUpload[]): Promise<Record<string, string>> {
  const bucket = process.env.UNRAVL_PROPOSAL_ARTIFACT_BUCKET || process.env.UNRAVL_ARTIFACT_BUCKET;
  if (!bucket || uploads.length === 0) return {};
  const client = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  const uris: Record<string, string> = {};

  for (const upload of uploads) {
    if (!(await fs.pathExists(upload.localPath))) continue;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: upload.key,
      Body: await fs.readFile(upload.localPath),
      ContentType: upload.contentType,
      ServerSideEncryption: 'AES256',
      Metadata: {
        source: 'unravl-proposal-preview',
      },
    }));
    uris[path.basename(upload.localPath)] = `s3://${bucket}/${upload.key}`;
  }

  return uris;
}
