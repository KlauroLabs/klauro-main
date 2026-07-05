import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LinuxKernelModuleAnalyzer } from './linux-kernel-module-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-module-analyzer-test-'));

  const driverC = [
    '#include <linux/module.h>',
    '#include <linux/fs.h>',
    '#include <linux/uaccess.h>',
    '',
    'static int dev_open(struct inode *inode, struct file *file) {',
    '  return 0;',
    '}',
    '',
    'static ssize_t dev_read(struct file *file, char *buf, size_t len, loff_t *off) {',
    '  return 0;',
    '}',
    '',
    'static struct file_operations fops = {',
    '  .open = dev_open,',
    '  .read = dev_read,',
    '};',
    '',
    'static int __init mychar_init(void) {',
    '  return register_chrdev(0, "mychar", &fops);',
    '}',
    '',
    'static void __exit mychar_exit(void) {',
    '  unregister_chrdev(0, "mychar");',
    '}',
    '',
    'module_init(mychar_init);',
    'module_exit(mychar_exit);',
    'MODULE_LICENSE("GPL");',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'mychar.c'), driverC);

  return dir;
}

test('LinuxKernelModuleAnalyzer canAnalyze detects linux/module.h evidence', async () => {
  const dir = makeTempProject();
  const analyzer = new LinuxKernelModuleAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('LinuxKernelModuleAnalyzer surfaces module_init/module_exit and fops handlers as driver entry points', async () => {
  const dir = makeTempProject();
  const analyzer = new LinuxKernelModuleAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const entryPoints = cas.entry_points || [];
  assert.ok(entryPoints.every(ep => ep.type === 'driver'), 'all kernel-module entry points should be type driver');

  const initEp = entryPoints.find(ep => ep.handler?.method_name === 'mychar_init');
  const exitEp = entryPoints.find(ep => ep.handler?.method_name === 'mychar_exit');
  const openEp = entryPoints.find(ep => ep.handler?.method_name === 'dev_open');
  const readEp = entryPoints.find(ep => ep.handler?.method_name === 'dev_read');

  assert.ok(initEp, 'expected module_init entry point resolved to mychar_init');
  assert.ok(exitEp, 'expected module_exit entry point resolved to mychar_exit');
  assert.ok(openEp, 'expected fops.open entry point resolved to dev_open');
  assert.ok(readEp, 'expected fops.read entry point resolved to dev_read');
  assert.equal(openEp?.metadata?.fops_field, 'open');
  assert.equal(readEp?.metadata?.fops_field, 'read');
});
