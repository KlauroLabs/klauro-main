import {
  AIProvider,
  AIAnalysisContext,
  AIRiskAssessment,
  AIRecommendation,
  AICodeAnalysis,
} from '../ai-service';
import { prompts } from '../ai-prompts';

const DEFAULT_LOCAL_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type GenerationOutput = Array<{ generated_text: string | ChatMessage[] }>;

type TextGenerationPipeline = (
  input: ChatMessage[],
  options: { max_new_tokens: number; temperature: number; do_sample: boolean },
) => Promise<GenerationOutput>;

export interface LocalProviderOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export class LocalProvider implements AIProvider {
  public readonly name = 'local';
  public available = true;

  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private pipelinePromise: Promise<TextGenerationPipeline> | null = null;

  constructor(options: LocalProviderOptions = {}) {
    this.model = options.model || DEFAULT_LOCAL_MODEL;
    this.maxTokens = options.maxTokens ?? 512;
    this.temperature = options.temperature ?? 0.3;
  }

  async generateDescription(context: AIAnalysisContext): Promise<string> {
    const text = await this.run(
      prompts.getSystemPrompt('description'),
      prompts.generateDescriptionPrompt(context),
    );
    return text.trim();
  }

  async assessRisk(context: AIAnalysisContext): Promise<AIRiskAssessment> {
    const text = await this.run(
      prompts.getSystemPrompt('risk'),
      prompts.generateRiskAssessmentPrompt(context),
    );
    return normalizeRiskAssessment(extractJson(text));
  }

  async generateRecommendations(context: AIAnalysisContext): Promise<AIRecommendation[]> {
    const text = await this.run(
      prompts.getSystemPrompt('recommendations'),
      prompts.generateRecommendationsPrompt(context),
    );
    return normalizeRecommendations(extractJson(text));
  }

  async analyzeCode(context: AIAnalysisContext): Promise<AICodeAnalysis> {
    const text = await this.run(
      prompts.getSystemPrompt('code'),
      prompts.generateCodeAnalysisPrompt(context),
    );
    return normalizeCodeAnalysis(extractJson(text), text);
  }

  private async run(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!this.available) {
      throw new Error('Local provider is unavailable (model failed to load)');
    }
    const generate = await this.getPipeline();
    const output = await generate(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        max_new_tokens: this.maxTokens,
        temperature: this.temperature,
        do_sample: this.temperature > 0,
      },
    );
    return readGeneratedText(output);
  }

  private getPipeline(): Promise<TextGenerationPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = loadPipeline(this.model).catch(error => {
        // The model is downloaded from the Hugging Face hub on first use.
        // If that fails (offline, hub down, disk full) mark the provider
        // unavailable so the AI cascade skips straight to the next provider
        // instead of retrying a doomed download on every request.
        this.available = false;
        const message = error instanceof Error ? error.message : String(error);
        const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message);
        console.warn(
          offline
            ? `[Unravl] Local AI model could not be downloaded (offline?); falling back. (${message})`
            : `[Unravl] Local AI model failed to load; falling back. (${message})`,
        );
        throw error;
      });
    }
    return this.pipelinePromise;
  }
}

async function loadPipeline(model: string): Promise<TextGenerationPipeline> {
  const moduleName = '@huggingface/transformers';
  const transformers = (await import(moduleName)) as {
    pipeline: (task: string, model: string) => Promise<TextGenerationPipeline>;
  };
  return transformers.pipeline('text-generation', model);
}

export function readGeneratedText(output: GenerationOutput): string {
  const generated = output?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return last && typeof last.content === 'string' ? last.content : '';
  }
  return typeof generated === 'string' ? generated : '';
}

export function extractJson(text: string): unknown {
  // Try the structure that appears first in the text. Always probing `{`
  // before `[` would mis-extract the first object out of a JSON array of
  // objects (e.g. a recommendations array).
  const candidates: Array<{ start: number; open: string; close: string }> = [];
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (firstBrace >= 0) candidates.push({ start: firstBrace, open: '{', close: '}' });
  if (firstBracket >= 0) candidates.push({ start: firstBracket, open: '[', close: ']' });
  candidates.sort((a, b) => a.start - b.start);

  for (const candidate of candidates) {
    const parsed = parseBalanced(text, candidate.start, candidate.open, candidate.close);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function parseBalanced(text: string, start: number, open: string, close: string): unknown {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function normalizeRiskAssessment(parsed: unknown): AIRiskAssessment {
  const record = asRecord(parsed);
  const levels = ['low', 'medium', 'high', 'critical'] as const;
  const riskLevel = levels.includes(record.riskLevel as typeof levels[number])
    ? (record.riskLevel as AIRiskAssessment['riskLevel'])
    : 'medium';
  const categories = Array.isArray(record.categories)
    ? record.categories.map(entry => {
        const categoryRecord = asRecord(entry);
        return {
          category: (categoryRecord.category as AIRiskAssessment['categories'][number]['category']) || 'maintainability',
          score: typeof categoryRecord.score === 'number' ? categoryRecord.score : 0,
          issues: asStringArray(categoryRecord.issues),
          recommendations: asStringArray(categoryRecord.recommendations),
        };
      })
    : [];
  return {
    riskLevel,
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.4,
    reasons: asStringArray(record.reasons),
    suggestions: asStringArray(record.suggestions),
    categories,
  };
}

export function normalizeRecommendations(parsed: unknown): AIRecommendation[] {
  const record = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.recommendations)
      ? record.recommendations
      : [];
  return list.map(entry => {
    const item = asRecord(entry);
    return {
      type: (item.type as AIRecommendation['type']) || 'refactoring',
      priority: (item.priority as AIRecommendation['priority']) || 'medium',
      title: typeof item.title === 'string' ? item.title : 'Recommendation',
      description: typeof item.description === 'string' ? item.description : '',
      implementation: typeof item.implementation === 'string' ? item.implementation : '',
      impact: typeof item.impact === 'string' ? item.impact : '',
      effort: (item.effort as AIRecommendation['effort']) || 'medium',
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.4,
      tags: asStringArray(item.tags),
    };
  });
}

export function normalizeCodeAnalysis(parsed: unknown, rawText: string): AICodeAnalysis {
  const record = asRecord(parsed);
  const complexity = asRecord(record.complexity);
  return {
    summary: typeof record.summary === 'string' ? record.summary : rawText.trim(),
    complexity: {
      cognitive: typeof complexity.cognitive === 'number' ? complexity.cognitive : 0,
      cyclomatic: typeof complexity.cyclomatic === 'number' ? complexity.cyclomatic : 0,
      maintainability: typeof complexity.maintainability === 'number' ? complexity.maintainability : 0,
    },
    patterns: [],
    issues: [],
    suggestions: [],
    testability: typeof record.testability === 'number' ? record.testability : 0,
    documentation: typeof record.documentation === 'string' ? record.documentation : '',
  };
}
