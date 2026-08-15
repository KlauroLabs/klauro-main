import type { UploadManifest } from './remote-source';

const SAMPLE_LIMIT = 25;
const DIRECTORY_LIMIT = 25;

export interface UploadManifestSummary extends Omit<UploadManifest, 'included_files' | 'excluded'> {
  file_count: number;
  total_bytes: number;
  excluded_count: number;
  excluded_by_reason: Record<string, number>;
  largest_directories: Array<{ directory: string; files: number; bytes: number }>;
  directories_omitted: number;
  files_sample: string[];
  files_omitted_from_sample: number;
  note: string;
}

export function summarizeUploadManifest(manifest: UploadManifest): UploadManifestSummary {
  const byDirectory = new Map<string, { files: number; bytes: number }>();
  for (const file of manifest.included_files) {
    const segments = file.path.split('/');
    const directory = segments.length > 1 ? segments.slice(0, 2).join('/') : (segments[0] || '.');
    const current = byDirectory.get(directory) || { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += file.bytes;
    byDirectory.set(directory, current);
  }
  const directories = [...byDirectory.entries()]
    .map(([directory, totals]) => ({ directory, ...totals }))
    .sort((left, right) => right.files - left.files || left.directory.localeCompare(right.directory));
  const excludedByReason: Record<string, number> = {};
  for (const entry of manifest.excluded) {
    excludedByReason[entry.reason] = (excludedByReason[entry.reason] || 0) + 1;
  }
  const { included_files, excluded, ...metadata } = manifest;
  return {
    ...metadata,
    file_count: manifest.summary.included_files,
    total_bytes: manifest.summary.included_bytes,
    excluded_count: manifest.summary.excluded_files,
    excluded_by_reason: Object.fromEntries(
      Object.entries(excludedByReason).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    largest_directories: directories.slice(0, DIRECTORY_LIMIT),
    directories_omitted: Math.max(0, directories.length - DIRECTORY_LIMIT),
    files_sample: included_files.slice(0, SAMPLE_LIMIT).map(file => file.path),
    files_omitted_from_sample: Math.max(0, included_files.length - SAMPLE_LIMIT),
    note: 'Counts and byte totals are exact. File rows are sampled; largest_directories identifies upload concentration and .klauroignore controls exclusions.',
  };
}
