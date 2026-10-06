import * as http from 'http';
import type { AddressInfo } from 'net';

interface Listed {
  id: string;
  text: string;
}

interface JsonObject {
  [key: string]: unknown;
}

export interface AuthorStub {
  endpoint: string;
  asked: () => string[];
  close: () => Promise<void>;
}

const ID_LINE = /^- (?:id: )?([^\s:][^\n]*?)(?:: (.*))?$/;

function listedIn(prompt: string): Listed[] {
  const lines = prompt.split('\n');
  const start = lines.findIndex(line => /^The (?:outcomes|items|groups|capabilities|paths|records|[a-z ]+):\s*$/.test(line.trim()));
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  const found: Listed[] = [];
  for (const line of body) {
    const header = /^- id: (.+)$/.exec(line);
    if (header) {
      found.push({ id: header[1].trim(), text: '' });
      continue;
    }
    const inline = start >= 0 && !/^\s/.test(line) ? ID_LINE.exec(line) : null;
    if (inline && !/^- id: /.test(line)) {
      found.push({ id: inline[1].trim(), text: inline[2] ?? '' });
      continue;
    }
    const last = found[found.length - 1];
    if (last && line.trim() !== '') last.text += `${last.text ? '\n' : ''}${line.trim()}`;
  }
  return found;
}

function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const METHOD_VERBS: Record<string, string> = { GET: 'view', POST: 'record', PUT: 'update', PATCH: 'update', DELETE: 'remove' };

function fieldOf(text: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*${label}\\s*(?:\\([^)]*\\))?:\\s*(.+)$`, 'm').exec(text);
  return match?.[1].trim();
}

function subjectOf(item: Listed): string {
  const declared = /declared as: ([A-Za-z0-9_]+)/.exec(item.text)?.[1];
  const written = fieldOf(item.text, 'writes');
  const held = fieldOf(item.text, 'what the records it touches hold');
  const outcome = fieldOf(item.text, 'outcome')?.split(/,| which /)[0];
  const entity = declared
    ?? (written && written !== 'none' ? written.split(/[,\s]/)[0] : undefined)
    ?? (held && held !== 'none' ? held.split(/[\s(]/)[0] : undefined)
    ?? outcome;
  return words(entity ?? item.id).join(' ').toLowerCase();
}

function verbOf(item: Listed): string {
  const route = /reached through: ([A-Z]+) (\S+)/.exec(item.text);
  if (!route) return 'use';
  const segments = route[2].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const before = segments[segments.length - 2];
  const acts = last && !/^[{:]/.test(last) && before !== undefined && /^[{:]/.test(before);
  return acts ? last.toLowerCase() : METHOD_VERBS[route[1]] ?? 'use';
}

function nameOf(item: Listed): string {
  const proposed = /proposed name: (.+)/.exec(item.text)?.[1];
  return proposed ?? capitalised(`${verbOf(item)} ${subjectOf(item)}`);
}

function sentenceOf(item: Listed): string {
  const proposed = /proposed sentence: (.+)/.exec(item.text)?.[1];
  return proposed ?? `People ${verbOf(item)} ${subjectOf(item)} and keep the result for later use.`;
}

function shaped(prompt: string, key: string): unknown {
  const items = listedIn(prompt);
  switch (key) {
    case 'items':
      return { items: items.map(item => ({ id: item.id, name: nameOf(item), description: sentenceOf(item), audience: 'people using the product' })) };
    case 'placed':
      return { placed: items.map(item => ({ id: item.id, place: 'terminal' })) };
    case 'groups':
      if (/List only groups of two or more ids/.test(prompt)) return { groups: [] };
      return { groups: items.map(item => ({ of: [item.id], name: nameOf(item), description: sentenceOf(item), audience: 'people using the product' })) };
    case 'capabilities':
      return {
        capabilities: items.map(item => ({
          name: nameOf(item),
          description: sentenceOf(item),
          audience: 'people using the product',
          families: [item.id],
        })),
        plumbing: [],
      };
    case 'assigned':
      return {
        assigned: items.map(item => ({
          family: item.id,
          capability: nameOf(item),
          description: sentenceOf(item),
          audience: 'people using the product',
        })),
      };
    case 'summary': {
      const facts = prompt.split('\n').filter(line => line.trim() !== '').slice(1, 6).join(' ');
      const subject = words(facts).slice(0, 3).join(' ') || 'Part';
      return { name: capitalised(subject), summary: facts.slice(0, 80) };
    }
    case 'description': {
      const facts = /extracted from one software repository\.\s*([\s\S]*?)\s*Write the paragraph/.exec(prompt)?.[1] ?? prompt;
      return { description: facts.replace(/\s+/g, ' ').slice(0, 400) };
    }
    default:
      return undefined;
  }
}

function keyOf(format: unknown): string {
  const properties = (format as { properties?: JsonObject } | undefined)?.properties ?? {};
  const keys = Object.keys(properties);
  return keys[0] ?? '';
}

export async function startAuthorStub(): Promise<AuthorStub> {
  const asked: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      let body: { messages?: Array<{ content?: string }>; format?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const prompt = body.messages?.[0]?.content ?? '';
      const key = keyOf(body.format);
      asked.push(key);
      const answer = shaped(prompt, key);
      if (answer === undefined) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(answer) }, done: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/api/chat`,
    asked: () => [...asked],
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
