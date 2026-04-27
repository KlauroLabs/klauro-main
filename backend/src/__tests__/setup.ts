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
