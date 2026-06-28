import * as fs from 'fs-extra';
import * as path from 'node:path';
import { PutObjectCommand, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';

export interface S3ArtifactUpload {
  localPath: string;
  key: string;
  contentType: string;
}

export async function mirrorArtifactsToS3(uploads: S3ArtifactUpload[]): Promise<Record<string, string>> {
  const bucket = process.env.KLAURO_PROPOSAL_ARTIFACT_BUCKET || process.env.KLAURO_ARTIFACT_BUCKET;
  if (!bucket || uploads.length === 0) return {};
  const client = new S3Client({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    endpoint: process.env.KLAURO_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.KLAURO_S3_FORCE_PATH_STYLE === 'true',
  });
  const uris: Record<string, string> = {};

  for (const upload of uploads) {
    if (!(await fs.pathExists(upload.localPath))) continue;
    const input: PutObjectCommandInput = {
      Bucket: bucket,
      Key: upload.key,
      Body: await fs.readFile(upload.localPath),
      ContentType: upload.contentType,
      Metadata: {
        source: 'klauro-proposal-preview',
      },
    };
    const serverSideEncryption = process.env.KLAURO_S3_SERVER_SIDE_ENCRYPTION || 'AES256';
    if (serverSideEncryption !== 'none') {
      input.ServerSideEncryption = serverSideEncryption as PutObjectCommandInput['ServerSideEncryption'];
    }
    await client.send(new PutObjectCommand(input));
    uris[path.basename(upload.localPath)] = `s3://${bucket}/${upload.key}`;
  }

  return uris;
}
