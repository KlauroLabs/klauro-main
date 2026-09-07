import type { CASFirstPartyProductStatement } from '../../types/cas.types';

export type ProductDocumentStatement = Pick<CASFirstPartyProductStatement, 'role' | 'value'>;

export interface ProductDocumentFraming {
  title?: string;
  summary?: string;
  statements?: ProductDocumentStatement[];
}

export function extractProductDocumentFraming(content: string): ProductDocumentFraming {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  let title: string | undefined;
  let summary: string | undefined;
  const paragraph: string[] = [];
  const featureItems: string[] = [];
  const exampleItems: string[] = [];
  const contextItems: string[] = [];
  const isNoise = (line: string): boolean => {
    const value = line.trim();
    if (!value) return true;
    if (/^(?:\[!\[|!\[|<|>|```|\||---|===|\* \* \*|\*\*\*|___)/.test(value)) return true;
    if (/^!?\[[^\]]*\]\([^)]*\)\s*$|^\*\*[^*]+\*\*$/.test(value)) return true;
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(value)) return true;
    if (/^\*\*[^*]{1,40}:\*\*\s*\S/.test(value)) return true;
    if (/^[A-Za-z][A-Za-z ]{1,30}:\s*\S{1,40}$/.test(value) && value.length < 60) return true;
    return false;
  };
  for (let index = 0; index < lines.length && index < 200; index += 1) {
    const value = lines[index].trim();
    if (!title) {
      const heading = value.match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (heading) {
        const cleaned = heading[1].replace(/[`*_]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
        if (cleaned) title = cleaned.slice(0, 120);
        continue;
      }
    }
    if (paragraph.length === 0 && isNoise(value)) continue;
    if (paragraph.length > 0 && !value) break;
    if (isNoise(value) && paragraph.length === 0) continue;
    if (!isNoise(value) || paragraph.length > 0) {
      if (isNoise(value)) break;
      paragraph.push(value);
      if (paragraph.join(' ').length > 400) break;
    }
  }

  let sectionKind: 'outcome' | 'context' | undefined;
  let insideCodeFence = false;
  let documentedExamples = false;
  let documentedExampleItemsSeen = false;
  let sectionHasListItems = false;
  let lastListItem: { target: string[]; index: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const value = rawLine.trim();
    if (/^```/.test(value)) {
      insideCodeFence = !insideCodeFence;
      lastListItem = undefined;
      continue;
    }
    if (insideCodeFence) continue;
    const heading = value.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      const headingText = heading[1].replace(/[`*_]/g, '').trim();
      const excludedOperationalSection = /\b(?:build(?:ing)?|configuration|contribut(?:e|ing)|deploy(?:ment|ing)?|develop(?:ment|ing)?|examples?|install(?:ation|ing)?|prerequisites?|quick start|requirements?|running|setup|start(?:ing)?|testing)\b/i.test(headingText);
      const explicitOutcomeSection = /^(?:(?:key\s+|high(?:-|\s+)level\s+)?(?:features?|capabilities|functionality|use cases?|what (?:it|this|you) (?:does|can do))\b|why\s+.+\??$)/i.test(headingText) ||
        /\b(?:integrat(?:e|es|ed|ing|ion)|usage|user experience|user workflows?)\b/i.test(headingText);
      const contextualProductSection = /^(?:overview|(?:microservices?|architecture)(?:\s+(?:overview|architecture))?)$/i.test(headingText);
      sectionKind = excludedOperationalSection ? undefined
        : explicitOutcomeSection ? 'outcome'
          : contextualProductSection ? 'context'
            : undefined;
      documentedExamples = false;
      documentedExampleItemsSeen = false;
      sectionHasListItems = false;
      lastListItem = undefined;
      continue;
    }
    if (!sectionKind) continue;
    if (!value) {
      if (documentedExamples && documentedExampleItemsSeen) sectionKind = undefined;
      lastListItem = undefined;
      continue;
    }
    if (sectionKind === 'outcome') {
      const examplesLead = value.match(/^(.*?)(?:\s+Here are some examples of what you could ask)\s*:?$/i);
      if (examplesLead) {
        const capabilityStatement = examplesLead[1]
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/[`*_]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (capabilityStatement.length >= 12 && !featureItems.includes(capabilityStatement)) {
          featureItems.push(capabilityStatement);
        }
        documentedExamples = true;
        lastListItem = undefined;
        continue;
      }
      if (/\b(?:examples? of what|for example|such as)\b/i.test(value)) {
        documentedExamples = true;
        lastListItem = undefined;
        continue;
      }
    }
    const item = value.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    if (!item && lastListItem && /^\s{2,}\S/.test(rawLine)) {
      lastListItem.target[lastListItem.index] = `${lastListItem.target[lastListItem.index]} ${value}`
        .replace(/\s+/g, ' ')
        .trim();
      continue;
    }
    if (!item && sectionKind === 'outcome' && sectionHasListItems) continue;
    const authoredText = item ? item[1] : (/^(?:<|>|!\[|\||---|===)/.test(value) ? '' : value);
    if (!authoredText) continue;
    const cleaned = authoredText
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!item && sectionKind === 'outcome' && !/[.!?]$/.test(cleaned)) continue;
    const target = sectionKind === 'context'
      ? contextItems
      : documentedExamples ? exampleItems : featureItems;
    if (cleaned.length >= (item ? 1 : 12) && !target.includes(cleaned)) {
      target.push(cleaned);
      lastListItem = item ? { target, index: target.length - 1 } : undefined;
      if (item) sectionHasListItems = true;
      if (item && target === exampleItems) documentedExampleItemsSeen = true;
    }
  }

  const punctuate = (item: string) => /[.!?]$/.test(item) ? item : `${item}.`;
  const statements: ProductDocumentStatement[] = [
    { role: 'overview' as const, value: paragraph.join(' ') },
    ...contextItems.map(value => ({ role: 'context' as const, value: punctuate(value) })),
    ...featureItems.map(value => ({ role: 'feature' as const, value: punctuate(value) })),
    ...exampleItems.map(value => ({ role: 'example' as const, value: punctuate(value) })),
  ].map(statement => ({
    ...statement,
    value: statement.value
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\](?:\[[^\]]*\])?/g, '$1')
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  })).filter(statement => statement.value.length > 0);
  if (statements.length > 0) {
    summary = statements.map(statement => statement.role === 'overview'
      ? statement.value
      : `${statement.role[0].toUpperCase()}${statement.role.slice(1)}: ${statement.value}`)
      .join(' ').slice(0, 3000);
  }
  return { title, summary, statements };
}
