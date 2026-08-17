jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PythonAnalyzer } from '../../../analyzer/languages/python-analyzer';

describe('PythonAnalyzer process boundaries', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'python-boundaries-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  it('does not model ordinary library calls as process-boundary exits', async () => {
    const filePath = path.join(projectPath, 'formatting.py');
    await fs.writeFile(filePath, [
      'import datetime',
      'import io',
      'import re',
      'import requests',
      '',
      'def format_payload(value):',
      '    parsed = datetime.datetime.strptime(value, "%Y-%m-%d")',
      '    buffer = io.BytesIO()',
      '    cleaned = re.sub("x", "", value)',
      '    requests.post("https://example.test/events")',
      '    return parsed, buffer, cleaned',
      '',
    ].join('\n'), 'utf8');

    const result = await new PythonAnalyzer().analyzeFileSingle({
      projectPath,
      filePath,
      relativePath: 'formatting.py',
    });

    expect(result.exitPoints.filter(exitPoint => exitPoint.type === 'sdk')).toEqual([]);
    expect(result.exitPoints.some(exitPoint => exitPoint.target?.endpoint === 'strptime')).toBe(false);
    expect(result.exitPoints.some(exitPoint => exitPoint.target?.endpoint === 'BytesIO')).toBe(false);
    expect(result.exitPoints.some(exitPoint => exitPoint.target?.endpoint === 'post')).toBe(false);
  });
});
