const LINKED_MARKDOWN_IMAGE = /\[\s*!\[[^\]]*\]\([^\n)]*\)\s*\]\([^\n)]*\)/g;
const REFERENCE_LINKED_MARKDOWN_IMAGE = /\[\s*!\[[^\]]*\]\[[^\]]*\]\s*\]\[[^\]]*\]/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^\n)]*\)/g;
const REFERENCE_MARKDOWN_IMAGE = /!\[[^\]]*\]\[[^\]]*\]/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const EMPTY_HTML_LINK = /<a\b[^>]*>\s*<\/a>/gi;

export function stripProjectDocumentMedia(content: string): string {
  return String(content || '')
    .replace(LINKED_MARKDOWN_IMAGE, '')
    .replace(REFERENCE_LINKED_MARKDOWN_IMAGE, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(REFERENCE_MARKDOWN_IMAGE, '')
    .replace(HTML_IMAGE, '')
    .replace(EMPTY_HTML_LINK, '')
    .split(/\r?\n/)
    .map(line => line.trim() ? line.replace(/[ \t]+$/g, '') : '')
    .join('\n');
}
