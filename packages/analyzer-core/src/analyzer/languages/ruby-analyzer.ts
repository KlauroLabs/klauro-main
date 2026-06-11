import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

interface RubyMethodCall {
  name: string;
  receiver?: string;
  receiverKind: 'none' | 'self' | 'constant' | 'ivar';
  line: number;
}

interface RubyMethod {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  isSingleton: boolean;
  parameters: string[];
  lineStart: number;
  lineEnd: number;
  calls: RubyMethodCall[];
  ivarTypes: Record<string, string>;
}

interface RubyStateTransition {
  event?: string;
  from: string[];
  to: string;
  conditional: boolean;
  line: number;
}

interface RubyStateMachine {
  dsl: 'state_machines' | 'aasm' | 'checkout_flow';
  attribute: string;
  initialState?: string;
  states: string[];
  transitions: RubyStateTransition[];
  lineStart: number;
  lineEnd: number;
  lastFlowState?: string;
}

interface RubyAttribute {
  name: string;
  kind: 'accessor' | 'reader' | 'writer';
  lineNumber: number;
}

interface RubyConstant {
  name: string;
  value: string;
  lineNumber: number;
}

interface RubyClass {
  name: string;
  qualifiedName: string;
  superclass?: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  methods: RubyMethod[];
  constants: RubyConstant[];
  attributes: RubyAttribute[];
  includedModules: string[];
  extendedModules: string[];
  stateMachines: RubyStateMachine[];
}

interface RubyModule {
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  methods: RubyMethod[];
  constants: RubyConstant[];
  stateMachines: RubyStateMachine[];
}

interface RubyRequire {
  target: string;
  relative: boolean;
  lineNumber: number;
}

interface RubyFileAnalysis {
  classes: RubyClass[];
  modules: RubyModule[];
  topLevelMethods: RubyMethod[];
  topLevelConstants: RubyConstant[];
  requires: RubyRequire[];
}

interface ScopeFrame {
  kind: 'class' | 'module' | 'def' | 'singleton' | 'block';
  classRef?: RubyClass;
  moduleRef?: RubyModule;
  methodRef?: RubyMethod;
  machineRef?: RubyStateMachine;
  eventName?: string;
  visibility: 'public' | 'private' | 'protected';
  lineStart: number;
}

