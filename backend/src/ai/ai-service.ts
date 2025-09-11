import { OpenAIProvider, AIRequest, AIResponse } from './providers/openai-provider';
import { ClaudeProvider } from './providers/claude-provider';
import { FallbackProvider } from './providers/fallback-provider';
import { AICache } from './ai-cache';
import { aiConfig } from '../config/ai.config';
import pLimit from 'p-limit';

export interface AIServiceStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  cacheHits: number;
  cacheMisses: number;
  totalCost: number;
  costByProvider: Record<string, number>;
  costByModel: Record<string, number>;
  dailyCost: number;
  monthlyCost: number;
  averageResponseTime: number;
  providers: {
    openai: boolean;
    anthropic: boolean;
    fallback: boolean;
  };
}

export interface CostAlert {
  type: 'daily' | 'monthly';
  current: number;
  limit: number;
  percentage: number;
  message: string;
}

export class AIService {
  private providers: Map<string, any> = new Map();
  private cache: AICache;
  private stats: AIServiceStats;
  private costTracking: Map<string, { date: string; cost: number }> = new Map();
  private rateLimiter: ReturnType<typeof pLimit>;
  private costAlertCallbacks: Array<(alert: CostAlert) => void> = [];
  
  constructor(private config = aiConfig) {
    // Initialize providers
    this.initializeProviders();
    
    // Initialize cache
    this.cache = new AICache(config.cache);
    
    // Initialize stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalCost: 0,
      costByProvider: {},
      costByModel: {},
      dailyCost: 0,
      monthlyCost: 0,
      averageResponseTime: 0,
      providers: {
        openai: false,
        anthropic: false,
        fallback: true,
      },
    };
    
    // Rate limiter for overall API calls
    this.rateLimiter = pLimit(10); // Max 10 concurrent AI requests
    
    // Load cost tracking from previous sessions
    this.loadCostTracking();
    
