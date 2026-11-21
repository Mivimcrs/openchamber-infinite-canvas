#!/usr/bin/env node
// 公开仓库卫生检查：清单、入口、版本、以及本机路径/密钥是否混进了将公开的文件。
// 用法：node 源码/scripts/check-repo.mjs   （在仓库根或 源码 下都可）
// 退出码：0 通过；1 失败。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const failures = [];
const passes = [];

const fail = (message) => failures.push(message);
const pass = (message) => passes.push(message);
const read = (path) => readFileSync(path, 'utf8');
const readJson = (path) => {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    fail(`${relative(root, path)} 不是合法 JSON：${error.message}`);
    return null;
  }
};

const pkg = readJson(join(root, 'package.json'));
const srcPkg = readJson(join(root, '源码', 'package.json'));

if (pkg) {
  if (pkg.name !== 'openchamber-infinite-canvas') fail('package.json name 应为 openchamber-infinite-canvas');
  else pass('name');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) fail(`version 不是 semver：${pkg.version}`);
  else pass(`version ${pkg.version}`);
  if (pkg.openchamber?.apiVersion !== 1) fail('openchamber.apiVersion 应为 1');
  else pass('apiVersion');
  if (!pkg.license) fail('package.json 缺 license');
  else pass(`license ${pkg.license}`);
  if (srcPkg && srcPkg.version !== pkg.version) fail(`源码/package.json 版本 ${srcPkg.version} 与根版本 ${pkg.version} 不一致`);
}

if (existsSync(join(root, 'README.md'))) pass('README.md'); else fail('缺 README.md');
if (existsSync(join(root, 'LICENSE'))) pass('LICENSE'); else fail('缺 LICENSE');
if (existsSync(join(root, 'icon.svg'))) pass('icon.svg'); else fail('缺 icon.svg');

const manifest = pkg?.openchamber?.contributes;
const entries = [
  manifest?.panel?.entry,
  manifest?.statusSection?.entry,
  manifest?.service?.entry,
].filter(Boolean);
for (const entry of entries) {
  if (existsSync(join(root, entry))) pass(`入口 ${entry}`);
  else fail(`入口不存在：${entry}`);
}

// 扫描将公开的文本：源码、构建产物与文档，不含 node_modules。
// 本文件自己带着要查的模式串，跳过它，免得自报。
const scopes = ['package.json', 'status', 'service', 'icon.svg', 'README.md', 'LICENSE', '文档', '踩坑日志.md', '源码'];
const textExt = /\.(js|mjs|ts|json|md|html|svg|txt|yml|yaml)$/i;
const skip = new Set(['check-repo.mjs', 'package-lock.json']);
const machinePaths = /[A-Z]:\\|\/Users\/|\/home\//;
const secrets = [/gho_[A-Za-z0-9]{10,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9]{12,}/];
const hits = [];

const scanFile = (full) => {
  if (!textExt.test(full) || skip.has(full.split(/[\\/]/).pop())) return;
  const text = read(full);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (machinePaths.test(line)) hits.push(`${relative(root, full)}:${index + 1} 含本机绝对路径：${line.trim().slice(0, 120)}`);
    for (const pattern of secrets) {
      if (pattern.test(line)) hits.push(`${relative(root, full)}:${index + 1} 疑似密钥：${line.trim().slice(0, 80)}`);
    }
  });
};

const walk = (absolute) => {
  if (!existsSync(absolute)) return;
  if (statSync(absolute).isFile()) {
    scanFile(absolute);
    return;
  }
  const info = readdirSync(absolute, { withFileTypes: true });
  for (const item of info) {
    if (item.name === 'node_modules' || item.name === '.git') continue;
    const full = join(absolute, item.name);
    if (item.isDirectory()) walk(full);
    else scanFile(full);
  }
};

for (const scope of scopes) walk(join(root, scope));

if (hits.length) {
  for (const hit of hits) fail(hit);
} else {
  pass('没有本机路径、私有目录或密钥');
}

for (const message of passes) console.log(`  ok  ${message}`);
for (const message of failures) console.error(`  !!  ${message}`);
console.log(failures.length ? `\n仓库检查失败（${failures.length} 项）` : '\n仓库检查通过');
process.exitCode = failures.length ? 1 : 0;
