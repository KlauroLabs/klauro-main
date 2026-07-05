import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudFormationAnalyzer } from './cloudformation-analyzer';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('CloudFormationAnalyzer extracts AWS resources and Ref/GetAtt dependency edges', async () => {
  const dir = tempDir('cloudformation-test');
  try {
    fs.writeFileSync(path.join(dir, 'template.yaml'), [
      'AWSTemplateFormatVersion: "2010-09-09"',
      'Resources:',
      '  OrdersQueue:',
      '    Type: AWS::SQS::Queue',
      '    Properties:',
      '      QueueName: orders',
      '  OrdersFunction:',
      '    Type: AWS::Lambda::Function',
      '    Properties:',
      '      FunctionName: orders-handler',
      '      Runtime: nodejs22.x',
      '      Handler: index.handler',
      '      Environment:',
      '        Variables:',
      '          QUEUE_URL: !Ref OrdersQueue',
      '  OrdersPolicy:',
      '    Type: AWS::IAM::Policy',
      '    Properties:',
      '      PolicyName: orders-policy',
      '      Roles:',
      '        - !GetAtt OrdersFunction.Arn',
      '',
    ].join('\n'));

    const analyzer = new CloudFormationAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
    const cas = await analyzer.analyze({ projectPath: dir });

    const queue = cas.nodes.find(node => node.type === 'aws_sqs_queue');
    const fn = cas.nodes.find(node => node.type === 'aws_lambda_function');
    const policy = cas.nodes.find(node => node.type === 'aws_iam_policy');
    assert.ok(queue, 'queue node exists');
    assert.ok(fn, 'lambda function node exists');
    assert.ok(policy, 'policy node exists');
    assert.equal(queue?.metadata?.queue_name, 'orders');
    assert.equal(fn?.metadata?.function_name, 'orders-handler');

    assert.ok(cas.edges.find(edge => edge.type === 'depends_on' && edge.source === fn!.id && edge.target === queue!.id));
    assert.ok(cas.edges.find(edge => edge.type === 'depends_on' && edge.source === policy!.id && edge.target === fn!.id));
    assert.ok(cas.entry_points.find(entry => entry.type === 'file'));
    assert.equal(cas.exit_points.filter(exit => exit.metadata?.topology_surface === 'cloudformation').length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
