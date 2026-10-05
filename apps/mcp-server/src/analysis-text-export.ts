import { z } from 'zod';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { architectureToMermaid, architectureToModelAsCode } from './analysis-architecture-diagram';
import { analysisToMarkdown } from './analysis-markdown-export';

export const ANALYSIS_TEXT_FORMATS = ['mermaid', 'c4', 'markdown'] as const;

export type AnalysisTextFormat = (typeof ANALYSIS_TEXT_FORMATS)[number];

const RENDERERS: Record<AnalysisTextFormat, (cas: CASOutput) => string> = {
  mermaid: architectureToMermaid,
  c4: architectureToModelAsCode,
  markdown: analysisToMarkdown,
};

export function exportAnalysisText(cas: CASOutput, format: AnalysisTextFormat): { format: AnalysisTextFormat; text: string } {
  return { format, text: RENDERERS[format](cas) };
}

export const ANALYSIS_EXPORT_TOOL_CONFIG = {
  title: 'Export Analysis As Text',
  description: 'Text exports of the stored analysis. mermaid = a flowchart of the sub-projects as containers with the seams between them; c4 = the same containers and relations as C4-style model-as-code text; markdown = a human-diffable document of sub-projects, capabilities, flows, entities, seams and link coverage (schema in docs/ANALYSIS-MARKDOWN-EXPORT.md). Reshapes the stored analysis; nothing is re-extracted. Sections with nothing recorded say so.',
  inputSchema: {
    path: z.string().describe('Project path'),
    format: z.enum(ANALYSIS_TEXT_FORMATS).describe('mermaid | c4 | markdown'),
  },
};
