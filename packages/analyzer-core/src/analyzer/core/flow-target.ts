import type { CASOutput } from '../../types/cas.types';

type MaterializedFlow = NonNullable<CASOutput['flows']>[number];

export function flowTargetMatcher(cas: CASOutput, target: string): (flow: MaterializedFlow) => boolean {
  const capabilityNames = new Map((cas.capabilities || []).map(capability => [capability.id, capability.name]));
  const routed = /^([\w/]+)#(\w+)$/.exec(target);
  return flow => (routed !== null && flow.entry_point.toLowerCase().includes(`${routed[1]}_controller.rb:function:${routed[2]}:`)) || [
    flow.flow_id,
    flow.name,
    flow.intent,
    flow.entry_point,
    ...(flow.capability_relationships || []).flatMap(relationship => [
      relationship.capability_id,
      capabilityNames.get(relationship.capability_id),
    ]),
    ...flow.entities,
    ...flow.steps.flatMap(step => [
      step.step_id,
      step.name,
      step.description,
      ...step.entities,
      ...step.functions.map(fn => fn.function_id),
    ]),
  ].some(value => String(value || '').toLowerCase().includes(target));
}
