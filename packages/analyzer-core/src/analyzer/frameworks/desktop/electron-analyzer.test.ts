import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { ElectronAnalyzer } from './electron-analyzer';

/**
 * Fixture shape mirrors a real Electron app (electron-vite / electron-toolkit
 * boilerplate + hand-rolled IPC modules, as seen in yisda-desktop): a main
 * process with `app.whenReady` + `BrowserWindow`, IPC handlers registered via
 * `ipcMain.handle`/`ipcMain.on` inside a per-module `setup(ipcMain)` function, a
 * renderer-side `*.ipc.ts` wrapper using `ipcRenderer.invoke`/`.send`, and a
 * preload script exposing both via `contextBridge.exposeInMainWorld`.
 */
async function makeElectronFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'electron-fixture',
    dependencies: { electron: '^28.0.0' },
  });

  await fs.ensureDir(path.join(root, 'src', 'main', 'modules', 'auth'));
  await fs.writeFile(
    path.join(root, 'src', 'main', 'index.js'),
    `import { app, BrowserWindow } from 'electron'
import { AuthHandlers } from './modules/auth/auth.handlers'
import { ipcMain } from 'electron'

function createWindow() {
  const mainWindow = new BrowserWindow({ width: 900, height: 670 })
  mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
  AuthHandlers.setup(ipcMain)
  createWindow()
})
`
  );

  await fs.writeFile(
    path.join(root, 'src', 'main', 'modules', 'auth', 'auth.handlers.js'),
    `export const AuthHandlers = {
  setup: (ipcMain) => {
    ipcMain.handle('auth:get-profile', getProfile)
    ipcMain.on('auth:log-out', () => {
      app.quit()
    })
  }
}
`
  );

  await fs.writeFile(
    path.join(root, 'src', 'main', 'modules', 'auth', 'auth.ipc.js'),
    `import { ipcRenderer } from 'electron'

export const AuthIPC = {
  getProfile: () => ipcRenderer.invoke('auth:get-profile'),
  logout: () => ipcRenderer.send('auth:log-out')
}
`
  );

  await fs.ensureDir(path.join(root, 'src', 'preload'));
  await fs.writeFile(
    path.join(root, 'src', 'preload', 'index.js'),
    `import { contextBridge } from 'electron'
import { AuthIPC } from '../main/modules/auth/auth.ipc'

contextBridge.exposeInMainWorld('YisdaEvents', AuthIPC)
`
  );

  return root;
}

test('ElectronAnalyzer canAnalyze detects electron dependency + usage', async () => {
  const root = await makeElectronFixture();
  try {
    const analyzer = new ElectronAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('ElectronAnalyzer canAnalyze is false without electron dependency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-analyzer-none-'));
  try {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'no-electron', dependencies: { react: '^18.0.0' } });
    const analyzer = new ElectronAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('ElectronAnalyzer surfaces ipcMain.handle/.on as ipc entry points', async () => {
  const root = await makeElectronFixture();
  try {
    const analyzer = new ElectronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const ipcEntries = contribution.entry_points.filter(ep => ep.type === 'ipc');
    assert.strictEqual(ipcEntries.length, 2);

    const getProfile = ipcEntries.find(ep => ep.metadata?.channel === 'auth:get-profile');
    assert.ok(getProfile, 'should emit an entry point for auth:get-profile');
    assert.strictEqual(getProfile!.metadata?.ipcMethod, 'handle');
    assert.strictEqual(getProfile!.handler?.method_name, 'getProfile');

    const logOut = ipcEntries.find(ep => ep.metadata?.channel === 'auth:log-out');
    assert.ok(logOut, 'should emit an entry point for auth:log-out');
    assert.strictEqual(logOut!.metadata?.ipcMethod, 'on');
  } finally {
    await fs.remove(root);
  }
});

test('ElectronAnalyzer resolves ipcRenderer.invoke/.send call sites to their ipcMain handler', async () => {
  const root = await makeElectronFixture();
  try {
    const analyzer = new ElectronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const invokeNode = contribution.nodes.find(n => n.type === 'ipc_call' && n.metadata?.attributes?.channel === 'auth:get-profile');
    assert.ok(invokeNode, 'should emit a call-site node for the invoke()');

    const handlerNode = contribution.nodes.find(n => n.type === 'ipc_handler' && n.metadata?.attributes?.channel === 'auth:get-profile');
    assert.ok(handlerNode, 'should emit the matching ipc_handler node');

    const invokesEdge = contribution.edges.find(e => e.type === 'invokes' && e.source === invokeNode!.id && e.target === handlerNode!.id);
    assert.ok(invokesEdge, 'should link the renderer call site to the main-process handler by channel');
  } finally {
    await fs.remove(root);
  }
});

test('ElectronAnalyzer surfaces contextBridge.exposeInMainWorld as an exposed API surface node', async () => {
  const root = await makeElectronFixture();
  try {
    const analyzer = new ElectronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const exposed = contribution.nodes.find(n => n.type === 'exposed_api');
    assert.ok(exposed, 'should emit an exposed_api node');
    assert.strictEqual(exposed!.metadata?.attributes?.key, 'YisdaEvents');
  } finally {
    await fs.remove(root);
  }
});

test('ElectronAnalyzer surfaces BrowserWindow creation and app.whenReady as an application', async () => {
  const root = await makeElectronFixture();
  try {
    const analyzer = new ElectronAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const appNode = contribution.nodes.find(n => n.type === 'application' && n.id === 'app_electron');
    assert.ok(appNode, 'should emit an Electron application node');

    const windowNode = contribution.nodes.find(n => n.type === 'window');
    assert.ok(windowNode, 'should emit a window node for the BrowserWindow construction');
  } finally {
    await fs.remove(root);
  }
});