const BLOCK_KEYWORD_PATTERN = /^(if|unless|while|until|case|begin|for)\b/;
const TRAILING_DO_PATTERN = /(^|[\s)])do(\s*\|[^|]*\|)?\s*$/;
const END_PATTERN = /^end\b/;
const CLASS_PATTERN = /^class\s+([A-Z][\w:]*)(?:\s*<\s*([A-Z][\w:]*))?/;
const SINGLETON_CLASS_PATTERN = /^class\s*<<\s*self/;
const MODULE_PATTERN = /^module\s+([A-Z][\w:]*)/;
const DEF_PATTERN = /^def\s+(self\.)?([\w?!=\[\]<>+\-*\/%~^&|]+)\s*(?:\(([^)]*)\))?/;
const ENDLESS_DEF_PATTERN = /^def\s+(self\.)?[\w?!=]+\s*(?:\([^)]*\))?\s*=/;
const REQUIRE_PATTERN = /^require(_relative)?\s+['"]([^'"]+)['"]/;
const CONSTANT_PATTERN = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/;
const ATTR_PATTERN = /^attr_(accessor|reader|writer)\s+(.+)$/;
const MIXIN_PATTERN = /^(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/;
const VISIBILITY_PATTERN = /^(private|protected|public)\s*$/;
const GEM_PATTERN = /^\s*gem\s+['"]([^'"]+)['"]/;
const STATE_MACHINE_START_PATTERN = /^state_machines?\b(?![.\w])([^#]*?)\bdo\s*(?:\|[^|]*\|)?\s*$/;
const AASM_START_PATTERN = /^aasm\b([^#]*?)\bdo\s*$/;
const CHECKOUT_FLOW_START_PATTERN = /^checkout_flow\b([^#]*?)\bdo\s*$/;
const GO_TO_STATE_PATTERN = /^go_to_state[\s(]+:(\w+)/;
const MACHINE_EVENT_PATTERN = /^event\s+:(\w+)/;
const MACHINE_STATE_PATTERN = /^state\s+((?::\w+[?!]?\s*,?\s*)+)/;
const MACHINE_TRANSITION_PATTERN = /^transitions?\b[\s(]/;
const TRANSITION_HOOK_PATTERN = /^(?:before|after|around)_transition\b/;
const STATES_REF_PATTERN = /\bstates\[:(\w+)\]/g;
const IVAR_ASSIGNMENT_PATTERN = /@(\w+)\s*(?:\|\|)?=\s*(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/;
const RECEIVER_CALL_PATTERN = /(?:^|[^\w.:@])(@?[A-Za-z_]\w*(?:::\w+)*)\.([a-z_]\w*[?!]?)/g;
const PAREN_CALL_PATTERN = /(?:^|[^\w.:@!$])([a-z_]\w*[?!]?)\(/g;
const LEADING_BARE_CALL_PATTERN = /^([a-z_]\w*[?!]?)(?:\s|$)/;
const CALL_NAME_POPULARITY_LIMIT = 3;

const RUBY_CALL_KEYWORDS = new Set([
  'if', 'unless', 'while', 'until', 'case', 'when', 'then', 'else', 'elsif', 'end',
  'do', 'begin', 'rescue', 'ensure', 'return', 'yield', 'super', 'self', 'nil',
  'true', 'false', 'and', 'or', 'not', 'def', 'class', 'module', 'require',
  'require_relative', 'raise', 'lambda', 'proc', 'loop', 'next', 'break', 'redo',
  'retry', 'defined?', 'puts', 'print', 'p', 'pp', 'attr_accessor', 'attr_reader',
  'attr_writer', 'include', 'extend', 'prepend', 'private', 'public', 'protected',
  'module_function', 'alias_method', 'define_method', 'instance_eval', 'class_eval',
  'instance_exec', 'class_exec', 'send', 'public_send', 'freeze', 'dup', 'clone',
  'tap', 'each', 'map', 'select', 'reject', 'reduce', 'inject', 'find', 'detect',
  'sum', 'sort', 'sort_by', 'first', 'last', 'count', 'size', 'length', 'empty?',
  'present?', 'blank?', 'nil?', 'to_s', 'to_i', 'to_f', 'to_a', 'to_h', 'to_sym',
  'merge', 'fetch', 'dig', 'key?', 'keys', 'values', 'push', 'pop', 'join', 'split',
  'strip', 'gsub', 'sub', 'match', 'format', 'sprintf', 'new', 'inspect', 'respond_to?',
  'is_a?', 'kind_of?', 'instance_of?', 'block_given?', 'binding', 'catch', 'throw'
]);

const MACHINE_RESERVED_TRANSITION_KEYS = new Set(['from', 'to', 'on', 'if', 'unless', 'do', 'guard', 'after', 'before', 'success']);

export class RubyAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'ruby',
      'Ruby Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const rubyFiles = await glob(['**/*.rb'], {
        cwd: projectPath,
        ignore: this.getRubyIgnorePatterns({ projectPath }),
        nodir: true
      });
      if (rubyFiles.length > 0) return true;

      const manifests = await glob(['Gemfile', 'Gemfile.lock', 'Rakefile', '*.gemspec'], {
        cwd: projectPath,
        nodir: true
      });
      return manifests.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.rb', '**/*.rake', 'Rakefile'], {
      cwd: projectPath,
      ignore: this.getRubyIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  protected getCapabilities(): string[] {
    return [
      'class-analysis',
      'module-analysis',
      'method-extraction',
      'constant-extraction',
      'attribute-extraction',
      'mixin-detection',
      'require-tracking',
      'inheritance-mapping',
      'gem-dependency-detection',
      'call-graph-extraction',
      'state-machine-extraction'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  private getRubyIgnorePatterns(context: AnalysisContext): string[] {
    return [
      ...this.getIgnorePatterns(context),
      '**/tmp/**',
      '**/log/**',
      '**/.bundle/**',
      '**/db/schema.rb'
    ];
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const analysis = this.parseRubySource(content, context.relativePath);

    this.emitFileNodes(analysis, context.relativePath, context.filePath, nodes, edges);
    this.buildInheritanceEdges([analysis], nodes, edges);
    this.buildCallEdges([analysis], edges);

    const imports = analysis.requires.map(item => item.target);
    const exports = [
      ...analysis.classes.map(item => item.name),
      ...analysis.modules.map(item => item.name),
      ...analysis.topLevelMethods.map(item => item.name),
      ...analysis.topLevelConstants.map(item => item.name)
    ];

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      imports,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const rubyFiles = (await glob(['**/*.rb', '**/*.rake', 'Rakefile'], {
        cwd: context.projectPath,
        ignore: this.getRubyIgnorePatterns(context),
        nodir: true
      })).sort();

      const fileAnalyses: RubyFileAnalysis[] = [];
      for (const file of rubyFiles) {
        const fullPath = path.join(context.projectPath, file);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const analysis = this.parseRubySource(content, file);
        fileAnalyses.push(analysis);
        this.emitFileNodes(analysis, file, fullPath, nodes, edges);
      }

      this.buildInheritanceEdges(fileAnalyses, nodes, edges);
      this.buildCallEdges(fileAnalyses, edges);

      const gems = await this.extractGems(context.projectPath);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'ruby',
          files_analyzed: rubyFiles.length,
          rails: gems.includes('rails'),
          sinatra: gems.includes('sinatra'),
          rspec: gems.includes('rspec') || gems.includes('rspec-rails'),
          sidekiq: gems.includes('sidekiq'),
          gems_detected: gems.length
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Ruby analysis failed: ${(error as Error).message}`,
        'RUBY_ANALYSIS_ERROR'
      );
    }
  }

  parseRubySource(content: string, filePath: string): RubyFileAnalysis {
    const analysis: RubyFileAnalysis = {
      classes: [],
      modules: [],
      topLevelMethods: [],
      topLevelConstants: [],
      requires: []
    };

    const lines = content.split('\n');
    const stack: ScopeFrame[] = [];
    let insideBlockComment = false;

    const currentVisibility = (): 'public' | 'private' | 'protected' => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'class' || stack[i].kind === 'module') return stack[i].visibility;
      }
      return 'public';
    };

    const enclosingClass = (): RubyClass | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'def') return undefined;
        if (stack[i].classRef) return stack[i].classRef;
        if (stack[i].moduleRef) return undefined;
      }
      return undefined;
    };

    const enclosingModule = (): RubyModule | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'def') return undefined;
        if (stack[i].classRef) return undefined;
        if (stack[i].moduleRef) return stack[i].moduleRef;
      }
      return undefined;
    };

    const insideMethod = (): boolean => stack.some(frame => frame.kind === 'def');

    const qualifiedPrefix = (): string => {
      const parts: string[] = [];
      for (const frame of stack) {
        if (frame.classRef) parts.push(frame.classRef.name);
        if (frame.moduleRef) parts.push(frame.moduleRef.name);
      }
      return parts.join('::');
    };

    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1;
      const raw = lines[index];
      const trimmed = raw.trim();

      if (insideBlockComment) {
        if (trimmed.startsWith('=end')) insideBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('=begin')) {
        insideBlockComment = true;
        continue;
      }
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const requireMatch = trimmed.match(REQUIRE_PATTERN);
      if (requireMatch) {
        analysis.requires.push({
          target: requireMatch[2],
          relative: Boolean(requireMatch[1]),
          lineNumber
        });
        continue;
      }

      const endMatch = trimmed.match(END_PATTERN);
      if (endMatch) {
        const frame = stack.pop();
        if (frame) {
          if (frame.classRef) frame.classRef.lineEnd = lineNumber;
          if (frame.moduleRef) frame.moduleRef.lineEnd = lineNumber;
          if (frame.methodRef) frame.methodRef.lineEnd = lineNumber;
          if (frame.machineRef) frame.machineRef.lineEnd = lineNumber;
        }
        continue;
      }

      const machineFrameIndex = this.findStateMachineFrameIndex(stack);
      if (machineFrameIndex === -1) {
        const machineStartMatch = trimmed.match(STATE_MACHINE_START_PATTERN);
        const aasmStartMatch = machineStartMatch ? null : trimmed.match(AASM_START_PATTERN);
        const checkoutFlowMatch = machineStartMatch || aasmStartMatch || insideMethod()
          ? null
          : trimmed.match(CHECKOUT_FLOW_START_PATTERN);
        if (machineStartMatch || aasmStartMatch || checkoutFlowMatch) {
          const machine = this.startStateMachine(
            machineStartMatch ? 'state_machines' : aasmStartMatch ? 'aasm' : 'checkout_flow',
            (machineStartMatch ? machineStartMatch[1] : aasmStartMatch ? aasmStartMatch[1] : checkoutFlowMatch![1]) || '',
            lineNumber,
            lines.length
          );
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].classRef) { stack[i].classRef!.stateMachines.push(machine); break; }
            if (stack[i].moduleRef) { stack[i].moduleRef!.stateMachines.push(machine); break; }
          }
          stack.push({ kind: 'block', machineRef: machine, visibility: 'public', lineStart: lineNumber });
          continue;
        }
      } else {
        const machine = stack[machineFrameIndex].machineRef!;

        const goToStateMatch = trimmed.match(GO_TO_STATE_PATTERN);
        if (goToStateMatch) {
          const to = goToStateMatch[1];
          const from = machine.lastFlowState ?? machine.initialState;
          if (from) this.addMachineState(machine, from);
          this.addMachineState(machine, to);
          machine.transitions.push({
            event: 'next',
            from: from ? [from] : [],
            to,
            conditional: /\b(?:if|unless)(?::|\s*=>)/.test(trimmed),
            line: lineNumber
          });
          machine.lastFlowState = to;
          continue;
        }

        STATES_REF_PATTERN.lastIndex = 0;
        for (const statesRef of trimmed.matchAll(STATES_REF_PATTERN)) {
          this.addMachineState(machine, statesRef[1]);
        }

        const eventMatch = trimmed.match(MACHINE_EVENT_PATTERN);
        if (eventMatch) {
          if (TRAILING_DO_PATTERN.test(trimmed.replace(/#.*$/, '').trimEnd())) {
            stack.push({ kind: 'block', eventName: eventMatch[1], visibility: 'public', lineStart: lineNumber });
          }
          continue;
        }

        if (MACHINE_TRANSITION_PATTERN.test(trimmed)) {
          let joined = trimmed.replace(/#.*$/, '').trimEnd();
          while (/,\s*$/.test(joined) && index + 1 < lines.length) {
            index++;
            joined += ' ' + lines[index].trim().replace(/#.*$/, '').trimEnd();
          }
          let event: string | undefined;
          for (let i = stack.length - 1; i > machineFrameIndex; i--) {
            if (stack[i].eventName) { event = stack[i].eventName; break; }
          }
          const onMatch = joined.match(/\bon(?::|\s*=>)\s*:(\w+)/);
          if (onMatch) event = onMatch[1];
          this.parseStateTransition(machine, joined, event, lineNumber);
          continue;
        }

        if (TRANSITION_HOOK_PATTERN.test(trimmed)) {
          this.harvestHookStates(machine, trimmed);
          if (TRAILING_DO_PATTERN.test(trimmed.replace(/#.*$/, '').trimEnd())) {
            stack.push({ kind: 'block', visibility: 'public', lineStart: lineNumber });
          }
          continue;
        }

        const stateMatch = trimmed.match(MACHINE_STATE_PATTERN);
        if (stateMatch) {
          const declared = stateMatch[1].match(/:(\w+[?!]?)/g) || [];
          for (const symbol of declared) {
            this.addMachineState(machine, symbol.slice(1));
            if (/initial:\s*true/.test(trimmed) && !machine.initialState) {
              machine.initialState = symbol.slice(1);
            }
          }
          if (TRAILING_DO_PATTERN.test(trimmed.replace(/#.*$/, '').trimEnd())) {
            stack.push({ kind: 'block', visibility: 'public', lineStart: lineNumber });
          }
          continue;
        }
      }

      if (SINGLETON_CLASS_PATTERN.test(trimmed)) {
        stack.push({ kind: 'singleton', visibility: 'public', lineStart: lineNumber });
        continue;
      }

      const classMatch = trimmed.match(CLASS_PATTERN);
      if (classMatch && !insideMethod()) {
        const prefix = qualifiedPrefix();
        const rubyClass: RubyClass = {
          name: classMatch[1].split('::').pop()!,
          qualifiedName: prefix ? `${prefix}::${classMatch[1]}` : classMatch[1],
          superclass: classMatch[2],
          filePath,
          lineStart: lineNumber,
          lineEnd: lines.length,
          methods: [],
          constants: [],
          attributes: [],
          includedModules: [],
          extendedModules: [],
          stateMachines: []
        };
        analysis.classes.push(rubyClass);
        if (/;\s*end\s*$/.test(this.stripStringsAndComments(trimmed).trimEnd())) {
          rubyClass.lineEnd = lineNumber;
        } else {
          stack.push({ kind: 'class', classRef: rubyClass, visibility: 'public', lineStart: lineNumber });
        }
        continue;
      }

      const moduleMatch = trimmed.match(MODULE_PATTERN);
      if (moduleMatch && !insideMethod()) {
        const prefix = qualifiedPrefix();
        const rubyModule: RubyModule = {
          name: moduleMatch[1].split('::').pop()!,
          qualifiedName: prefix ? `${prefix}::${moduleMatch[1]}` : moduleMatch[1],
          filePath,
          lineStart: lineNumber,
          lineEnd: lines.length,
          methods: [],
          constants: [],
          stateMachines: []
        };
        analysis.modules.push(rubyModule);
        if (/;\s*end\s*$/.test(this.stripStringsAndComments(trimmed).trimEnd())) {
          rubyModule.lineEnd = lineNumber;
        } else {
          stack.push({ kind: 'module', moduleRef: rubyModule, visibility: 'public', lineStart: lineNumber });
        }
        continue;
      }

      const visibilityMatch = trimmed.match(VISIBILITY_PATTERN);
      if (visibilityMatch) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].kind === 'class' || stack[i].kind === 'module') {
            stack[i].visibility = visibilityMatch[1] as 'public' | 'private' | 'protected';
            break;
          }
        }
        continue;
      }

      const inlineVisibility = trimmed.match(/^(private|protected)\s+def\s/);
      const defSource = inlineVisibility ? trimmed.replace(/^(private|protected)\s+/, '') : trimmed;
      const defMatch = defSource.match(DEF_PATTERN);
      if (defMatch && !insideMethod()) {
        const isEndless = ENDLESS_DEF_PATTERN.test(defSource);
        const inSingleton = stack.some(frame => frame.kind === 'singleton');
        const method: RubyMethod = {
          name: defMatch[2],
          visibility: inlineVisibility ? inlineVisibility[1] as 'private' | 'protected' : currentVisibility(),
          isSingleton: Boolean(defMatch[1]) || inSingleton,
          parameters: defMatch[3]
            ? defMatch[3].split(',').map(parameter => parameter.trim().split(/[:=\s]/)[0].replace(/^[*&]+/, '')).filter(Boolean)
            : [],
          lineStart: lineNumber,
          lineEnd: lineNumber,
          calls: [],
          ivarTypes: {}
        };

        const ownerClass = enclosingClass();
        const ownerModule = enclosingModule();
        if (ownerClass) ownerClass.methods.push(method);
        else if (ownerModule) ownerModule.methods.push(method);
        else analysis.topLevelMethods.push(method);

        if (!isEndless) {
          stack.push({ kind: 'def', methodRef: method, visibility: 'public', lineStart: lineNumber });
        }
        continue;
      }

      const attrMatch = trimmed.match(ATTR_PATTERN);
      if (attrMatch && !insideMethod()) {
        const ownerClass = enclosingClass();
        if (ownerClass) {
          const kind = attrMatch[1] as 'accessor' | 'reader' | 'writer';
          const names = attrMatch[2].match(/:(\w+)/g) || [];
          for (const symbol of names) {
            ownerClass.attributes.push({ name: symbol.slice(1), kind, lineNumber });
          }
        }
        continue;
      }

      const mixinMatch = trimmed.match(MIXIN_PATTERN);
      if (mixinMatch && !insideMethod()) {
        const ownerClass = enclosingClass();
        if (ownerClass) {
          const targets = mixinMatch[2].split(',').map(item => item.trim()).filter(Boolean);
          if (mixinMatch[1] === 'extend') ownerClass.extendedModules.push(...targets);
          else ownerClass.includedModules.push(...targets);
        }
        continue;
      }

      const constantMatch = trimmed.match(CONSTANT_PATTERN);
      if (constantMatch && !insideMethod()) {
        const constant: RubyConstant = {
          name: constantMatch[1],
          value: constantMatch[2].trim(),
          lineNumber
        };
        const ownerClass = enclosingClass();
        const ownerModule = enclosingModule();
        if (ownerClass) ownerClass.constants.push(constant);
        else if (ownerModule) ownerModule.constants.push(constant);
        else analysis.topLevelConstants.push(constant);
        if (TRAILING_DO_PATTERN.test(this.stripStringsAndComments(trimmed).trimEnd())) {
          stack.push({ kind: 'block', visibility: 'public', lineStart: lineNumber });
        }
        continue;
      }

      let callerMethod: RubyMethod | undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'def' && stack[i].methodRef) { callerMethod = stack[i].methodRef; break; }
      }
      if (callerMethod && !trimmed.startsWith('def ')) {
        this.captureCallsFromLine(this.stripStringsAndComments(trimmed), lineNumber, callerMethod);
      }

      if (BLOCK_KEYWORD_PATTERN.test(trimmed) || TRAILING_DO_PATTERN.test(trimmed.replace(/#.*$/, '').trimEnd())) {
        stack.push({ kind: 'block', visibility: 'public', lineStart: lineNumber });
      }
    }

    return analysis;
  }

  private findStateMachineFrameIndex(stack: ScopeFrame[]): number {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].machineRef) return i;
    }
    return -1;
  }

  private startStateMachine(
    dsl: 'state_machines' | 'aasm' | 'checkout_flow',
    args: string,
    lineStart: number,
    lineEnd: number
  ): RubyStateMachine {
    const attributeMatch = dsl === 'state_machines'
      ? args.match(/^\s*:(\w+)/)
      : args.match(/column:\s*['":](\w+)/);
    const initialMatch = args.match(/initial(?::|\s*=>)\s*:(\w+)/);
    const machine: RubyStateMachine = {
      dsl,
      attribute: attributeMatch ? attributeMatch[1] : (dsl === 'aasm' ? 'aasm_state' : 'state'),
      initialState: initialMatch ? initialMatch[1] : (dsl === 'checkout_flow' ? 'cart' : undefined),
      states: [],
      transitions: [],
      lineStart,
      lineEnd
    };
    if (machine.initialState) this.addMachineState(machine, machine.initialState);
    return machine;
  }

  private addMachineState(machine: RubyStateMachine, state: string): void {
    if (!machine.states.includes(state)) machine.states.push(state);
  }

  private parseStateTransition(
    machine: RubyStateMachine,
    text: string,
    event: string | undefined,
    line: number
  ): void {
    const conditional = /\b(?:if|unless)(?::|\s*=>)/.test(text);
    const toMatch = text.match(/\bto(?::|\s*=>)\s*:(\w+[?!]?)/);
    const fromSingleMatch = text.match(/\bfrom(?::|\s*=>)\s*:(\w+[?!]?)/);
    const fromArrayMatch = text.match(/\bfrom(?::|\s*=>)\s*\[([^\]]*)\]/);

    const from: string[] = [];
    if (fromArrayMatch) {
      for (const symbol of fromArrayMatch[1].match(/:(\w+[?!]?)/g) || []) {
        from.push(symbol.slice(1));
      }
    } else if (fromSingleMatch) {
      from.push(fromSingleMatch[1]);
    }

    if (toMatch) {
      const to = toMatch[1];
      this.addMachineState(machine, to);
      for (const state of from) this.addMachineState(machine, state);
      machine.transitions.push({ event, from, to, conditional, line });
      return;
    }

    const pairForms = [
      /:(\w+[?!]?)\s*=>\s*:(\w+[?!]?)/g,
      /\b(\w+[?!]?):\s+:(\w+[?!]?)/g
    ];
    for (const pattern of pairForms) {
      pattern.lastIndex = 0;
      for (const pair of text.matchAll(pattern)) {
        if (MACHINE_RESERVED_TRANSITION_KEYS.has(pair[1])) continue;
        this.addMachineState(machine, pair[1]);
        this.addMachineState(machine, pair[2]);
        machine.transitions.push({ event, from: [pair[1]], to: pair[2], conditional, line });
      }
    }
  }

  private harvestHookStates(machine: RubyStateMachine, text: string): void {
    const stateArgsOnly = text.replace(/\b(?:do|if|unless|on)(?::|\s*=>)\s*(?::\w+[?!]?|\[[^\]]*\])/g, '');
    for (const direct of stateArgsOnly.matchAll(/\b(?:to|from)(?::|\s*=>)\s*:(\w+[?!]?)/g)) {
      this.addMachineState(machine, direct[1]);
    }
    for (const bracketed of stateArgsOnly.matchAll(/\[([^\]]*)\]/g)) {
      for (const symbol of bracketed[1].match(/:(\w+[?!]?)/g) || []) {
        this.addMachineState(machine, symbol.slice(1));
      }
    }
  }

  private stripStringsAndComments(line: string): string {
    return line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/#.*$/, '');
  }

  private captureCallsFromLine(code: string, line: number, method: RubyMethod): void {
    const ivarAssignment = code.match(IVAR_ASSIGNMENT_PATTERN);
    if (ivarAssignment && !(ivarAssignment[1] in method.ivarTypes)) {
      method.ivarTypes[ivarAssignment[1]] = ivarAssignment[2];
    }

    RECEIVER_CALL_PATTERN.lastIndex = 0;
    for (const match of code.matchAll(RECEIVER_CALL_PATTERN)) {
      const receiver = match[1];
      const name = match[2];
      if (RUBY_CALL_KEYWORDS.has(name)) continue;
      const rest = code.slice(match.index! + match[0].length);
      if (/^\s*=[^=~>]/.test(rest)) continue;
      if (receiver.startsWith('@')) {
        method.calls.push({ name, receiver: receiver.slice(1), receiverKind: 'ivar', line });
      } else if (receiver === 'self') {
        method.calls.push({ name, receiverKind: 'self', line });
      } else if (/^[A-Z]/.test(receiver)) {
        method.calls.push({ name, receiver, receiverKind: 'constant', line });
      }
    }

    PAREN_CALL_PATTERN.lastIndex = 0;
    for (const match of code.matchAll(PAREN_CALL_PATTERN)) {
      const name = match[1];
      if (RUBY_CALL_KEYWORDS.has(name)) continue;
      method.calls.push({ name, receiverKind: 'none', line });
    }

    const bareMatch = code.match(LEADING_BARE_CALL_PATTERN);
    if (bareMatch && !RUBY_CALL_KEYWORDS.has(bareMatch[1])) {
      const rest = code.slice(bareMatch[1].length);
      const looksLikeAssignment = /^\s*(?:\|\||&&|[+\-*\/%|&^])?=[^=~>]/.test(rest);
      const looksLikeCall = !rest.trim() || /^\s+[^\s=+\-*\/%<>|&^?]/.test(rest);
      if (!looksLikeAssignment && looksLikeCall) {
        method.calls.push({ name: bareMatch[1], receiverKind: 'none', line });
      }
    }
  }

  private emitFileNodes(
    analysis: RubyFileAnalysis,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const rubyModule of analysis.modules) {
      const moduleId = this.generateId('module', relativePath, rubyModule.qualifiedName);
      nodes.push(this.createNodeBuilder(moduleId, rubyModule.name, 'module')
        .withLevel(3, 'code')
        .withCategory('module', ['ruby'])
        .withSource({ file: fullPath, line: rubyModule.lineStart, end_line: rubyModule.lineEnd })
        .withDescription(`Ruby module: ${rubyModule.qualifiedName}`)
        .withMetadata({
          framework: 'ruby',
          attributes: {
            qualified_name: rubyModule.qualifiedName,
            methods_count: rubyModule.methods.length,
            constants_count: rubyModule.constants.length,
            ...(rubyModule.stateMachines.length
              ? { state_machines: rubyModule.stateMachines.map(machine => this.describeStateMachine(machine)) }
              : {})
          }
        })
        .withTags(['analyzer:ruby'])
        .build());

      this.emitMethods(rubyModule.methods, moduleId, rubyModule.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitConstants(rubyModule.constants, moduleId, rubyModule.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitStateMachines(rubyModule.stateMachines, moduleId, rubyModule.qualifiedName, relativePath, fullPath, nodes, edges);
    }

    for (const rubyClass of analysis.classes) {
      const classId = this.generateId('class', relativePath, rubyClass.qualifiedName);
      nodes.push(this.createNodeBuilder(classId, rubyClass.name, 'class')
        .withLevel(3, 'code')
        .withCategory('class', ['ruby'])
        .withSource({ file: fullPath, line: rubyClass.lineStart, end_line: rubyClass.lineEnd })
        .withDescription(`Ruby class: ${rubyClass.qualifiedName}`)
        .withMetadata({
          framework: 'ruby',
          attributes: {
            qualified_name: rubyClass.qualifiedName,
            superclass: rubyClass.superclass,
            methods_count: rubyClass.methods.length,
            constants_count: rubyClass.constants.length,
            attributes_count: rubyClass.attributes.length,
            included_modules: rubyClass.includedModules,
            extended_modules: rubyClass.extendedModules,
            ...(rubyClass.stateMachines.length
              ? { state_machines: rubyClass.stateMachines.map(machine => this.describeStateMachine(machine)) }
              : {})
          }
        })
        .withTags(['analyzer:ruby'])
        .build());

      this.emitMethods(rubyClass.methods, classId, rubyClass.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitConstants(rubyClass.constants, classId, rubyClass.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitStateMachines(rubyClass.stateMachines, classId, rubyClass.qualifiedName, relativePath, fullPath, nodes, edges);

      for (const attribute of rubyClass.attributes) {
        const attributeId = this.generateId('property', relativePath, `${rubyClass.qualifiedName}#${attribute.name}`);
        nodes.push(this.createNodeBuilder(attributeId, attribute.name, 'property')
          .withLevel(4, 'member')
          .withCategory('property', ['ruby'])
          .withSource({ file: fullPath, line: attribute.lineNumber, end_line: attribute.lineNumber })
          .withDescription(`Ruby attribute (${attribute.kind}) on ${rubyClass.qualifiedName}: ${attribute.name}`)
          .withParent(classId)
          .withMetadata({ framework: 'ruby', attributes: { kind: attribute.kind } })
          .withTags(['analyzer:ruby'])
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(classId, attributeId, 'contains'),
          classId,
          attributeId,
          'contains',
          'structural'
        ));
      }
    }

    for (const method of analysis.topLevelMethods) {
      const functionId = this.generateId('function', relativePath, method.name);
      nodes.push(this.createNodeBuilder(functionId, method.name, 'function')
        .withLevel(3, 'code')
        .withCategory('function', ['ruby'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withDescription(`Ruby top-level method: ${method.name}`)
        .withSignature({ parameters: method.parameters.map(name => ({ name, type: 'Object' })) })
        .withMetadata({ framework: 'ruby' })
        .withTags(['analyzer:ruby'])
        .build());
    }

    for (const constant of analysis.topLevelConstants) {
      const constantId = this.generateId('constant', relativePath, constant.name);
      nodes.push(this.createNodeBuilder(constantId, constant.name, 'constant')
        .withLevel(3, 'code')
        .withCategory('constant', ['ruby'])
        .withSource({ file: fullPath, line: constant.lineNumber, end_line: constant.lineNumber })
        .withDescription(`Ruby constant: ${constant.name}`)
        .withMetadata({ framework: 'ruby', attributes: { value: constant.value } })
        .withTags(['analyzer:ruby'])
        .build());
    }
  }

  private emitMethods(
    methods: RubyMethod[],
    ownerId: string,
    ownerQualifiedName: string,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const method of methods) {
      const separator = method.isSingleton ? '.' : '#';
      const methodId = this.generateId('method', relativePath, `${ownerQualifiedName}${separator}${method.name}`);
      nodes.push(this.createNodeBuilder(methodId, method.name, 'method')
        .withLevel(4, 'member')
        .withCategory('method', ['ruby'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withDescription(`Ruby method ${ownerQualifiedName}${separator}${method.name}`)
        .withParent(ownerId)
        .withSignature({ parameters: method.parameters.map(name => ({ name, type: 'Object' })) })
        .withMetadata({
          framework: 'ruby',
          attributes: {
            visibility: method.visibility,
            singleton: method.isSingleton
          }
        })
        .withTags(['analyzer:ruby'])
        .build());
      edges.push(this.createEdge(
        this.generateEdgeId(ownerId, methodId, 'contains'),
        ownerId,
        methodId,
        'contains',
        'structural'
      ));
    }
  }

  private emitConstants(
    constants: RubyConstant[],
    ownerId: string,
    ownerQualifiedName: string,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const constant of constants) {
      const constantId = this.generateId('constant', relativePath, `${ownerQualifiedName}::${constant.name}`);
      nodes.push(this.createNodeBuilder(constantId, constant.name, 'constant')
        .withLevel(4, 'member')
        .withCategory('constant', ['ruby'])
        .withSource({ file: fullPath, line: constant.lineNumber, end_line: constant.lineNumber })
        .withDescription(`Ruby constant ${ownerQualifiedName}::${constant.name}`)
        .withParent(ownerId)
        .withMetadata({ framework: 'ruby', attributes: { value: constant.value } })
        .withTags(['analyzer:ruby'])
        .build());
      edges.push(this.createEdge(
        this.generateEdgeId(ownerId, constantId, 'contains'),
        ownerId,
        constantId,
        'contains',
        'structural'
      ));
    }
  }

  private describeStateMachine(machine: RubyStateMachine): Record<string, any> {
    return {
      attribute: machine.attribute,
      dsl: machine.dsl,
      initial_state: machine.initialState,
      states: machine.states,
      events: [...new Set(machine.transitions.map(transition => transition.event).filter(Boolean))],
      transitions: machine.transitions.map(transition => ({
        event: transition.event,
        from: transition.from.length ? transition.from : ['any'],
        to: transition.to,
        conditional: transition.conditional
      }))
    };
  }

  private emitStateMachines(
    machines: RubyStateMachine[],
    ownerId: string,
    ownerQualifiedName: string,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const machine of machines) {
      const stateIds = new Map<string, string>();
      for (const state of machine.states) {
        const stateId = this.generateId('state', relativePath, `${ownerQualifiedName}::${machine.attribute}::${state}`);
        stateIds.set(state, stateId);
        nodes.push(this.createNodeBuilder(stateId, state, 'state')
          .withLevel(4, 'member')
          .withCategory('state', ['ruby', machine.dsl])
          .withSource({ file: fullPath, line: machine.lineStart, end_line: machine.lineEnd })
          .withDescription(`State '${state}' of ${ownerQualifiedName} ${machine.attribute} state machine`)
          .withParent(ownerId)
          .withMetadata({
            framework: 'ruby',
            attributes: {
              state_machine_attribute: machine.attribute,
              dsl: machine.dsl,
              initial: machine.initialState === state
            }
          })
          .withTags(['analyzer:ruby', 'state-machine'])
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(ownerId, stateId, 'contains'),
          ownerId,
          stateId,
          'contains',
          'structural'
        ));
      }

      const edgeIds = new Set<string>();
      for (const transition of machine.transitions) {
        const targetId = stateIds.get(transition.to);
        if (!targetId) continue;
        const sources = transition.from.length
          ? transition.from.map(state => stateIds.get(state)).filter((id): id is string => Boolean(id))
          : [ownerId];
        for (const sourceId of sources) {
          if (sourceId === targetId) continue;
          const edgeId = `${sourceId}_transitions_to_${targetId}_${transition.event || 'next'}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(
            edgeId,
            sourceId,
            targetId,
            'transitions_to',
            'behavior',
            {
              attributes: {
                event: transition.event,
                from: transition.from.length ? transition.from : ['any'],
                to: transition.to,
                state_machine_attribute: machine.attribute,
                dsl: machine.dsl
              },
              conditional: transition.conditional,
              locations: [{ file: fullPath, line: transition.line }]
            }
          ));
        }
      }
    }
  }

  private methodNodeIdFor(owner: RubyClass | RubyModule, method: RubyMethod): string {
    const separator = method.isSingleton ? '.' : '#';
    return this.generateId('method', owner.filePath, `${owner.qualifiedName}${separator}${method.name}`);
  }

  buildCallEdges(fileAnalyses: RubyFileAnalysis[], edges: CASEdge[]): void {
    const owners: Array<RubyClass | RubyModule> = [];
    for (const analysis of fileAnalyses) {
      owners.push(...analysis.classes, ...analysis.modules);
    }

    const ownersByName = new Map<string, Array<RubyClass | RubyModule>>();
    const ownersByQualifiedName = new Map<string, Array<RubyClass | RubyModule>>();
    const methodOwnerCounts = new Map<string, Set<string>>();
    for (const owner of owners) {
      const byName = ownersByName.get(owner.name) || [];
      byName.push(owner);
      ownersByName.set(owner.name, byName);
      const byQualified = ownersByQualifiedName.get(owner.qualifiedName) || [];
      byQualified.push(owner);
      ownersByQualifiedName.set(owner.qualifiedName, byQualified);
      for (const method of owner.methods) {
        const definingOwners = methodOwnerCounts.get(method.name) || new Set<string>();
        definingOwners.add(owner.qualifiedName);
        methodOwnerCounts.set(method.name, definingOwners);
      }
    }

    const resolveOwner = (reference: string): RubyClass | RubyModule | undefined => {
      const qualified = ownersByQualifiedName.get(reference.replace(/^::/, ''));
      if (qualified && qualified.length === 1) return qualified[0];
      const candidates = ownersByName.get(reference.split('::').pop()!);
      if (candidates && candidates.length === 1) return candidates[0];
      return undefined;
    };

    const isPopular = (methodName: string): boolean =>
      (methodOwnerCounts.get(methodName)?.size || 0) > CALL_NAME_POPULARITY_LIMIT;

    const edgeIds = new Set(edges.map(edge => edge.id));
    const pushCallEdge = (
      callerId: string,
      targetId: string,
      call: RubyMethodCall,
      callType: string,
      targetOwner: RubyClass | RubyModule
    ) => {
      if (callerId === targetId) return;
      const edgeId = `${callerId}_calls_${targetId}_line_${call.line}`;
      if (edgeIds.has(edgeId)) return;
      edgeIds.add(edgeId);
      edges.push(this.createEdge(
        edgeId,
        callerId,
        targetId,
        'calls',
        'behavior',
        {
          attributes: {
            line: call.line,
            callType,
            targetClass: targetOwner.qualifiedName,
            targetMethod: call.name,
            receiver: call.receiver
          }
        }
      ));
    };

    for (const owner of owners) {
      const ownerIsClass = 'includedModules' in owner;
      const includedModuleNames = ownerIsClass
        ? [...(owner as RubyClass).includedModules, ...(owner as RubyClass).extendedModules]
        : [];

      const classIvarTypes: Record<string, string> = {};
      for (const method of owner.methods) {
        for (const [ivar, type] of Object.entries(method.ivarTypes)) {
          if (!(ivar in classIvarTypes)) classIvarTypes[ivar] = type;
        }
      }

      for (const method of owner.methods) {
        const callerId = this.methodNodeIdFor(owner, method);

        for (const call of method.calls) {
          if (call.receiverKind === 'none' || call.receiverKind === 'self') {
            const sameOwnerTarget =
              owner.methods.find(candidate => candidate.name === call.name && candidate.isSingleton === method.isSingleton) ||
              owner.methods.find(candidate => candidate.name === call.name);
            if (sameOwnerTarget) {
              pushCallEdge(callerId, this.methodNodeIdFor(owner, sameOwnerTarget), call, 'implicit', owner);
              continue;
            }
            if (call.receiverKind === 'self' || isPopular(call.name)) continue;
            const moduleCandidates: Array<{ owner: RubyClass | RubyModule; method: RubyMethod }> = [];
            for (const mixin of includedModuleNames) {
              const mixinOwner = resolveOwner(mixin);
              if (!mixinOwner) continue;
              const mixinMethod = mixinOwner.methods.find(candidate => candidate.name === call.name);
              if (mixinMethod) moduleCandidates.push({ owner: mixinOwner, method: mixinMethod });
            }
            if (moduleCandidates.length === 1) {
              pushCallEdge(
                callerId,
                this.methodNodeIdFor(moduleCandidates[0].owner, moduleCandidates[0].method),
                call,
                'mixin',
                moduleCandidates[0].owner
              );
            }
            continue;
          }

          if (call.receiverKind === 'constant') {
            const targetOwner = resolveOwner(call.receiver!);
            if (!targetOwner) continue;
            const targetIsClass = 'includedModules' in targetOwner;
            const targetMethod = targetIsClass
              ? targetOwner.methods.find(candidate => candidate.name === call.name && candidate.isSingleton)
              : targetOwner.methods.find(candidate => candidate.name === call.name);
            if (targetMethod) {
              pushCallEdge(callerId, this.methodNodeIdFor(targetOwner, targetMethod), call, 'static', targetOwner);
            }
            continue;
          }

          if (call.receiverKind === 'ivar') {
            const ivarType = method.ivarTypes[call.receiver!] || classIvarTypes[call.receiver!];
            if (!ivarType) continue;
            const targetOwner = resolveOwner(ivarType);
            if (!targetOwner) continue;
            const targetMethod = targetOwner.methods.find(candidate => candidate.name === call.name && !candidate.isSingleton);
            if (targetMethod) {
              pushCallEdge(callerId, this.methodNodeIdFor(targetOwner, targetMethod), call, 'method', targetOwner);
            }
          }
        }
      }
    }
  }

  private buildInheritanceEdges(
    fileAnalyses: RubyFileAnalysis[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const classNodesByName = new Map<string, CASNode>();
    const moduleNodesByName = new Map<string, CASNode>();
    for (const node of nodes) {
      if (node.type === 'class') classNodesByName.set(node.name, node);
      if (node.type === 'module') moduleNodesByName.set(node.name, node);
    }

    const existingEdgeIds = new Set(edges.map(edge => edge.id));
    const pushEdge = (edge: CASEdge) => {
      if (!existingEdgeIds.has(edge.id)) {
        existingEdgeIds.add(edge.id);
        edges.push(edge);
      }
    };

    for (const analysis of fileAnalyses) {
      for (const rubyClass of analysis.classes) {
        const classNode = classNodesByName.get(rubyClass.name);
        if (!classNode) continue;

        if (rubyClass.superclass) {
          const superclassNode = classNodesByName.get(rubyClass.superclass.split('::').pop()!);
          if (superclassNode && superclassNode.id !== classNode.id) {
            pushEdge(this.createEdge(
              this.generateEdgeId(classNode.id, superclassNode.id, 'extends'),
              classNode.id,
              superclassNode.id,
              'extends',
              'structural',
              { superclass: rubyClass.superclass }
            ));
          }
        }

        for (const mixin of [...rubyClass.includedModules, ...rubyClass.extendedModules]) {
          const moduleNode = moduleNodesByName.get(mixin.split('::').pop()!);
          if (moduleNode) {
            pushEdge(this.createEdge(
              this.generateEdgeId(classNode.id, moduleNode.id, 'includes'),
              classNode.id,
              moduleNode.id,
              'includes',
              'structural',
              { mixin }
            ));
          }
        }
      }
    }
  }

  async extractGems(projectPath: string): Promise<string[]> {
    const gems = new Set<string>();
    const gemfilePath = path.join(projectPath, 'Gemfile');
    try {
      if (await fs.pathExists(gemfilePath)) {
        const content = await fs.readFile(gemfilePath, 'utf-8');
        for (const line of content.split('\n')) {
          const match = line.match(GEM_PATTERN);
          if (match) gems.add(match[1]);
        }
      }
    } catch {
    }
    return [...gems];
  }
}
