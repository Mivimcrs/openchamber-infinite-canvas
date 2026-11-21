/**
 * 用宿主同一份 schema（@openchamber/sdk/schemas 的 parseManifestJson）校验仓库根的
 * package.json —— 装之前就知道会不会被拒，不用在设置里试错。
 *
 * 注意：parseManifestJson 不抛异常，返回 { ok, code, message } 或
 * { ok: true, manifest, version }。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestJson } from '@openchamber/sdk/schemas';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const pkgPath = join(root, 'package.json');
const text = readFileSync(pkgPath, 'utf8');

const result = parseManifestJson(text);

if (!result.ok) {
  console.error(`manifest INVALID [${result.code ?? 'unknown'}]`);
  console.error(result.message ?? JSON.stringify(result));
  process.exitCode = 1;
} else {
  const service = result.manifest?.contributes?.service;
  console.log('manifest OK');
  console.log(`  version       ${result.version ?? '(none)'}`);
  console.log(`  panel         ${result.manifest?.contributes?.panel?.entry ?? '(none)'}`);
  console.log(`  statusSection ${result.manifest?.contributes?.statusSection?.entry ?? '(none)'}`);
  console.log(`  service       ${service?.entry ?? '(none)'} runtime=${service?.runtime ?? '-'} exec=${(service?.permissions?.exec ?? []).join(',') || '-'}`);
}