    // Periodic cost tracking update
    setInterval(() => this.updateCostTracking(), 60000); // Every minute
  }
  
  private initializeProviders() {
    // OpenAI Provider
    const openaiProvider = new OpenAIProvider(this.config.openai);
    if (openaiProvider.isAvailable()) {
      this.providers.set('openai', openaiProvider);
      this.stats.providers.openai = true;
      console.log('OpenAI provider initialized');
    }
    
    // Anthropic/Claude Provider
    const claudeProvider = new ClaudeProvider(this.config.anthropic);
    if (claudeProvider.isAvailable()) {
      this.providers.set('anthropic', claudeProvider);
      this.stats.providers.anthropic = true;
      console.log('Anthropic provider initialized');
    }
    
    // Fallback Provider (always available)
    const fallbackProvider = new FallbackProvider(this.config.huggingface);
    this.providers.set('fallback', fallbackProvider);
    console.log('Fallback provider initialized');
  }
  
  async complete(request: AIRequest, preferredProvider?: string): Promise<AIResponse> {
    const startTime = Date.now();
    this.stats.totalRequests++;
    
    try {
      // Check cache first
      const cached = await this.cache.get(request);
      if (cached) {
        this.stats.cacheHits++;
        this.updateResponseTime(Date.now() - startTime);
        return cached;
      }
      
      this.stats.cacheMisses++;
      
      // Check cost limits before making API calls
      this.checkCostLimits();
      
      // Determine provider order
      const providerOrder = this.determineProviderOrder(preferredProvider);
      
      // Try providers in order
      let lastError: Error | null = null;
      
      for (const providerName of providerOrder) {
        const provider = this.providers.get(providerName);
        
        if (!provider || !provider.isAvailable()) {
          continue;
        }
        
        try {
          const response = await this.rateLimiter(() => provider.complete(request));
          
          // Track costs
          this.trackCost(response);
          
          // Cache successful response
          await this.cache.set(request, response);
          
          // Update stats
          this.stats.successfulRequests++;
          this.updateResponseTime(Date.now() - startTime);
          
          return response;
        } catch (error) {
          console.warn(`Provider ${providerName} failed:`, error);
          lastError = error as Error;
          
          // Continue to next provider
          if (this.config.fallback.enabled) {
            continue;
          } else {
            break;
          }
        }
      }
      
      // All providers failed
      this.stats.failedRequests++;
      throw lastError || new Error('All AI providers failed');
      
    } catch (error) {
      this.stats.failedRequests++;
      throw error;
    }
  }
  
  private determineProviderOrder(preferredProvider?: string): string[] {
    const strategy = this.config.fallback.strategy;
    let order: string[] = [];
    
    if (preferredProvider && this.providers.has(preferredProvider)) {
      order.push(preferredProvider);
    }
    
    switch (strategy) {
      case 'cascade':
        // Try providers in configured order
        order.push(...this.config.fallback.providers.filter(p => !order.includes(p)));
        break;
        
      case 'loadbalance':
        // Randomly select primary provider
        const available = this.config.fallback.providers.filter(
          p => this.providers.has(p) && this.providers.get(p).isAvailable()
        );
        if (available.length > 0) {
          const primary = available[Math.floor(Math.random() * available.length)];
          order.push(primary);
          order.push(...available.filter(p => p !== primary));
        }
        break;
        
      case 'failover':
        // Only use fallback if primary fails
        const primary = this.config.fallback.providers[0];
        if (this.providers.has(primary)) {
          order.push(primary);
        }
        order.push('fallback');
        break;
        
      default:
        order = [...this.config.fallback.providers];
    }
    
    // Always add fallback as last resort
    if (!order.includes('fallback')) {
      order.push('fallback');
    }
    
    return order;
  }
  
  private trackCost(response: AIResponse) {
    if (!this.config.costTracking.enabled) {
      return;
    }
    
    const cost = response.cost;
    this.stats.totalCost += cost;
    
    // Track by provider
    this.stats.costByProvider[response.provider] = 
      (this.stats.costByProvider[response.provider] || 0) + cost;
    
    // Track by model
    this.stats.costByModel[response.model] = 
      (this.stats.costByModel[response.model] || 0) + cost;
    
    // Track daily/monthly
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    
    const dailyKey = `daily:${today}`;
    const monthlyKey = `monthly:${month}`;
    
    const dailyEntry = this.costTracking.get(dailyKey) || { date: today, cost: 0 };
    dailyEntry.cost += cost;
    this.costTracking.set(dailyKey, dailyEntry);
    this.stats.dailyCost = dailyEntry.cost;
    
    const monthlyEntry = this.costTracking.get(monthlyKey) || { date: month, cost: 0 };
    monthlyEntry.cost += cost;
    this.costTracking.set(monthlyKey, monthlyEntry);
    this.stats.monthlyCost = monthlyEntry.cost;
    
    // Check for cost alerts
    this.checkCostAlerts();
  }
  
  private checkCostLimits() {
    if (!this.config.costTracking.enabled) {
      return;
    }
    
    if (this.stats.dailyCost >= this.config.costTracking.maxDailyCost) {
      throw new Error(`Daily cost limit of $${this.config.costTracking.maxDailyCost} exceeded`);
    }
    
    if (this.stats.monthlyCost >= this.config.costTracking.maxMonthlyCost) {
      throw new Error(`Monthly cost limit of $${this.config.costTracking.maxMonthlyCost} exceeded`);
    }
  }
  
  private checkCostAlerts() {
    const threshold = this.config.costTracking.alertThreshold;
    
    // Check daily limit
    const dailyPercentage = this.stats.dailyCost / this.config.costTracking.maxDailyCost;
    if (dailyPercentage >= threshold) {
      const alert: CostAlert = {
        type: 'daily',
        current: this.stats.dailyCost,
        limit: this.config.costTracking.maxDailyCost,
        percentage: dailyPercentage * 100,
        message: `Daily AI cost at ${(dailyPercentage * 100).toFixed(1)}% of limit ($${this.stats.dailyCost.toFixed(2)}/$${this.config.costTracking.maxDailyCost})`,
      };
      
      this.costAlertCallbacks.forEach(callback => callback(alert));
    }
    
    // Check monthly limit
    const monthlyPercentage = this.stats.monthlyCost / this.config.costTracking.maxMonthlyCost;
    if (monthlyPercentage >= threshold) {
      const alert: CostAlert = {
        type: 'monthly',
        current: this.stats.monthlyCost,
        limit: this.config.costTracking.maxMonthlyCost,
        percentage: monthlyPercentage * 100,
        message: `Monthly AI cost at ${(monthlyPercentage * 100).toFixed(1)}% of limit ($${this.stats.monthlyCost.toFixed(2)}/$${this.config.costTracking.maxMonthlyCost})`,
      };
      
      this.costAlertCallbacks.forEach(callback => callback(alert));
    }
  }
  
  onCostAlert(callback: (alert: CostAlert) => void) {
    this.costAlertCallbacks.push(callback);
  }
  
  private updateResponseTime(responseTime: number) {
    // Calculate rolling average
    const alpha = 0.1; // Smoothing factor
    this.stats.averageResponseTime = 
      this.stats.averageResponseTime * (1 - alpha) + responseTime * alpha;
  }
  
  private loadCostTracking() {
    // In production, load from database or persistent storage
    // For now, just initialize current day/month
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    
    this.costTracking.set(`daily:${today}`, { date: today, cost: 0 });
    this.costTracking.set(`monthly:${month}`, { date: month, cost: 0 });
  }
  
  private updateCostTracking() {
    // Clean up old entries (keep last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    for (const [key, entry] of this.costTracking.entries()) {
      if (key.startsWith('daily:')) {
        const entryDate = new Date(entry.date);
        if (entryDate < thirtyDaysAgo) {
          this.costTracking.delete(key);
        }
      }
    }
  }
  
  async analyzeCode(
    code: string,
    analysis: 'description' | 'risks' | 'improvements' | 'security' | 'performance',
    context?: Record<string, any>,
    preferredProvider?: string
  ): Promise<AIResponse> {
    // Use specialized methods if available
    const provider = preferredProvider ? this.providers.get(preferredProvider) : null;
    
    if (provider && provider.analyzeCode) {
      try {
        return await this.rateLimiter(() => provider.analyzeCode(code, analysis, context));
      } catch (error) {
        console.warn('Specialized analyzeCode failed, falling back to generic completion');
      }
    }
    
    // Fall back to generic completion
    const prompts = {
      description: 'Provide a clear description of what this code does',
      risks: 'Identify risks and vulnerabilities in this code',
      improvements: 'Suggest improvements for this code',
      security: 'Perform a security analysis of this code',
      performance: 'Analyze the performance characteristics of this code',
    };
    
    return this.complete({
      prompt: `${prompts[analysis]}\n\nCode:\n\`\`\`\n${code}\n\`\`\``,
      responseFormat: 'json',
      context,
    }, preferredProvider);
  }
  
  async warmupCache(preloadData: Array<{ request: AIRequest; response: AIResponse }>) {
    console.log(`Warming up AI cache with ${preloadData.length} entries...`);
    
    for (const { request, response } of preloadData) {
      await this.cache.set(request, response);
    }
    
    console.log('AI cache warmup complete');
  }
  
  getStats(): AIServiceStats & { cacheStats: any } {
    return {
      ...this.stats,
      cacheStats: this.cache.getStats(),
    };
  }
  
  async getCostReport(period: 'daily' | 'weekly' | 'monthly' = 'daily'): Promise<any> {
    const report: any = {
      period,
      totalCost: this.stats.totalCost,
      costByProvider: this.stats.costByProvider,
      costByModel: this.stats.costByModel,
      entries: [],
    };
    
    const now = new Date();
    let startDate: Date;
    
    switch (period) {
      case 'daily':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 7); // Last 7 days
        break;
      case 'weekly':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 28); // Last 4 weeks
        break;
      case 'monthly':
        startDate = new Date(now);
        startDate.setMonth(now.getMonth() - 3); // Last 3 months
        break;
    }
    
    for (const [key, entry] of this.costTracking.entries()) {
      const entryDate = new Date(entry.date);
      if (entryDate >= startDate && key.startsWith(period === 'monthly' ? 'monthly:' : 'daily:')) {
        report.entries.push(entry);
      }
    }
    
    report.entries.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    return report;
  }
  
  async clearCache(pattern?: string): Promise<number> {
    return this.cache.invalidate(pattern);
  }
  
  async exportState(): Promise<any> {
    return {
      stats: this.stats,
      costTracking: Array.from(this.costTracking.entries()),
      cache: await this.cache.exportCache(),
      config: {
        providers: Array.from(this.providers.keys()),
        fallbackStrategy: this.config.fallback.strategy,
        costLimits: {
          daily: this.config.costTracking.maxDailyCost,
          monthly: this.config.costTracking.maxMonthlyCost,
        },
      },
    };
  }
  
  async importState(state: any): Promise<void> {
    if (state.stats) {
      Object.assign(this.stats, state.stats);
    }
    
    if (state.costTracking) {
      this.costTracking.clear();
      state.costTracking.forEach(([key, value]: [string, any]) => {
        this.costTracking.set(key, value);
      });
    }
    
    if (state.cache) {
      await this.cache.importCache(state.cache);
    }
  }
  
  async shutdown(): Promise<void> {
    console.log('Shutting down AI service...');
    await this.cache.close();
  }
}