import test from 'node:test';
import assert from 'node:assert/strict';
import { runInterfaceSignatureBench } from './interface-signature-bench';

test('interface-signature-bench: one call answers what took 4 (I/L/S/O join matches manual join)', async () => {
  const report = await runInterfaceSignatureBench();

  assert.equal(report.function_level.has_input, true, 'signature.input should be non-empty (params + entry points)');
  assert.equal(report.function_level.has_output, true, 'signature.output should be an array');
  assert.equal(report.function_level.has_side_effects, true, 'signature.side_effects should be non-empty (exit points + lineage)');
  assert.equal(report.function_level.has_logic, true, 'signature.logic.callers_total should be a number');

  assert.equal(
    report.function_level.input_matches_manual_join,
    true,
    'input should include the real function params and the real entry points, matching the manual get_entry_points join'
  );
  assert.equal(
    report.function_level.side_effects_matches_manual_join,
    true,
    'side_effects should include the real exit points for this node, matching the manual get_exit_points + get_data_lineage join'
  );
  assert.equal(
    report.function_level.logic_callers_total_matches,
    true,
    'logic.callers_total should match get_callers total for the same node'
  );

  assert.equal(
    report.function_level.one_call_contains_all_four_dimensions,
    true,
    'a single get_interface_signature call should contain input, output, side_effects, and logic together'
  );

  assert.equal(report.project_level.has_all_four, true, 'project-level rollup should aggregate input/output/side_effects/logic from product_map + entry/exit points');

  assert.equal(report.passed, true);
});
