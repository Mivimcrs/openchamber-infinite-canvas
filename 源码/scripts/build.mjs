/**
 * 把 源码/status/main.ts 与 源码/service/main.ts 打成两个独立产物，直接落到仓库根：
 *   status/main.js   （浏览器 IIFE）
 *   service/main.mjs （Node ESM）
 * 仓库根就是可安装的扩展包：package.json 里的 manifest 指到这两个文件。
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const root = join(src, '..');

rmSync(join(root, 'status'), { recursive: true, force: true });
rmSync(join(root, 'service'), { recursive: true, force: true });
mkdirSync(join(root, 'status'), { recursive: true });
mkdirSync(join(root, 'service'), { recursive: true });

await build({
  entryPoints: [join(src, 'status', 'main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  charset: 'utf8',
  outfile: join(root, 'status', 'main.js'),
});

await build({
  entryPoints: [join(src, 'service', 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  charset: 'utf8',
  outfile: join(root, 'service', 'main.mjs'),
});

cpSync(join(src, 'status', 'index.html'), join(root, 'status', 'index.html'));

console.log('built ->', root);
