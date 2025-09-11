// Simple UUID v4 generator
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Generate shorter ID for URLs (first 8 chars of UUID)
export function generateShortId(): string {
  return generateUUID().slice(0, 8);
}

// Generate analysis ID with timestamp for uniqueness
export function generateAnalysisId(blueprint: any): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}