import type { CASEdge, CASNode } from '../../types/cas.types';

export interface ClassFieldSource {
  name: string;
  type?: string;
  isStatic?: boolean;
  isPrivate?: boolean;
  isReadonly?: boolean;
  isOptional?: boolean;
  defaultValue?: string;
  decorators?: string[];
  decoratorArgs?: unknown;
  lineStart: number;
  lineEnd: number;
}

interface NodeBuilder {
  withLevel(level: number, name: string): NodeBuilder;
  withCategory(category: string, subcategories: string[]): NodeBuilder;
  withSource(source: { file: string; line: number; end_line: number }): NodeBuilder;
  withMetadata(metadata: Record<string, unknown>): NodeBuilder;
  withSignature(signature: Record<string, unknown>): NodeBuilder;
  withParent(parentId: string): NodeBuilder;
  build(): CASNode;
}

export interface EmitClassFieldsInput {
  properties: readonly ClassFieldSource[];
  ownerName: string;
  classId: string;
  filePath: string;
  nodes: CASNode[];
  edges: CASEdge[];
  buildNode: (id: string, name: string) => NodeBuilder;
  buildEdge: (id: string, from: string, to: string) => CASEdge;
  decoratorArgsAttribute: (args: unknown) => unknown;
}

export function emitClassFields(input: EmitClassFieldsInput): void {
  input.properties.forEach((property, index) => {
    const propertyId = `property_${input.classId}_${property.name}_${index}`;
    input.nodes.push(input.buildNode(propertyId, property.name)
      .withLevel(3, 'Method/Function')
      .withCategory('structures', ['class-fields'])
      .withSource({ file: input.filePath, line: property.lineStart, end_line: property.lineEnd })
      .withMetadata({
        attributes: {
          type: property.type,
          ownerType: input.ownerName,
          isStatic: property.isStatic,
          isPrivate: property.isPrivate,
          isReadonly: property.isReadonly,
          isOptional: property.isOptional,
          defaultValue: property.defaultValue,
          decorators: property.decorators && property.decorators.length > 0 ? property.decorators : undefined,
          decoratorArgs: input.decoratorArgsAttribute(property.decoratorArgs),
        },
      })
      .withSignature({ return_type: property.type })
      .withParent(input.classId)
      .build());

    input.edges.push(input.buildEdge(`${input.classId}_has_field_${propertyId}`, input.classId, propertyId));
  });
}
