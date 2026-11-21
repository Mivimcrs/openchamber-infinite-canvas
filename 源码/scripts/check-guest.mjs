/**
 * 跑官方检查器 `openchamber-guest-check`（@openchamber/sdk 自带），校验整个扩展包。
 *
 * 直接 `node .../check-guest.ts` 会被 Node 拒绝（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING：
 * node_modules 下不做类型擦除），所以先用 esbuild 把它打成一个临时 mjs 再跑。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const pkgDir = root;
const sdkCheck = join(here, '..', 'node_modules', '@openchamber', 'sdk', 'scripts', 'check-guest.ts');
const workDir = mkdtempSync(join(tmpdir(), 'oc-canvas-check-'));
const outfile = join(workDir, 'check-guest.mjs');

try {
  await build({
    entryPoints: [sdkCheck],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
  });

  const result = spawnSync(process.execPath, [outfile, pkgDir], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
