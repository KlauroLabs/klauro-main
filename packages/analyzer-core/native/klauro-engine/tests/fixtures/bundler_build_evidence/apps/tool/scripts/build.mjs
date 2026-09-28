import { build } from 'esbuild';

await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/cli.cjs' });
await build({ entryPoints: ['src/other-tool.ts'], outfile: 'dist/other-tool.cjs' });
