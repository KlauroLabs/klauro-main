jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    ...jest.requireActual('fs').promises,
    readFile: jest.fn(),
    access: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn()
  },
  existsSync: jest.fn(jest.requireActual('fs').existsSync)
}));

jest.mock('fs-extra', () => ({
  ...jest.requireActual('fs-extra'),
  readFile: jest.fn(),
  pathExists: jest.fn(),
  readJson: jest.fn()
}));

const mockGlob = jest.fn();

jest.mock('glob', () => ({
  glob: mockGlob,
  default: mockGlob,
}));

// Comprehension is AI-only and THROWS when attempted without a provider
// (docs/cas/DETERMINISM-BOUNDARY.md). The default test mode is STRUCTURE-ONLY
// (Camp-B): unless a test explicitly opts into AI comprehension (by setting
// KLAURO_AI_INTERPRETATION=true and mocking aiService), the pipeline runs with
// comprehension disabled so structural assertions don't trip the AI-required
// throw. Tests that assert comprehension behavior set the env themselves.
if (process.env.KLAURO_AI_INTERPRETATION === undefined) {
  process.env.KLAURO_AI_INTERPRETATION = 'false';
}
if (process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS === undefined) {
  process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
}
