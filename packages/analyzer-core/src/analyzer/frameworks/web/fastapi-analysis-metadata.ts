import {
  CASComment,
  CASDocumentation,
  CASEdge,
  CASImplementationStatus,
  CASNode,
  CASPerspective,
  CASTodo,
} from '../../../types/cas.types';

export class FastAPIAnalysisMetadata {
  constructor(private readonly analyzerId: string) {}

  extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');




    const fieldDescMatches = content.matchAll(/Field\([^)]*description\s*=\s*['"]([^'"]+)['"]/g);
    const fieldDescriptions = [];
    for (const match of fieldDescMatches) {
      fieldDescriptions.push(match[1]);
    }


    const routeDocMatches = content.matchAll(/@app\.(get|post|put|delete|patch)\([^)]*summary\s*=\s*['"]([^'"]+)['"]/g);
    const routeDocs = [];
    for (const match of routeDocMatches) {
      routeDocs.push(`${match[1].toUpperCase()}: ${match[2]}`);
    }


    const modelDocMatches = content.matchAll(/class\s+\w+\([^)]*BaseModel[^)]*\):\s*['"""]([^'"]*?)['"""]/g);
    const modelDocs = [];
    for (const match of modelDocMatches) {
      modelDocs.push(match[1].trim());
    }


    const functionDocStrings = [];
    const functionMatches = content.matchAll(/def\s+\w+[^:]*:\s*['"""]([^'"]*?)['"""]/g);
    for (const match of functionMatches) {
      functionDocStrings.push(match[1].trim());
    }

    if (fieldDescriptions.length > 0 || routeDocs.length > 0 || modelDocs.length > 0 || functionDocStrings.length > 0) {
      const doc: CASDocumentation = {
        type: 'fastapi_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (functionDocStrings.length > 0) {
        doc.summary = functionDocStrings[0].split('\n')[0].trim();
        doc.description = functionDocStrings[0].trim();
      } else if (modelDocs.length > 0) {
        doc.summary = modelDocs[0].split('\n')[0].trim();
      }

      doc.framework_docs = {
        fastapi: {
          field_descriptions: fieldDescriptions
        }
      };

      return doc;
    }

    return undefined;
  }

  extractComments(content: string, filePath: string): CASComment[] {
    if (!content || content.trim().length === 0) return [];

    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();


      if (trimmedLine.startsWith('#')) {
        const commentText = trimmedLine.substring(1).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'single-line',
            style: '#',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }


      const docstringMatch = line.match(/^\s*['"]{3}([^'"]*?)['"]{3}/);
      if (docstringMatch && !line.includes('def ') && !line.includes('class ')) {
        const commentText = docstringMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'docstring',
            style: '"""',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }
    }

    return comments;
  }

  extractTodos(comments: CASComment[]): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';


        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;


        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: text.replace(/^(TODO|FIXME|HACK|NOTE|WARNING|XXX)\s*(\([^)]+\))?\s*:?\s*/i, '').trim(),
          priority,
          location: {
            file: comment.location.file,
            line: comment.location.line
          },
          assignee,
          classification: {
            category: this.classifyTodoCategory(text),
            technical_debt: type === 'TODO' || type === 'FIXME' || type === 'HACK'
          }
        };

        todos.push(todo);
      }
    }

    return todos;
  }

  determineImplementationStatus(content: string, comments: CASComment[]): CASImplementationStatus {
    const indicators = {
      has_todo_markers: comments.some(c => c.markers?.is_todo),
      has_not_implemented_exceptions: content.includes('NotImplementedError') || content.includes('raise NotImplemented'),
      has_stub_returns: content.includes('pass') && (content.includes('def ') || content.includes('class ')),
      has_placeholder_code: content.includes('# TODO') || content.includes('# FIXME') || content.includes('# PLACEHOLDER'),
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/.test(content),
      has_commented_out_code: comments.some(c => c.text.includes('def ') || c.text.includes('class ') || c.text.includes('import '))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('NotImplementedError') || content.includes('raise NotImplemented')) {
      status = 'not-implemented';
      confidence = 0.95;
    } else if (indicatorCount >= 3) {
      status = 'stub';
      confidence = 0.7;
    } else if (indicatorCount >= 1) {
      status = 'partial';
      confidence = 0.6;
    } else if (content.includes('@deprecated') || content.includes('# deprecated')) {
      status = 'deprecated';
      confidence = 0.9;
    } else if (content.includes('experimental') || content.includes('beta')) {
      status = 'experimental';
      confidence = 0.8;
    } else {
      status = 'complete';
      confidence = 0.7;
    }

    const missingFeatures = [];
    if (indicators.has_not_implemented_exceptions) missingFeatures.push('Core implementation');
    if (indicators.has_todo_markers) missingFeatures.push('TODO items');
    if (indicators.has_stub_returns) missingFeatures.push('Method implementations');

    return {
      status,
      indicators,
      confidence,
      completeness: {
        estimated_percentage: status === 'complete' ? 90 : status === 'partial' ? 60 : status === 'stub' ? 30 : 10,
        missing_features: missingFeatures,
        implemented_features: status === 'complete' ? ['Core functionality'] : []
      }
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const upperText = text.toUpperCase();
    if (upperText.includes('TODO') || upperText.includes('FIXME')) return 'todo';
    if (upperText.includes('WARNING') || upperText.includes('WARN')) return 'warning';
    if (upperText.includes('HACK') || upperText.includes('WORKAROUND')) return 'hack';
    if (upperText.includes('NOTE') || upperText.includes('INFO')) return 'note';
    if (upperText.includes('DISABLED') || upperText.includes('COMMENTED')) return 'disabled-code';
    return 'explanation';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | undefined {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('bug') || lowerText.includes('fix') || lowerText.includes('error')) return 'bug';
    if (lowerText.includes('security') || lowerText.includes('auth') || lowerText.includes('permission')) return 'security';
    if (lowerText.includes('performance') || lowerText.includes('optimize') || lowerText.includes('slow')) return 'performance';
    if (lowerText.includes('test') || lowerText.includes('spec') || lowerText.includes('coverage')) return 'test';
    if (lowerText.includes('refactor') || lowerText.includes('cleanup') || lowerText.includes('reorganize')) return 'refactor';
    if (lowerText.includes('doc') || lowerText.includes('comment') || lowerText.includes('explain')) return 'documentation';
    return 'feature';
  }

  createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'fastapi-routes',
      name: 'FastAPI API Endpoints',
      description: 'API routes and dependency injection showing request processing flow',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['application', 'route', 'endpoint', 'function', 'class', 'method', 'middleware', 'model'],
        relevant_edge_types: ['calls', 'uses', 'exposes', 'includes'],
        node_connections: [
          {
            from_type: 'application',
            to_types: ['route', 'middleware'],
            edge_type: 'includes'
          },
          {
            from_type: 'route',
            to_types: ['function', 'method'],
            edge_type: 'calls'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'http_method'
      }
    });

    perspectives.push({
      id: 'fastapi-layers',
      name: 'FastAPI Application Layers',
      description: 'Application layers: Routes -> Dependencies -> Services -> Models',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['application', 'route', 'endpoint', 'function', 'class', 'method', 'middleware', 'model', 'module', 'file'],
        relevant_edge_types: ['calls', 'uses', 'imports', 'contains'],
        node_connections: [
          {
            from_type: 'route',
            to_types: ['function', 'class'],
            edge_type: 'calls'
          },
          {
            from_type: 'function',
            to_types: ['model'],
            edge_type: 'uses'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR'
      }
    });

    perspectives.push({
      id: 'fastapi-data',
      name: 'FastAPI Data Flow',
      description: 'Data models, schemas, and database access patterns',
      analyzer_id: this.analyzerId,
      type: 'data',
      connection_rules: {
        visible_node_types: ['model', 'class', 'function', 'method', 'attribute'],
        relevant_edge_types: ['uses', 'has_attribute', 'has_method', 'calls']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB'
      }
    });
  }

  tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!node.perspectives) node.perspectives = {};

      const isRoute = node.type === 'route' || node.type === 'endpoint' ||
        node.subcategories?.includes('route') || node.subcategories?.includes('endpoint');
      const isMiddleware = node.type === 'middleware' || node.subcategories?.includes('middleware');
      const isModel = node.type === 'model' || node.subcategories?.includes('model') ||
        node.subcategories?.includes('pydantic');

      if (isRoute || isMiddleware || node.type === 'application') {
        node.perspectives['fastapi-routes'] = {
          hierarchy: ['api', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 90 : 70
        };
      }

      if (node.type !== 'import' && node.type !== 'variable') {
        node.perspectives['fastapi-layers'] = {
          hierarchy: ['layers', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isRoute ? 80 : isModel ? 70 : 50
        };
      }

      if (isModel || node.type === 'attribute' || node.type === 'class') {
        node.perspectives['fastapi-data'] = {
          hierarchy: ['data', node.category || node.type, node.name],
          level: node.level || 2,
          priority: isModel ? 90 : 50
        };
      }
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'calls' || edge.type === 'uses' || edge.type === 'exposes') {
        edge.perspectives.push('fastapi-routes');
      }
      if (edge.type === 'contains' || edge.type === 'imports' || edge.type === 'calls') {
        edge.perspectives.push('fastapi-layers');
      }
    }
  }
}
