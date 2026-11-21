/**
 * 无限画布开关 —— 本机服务。
 *
 * 面板运行在不透明来源的沙箱 iframe 里，只经 host.serviceRequest 调到这里。
 * 这个进程负责三件事：
 *   1. 起停本机桥接服务（@basketikun/canvas-agent，127.0.0.1:17371）
 *   2. 增删 ~/.config/opencode/opencode.json 里的 infinite-canvas MCP 配置块
 *   3. 汇总状态给面板（端口、画布连接数、MCP 是否写入）
 *
 * 一半是进程操作，一半是配置文本的手术式编辑：绝不整份重写 opencode.json，
 * 每次写完都先 JSON.parse 校验，并在写前备份。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

const HOME = homedir();
const CONFIG_FILE = join(HOME, '.config', 'opencode', 'opencode.json');
const AGENT_CFG = join(HOME, '.infinite-canvas', 'canvas-agent.json');
/** 宿主给每个扩展分配的私有数据目录；单独跑时退回到用户目录下的固定位置。 */
const DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR || join(HOME, '.openchamber-infinite-canvas');
const LOG_DIR = join(DATA_DIR, 'logs');
const AGENT_VERSION = '0.6.0';
const AGENT_REL = join('node_modules', '@basketikun', 'canvas-agent', 'dist', 'index.js');
const BRIDGE_PORT = 17371;
const BRIDGE_DEFAULT_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
/** 画布站点固定指向 canvas.best；自建/镜像站点可用 CANVAS_SITE 覆盖（要带 /canvas 路径）。 */
const CANVAS_SITE = process.env.CANVAS_SITE || 'https://canvas.best/canvas';
const BACKUPS_KEPT = 10;

/**
 * 依序查找 canvas-agent 的 dist/index.js：
 *   1. CANVAS_AGENT_JS（给把 agent 装在别处的用户）
 *   2. ~/.infinite-canvas/agent（README 推荐的安装位置）
 *   3. <扩展数据目录>/agent
 * 第一个存在的即采用；都没有时由 ensureBridge / setMcp 给出安装命令。
 */
const agentCandidates = (): string[] => [
  process.env.CANVAS_AGENT_JS || '',
  join(HOME, '.infinite-canvas', 'agent', AGENT_REL),
  join(DATA_DIR, 'agent', AGENT_REL),
].filter((path) => Boolean(path));

const resolveAgentJs = (): string | null => {
  for (const candidate of agentCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const agentInstallHint = (): string => [
  `找不到 Canvas Agent（@basketikun/canvas-agent ${AGENT_VERSION}）。`,
  '安装命令：',
  `npm install --prefix "${join(HOME, '.infinite-canvas', 'agent')}" @basketikun/canvas-agent@${AGENT_VERSION}`,
  '已经装在别处的话，把用户环境变量 CANVAS_AGENT_JS 指向 ...\\dist\\index.js 后重启 OpenChamber。',
].join('\n');

const mcpConfig = (agentJs: string) => ({
  type: 'local',
  command: ['node', agentJs, 'mcp'],
  enabled: true,
  timeout: 120000,
});

/** 与 opencode.json 里实际写入的形状保持一致，缩进按文件里的 mcp 段（4 空格键、6 空格值）。 */
const mcpBlock = (agentJs: string): string => {
  const lines = JSON.stringify(mcpConfig(agentJs), null, 2).split('\n');
  return `${lines.map((line, index) => (index === 0 ? `    "infinite-canvas": ${line}` : `    ${line}`)).join('\n')},`;
};

const BLOCK_ANY_RE = /"infinite-canvas"\s*:\s*\{[^{}]*?\}/;
/** 带后置逗号的块，连同它前面的空白一起吃掉，避免在 mcp 段里留下空行。 */
const BLOCK_FIRST_RE = /[\r\n]*[ \t]*"infinite-canvas"\s*:\s*\{[^{}]*?\}\s*,/;
/** 最后一个条目（没有后置逗号）：吃掉前置逗号和前置空白。 */
const BLOCK_LAST_RE = /,[\r\n]*[ \t]*"infinite-canvas"\s*:\s*\{[^{}]*?\}(?=[\r\n]*[ \t]*\})/;
const ENABLED_RE = /("infinite-canvas"\s*:\s*\{[^{}]*?"enabled"\s*:\s*)(true|false)/;
const MCP_ANCHOR_RE = /"mcp"\s*:\s*\{/;

class ServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64 * 1024) {
      reject(new ServiceError(413, '请求体过大'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/* ------------------------------------------------------------------ 日志 */

const log = (line: string): void => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    writeFileSync(join(LOG_DIR, 'service.log'), `[${stamp}] ${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch { /* 日志失败不影响主流程 */ }
};

/* ------------------------------------------------------------ 桥接服务 */

const isListening = (): Promise<boolean> => new Promise((resolve) => {
  const socket = connect({ port: BRIDGE_PORT, host: '127.0.0.1' });
  const done = (value: boolean) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(700);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const readAgentConfig = (): { url: string; token: string } | null => {
  if (!existsSync(AGENT_CFG)) return null;
  try {
    const parsed = JSON.parse(readFileSync(AGENT_CFG, 'utf8')) as { url?: string; token?: string };
    if (!parsed.token) return null;
    return { url: parsed.url || BRIDGE_DEFAULT_URL, token: parsed.token };
  } catch {
    return null;
  }
};

const health = async (): Promise<{ ok: boolean; clients: number; hasCanvas: boolean } | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${BRIDGE_DEFAULT_URL}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; clients?: number; hasCanvas?: boolean };
    return { ok: Boolean(body.ok), clients: Number(body.clients ?? 0), hasCanvas: Boolean(body.hasCanvas) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** 起桥接：已监听就复用，否则分离启动并等到端口和 token 都就绪。 */
const ensureBridge = async (): Promise<{ started: boolean; detail: string }> => {
  if (await isListening()) return { started: false, detail: '桥接已在运行，复用现有实例' };
  const agentJs = resolveAgentJs();
  if (!agentJs) throw new ServiceError(500, agentInstallHint());
  const child = spawn(process.execPath, [agentJs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`启动桥接 pid=${child.pid ?? '?'} agent=${agentJs}`);

  // 宿主对面板请求的默认等待是 20 秒，这里留出余量，超时也要在宿主放弃前给出人话。
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if ((await isListening()) && readAgentConfig()) return { started: true, detail: `桥接已启动（pid ${child.pid ?? '?'}）` };
  }
  throw new ServiceError(504, `桥接启动超时：127.0.0.1:${BRIDGE_PORT} 一直没就绪，稍后再点一次「开启」试试。`);
};

/** 按进程树收掉桥接：先子进程（Codex app-server），再父进程。 */
const stopBridge = async (): Promise<{ stopped: boolean; detail: string }> => {
  if (!(await isListening())) return { stopped: false, detail: '桥接本来就没在运行' };
  const script = [
    `$conn = Get-NetTCPConnection -LocalPort ${BRIDGE_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($conn) {',
    '  $procId = $conn.OwningProcess',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('; ');
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], (error) => {
      if (error) reject(new ServiceError(500, `停止桥接失败：${error.message}`));
      else resolve();
    });
  });
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    if (!(await isListening())) {
      log('桥接已停止');
      return { stopped: true, detail: '桥接进程树已停止' };
    }
  }
  throw new ServiceError(500, '桥接进程仍在监听 17371，可能被其它程序占用');
};

/* --------------------------------------------------------- MCP 配置块 */

const readConfig = (): string => {
  if (!existsSync(CONFIG_FILE)) return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  return readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
};

const backupConfig = (text: string): void => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    copyFileSync(CONFIG_FILE, join(LOG_DIR, `opencode.backup.${stamp}.json`));
    const backups = readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('opencode.backup.'))
      .map((name) => ({ name, mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const extra of backups.slice(BACKUPS_KEPT)) unlinkSync(join(LOG_DIR, extra.name));
  } catch {
    log('配置备份失败（继续写入）');
  }
  void text;
};

const writeConfig = (next: string): void => {
  try {
    JSON.parse(next);
  } catch (error) {
    throw new ServiceError(500, `生成的 JSON 不合法，已放弃写入：${(error as Error).message}`);
  }
  mkdirSync(join(HOME, '.config', 'opencode'), { recursive: true });
  writeFileSync(CONFIG_FILE, next, 'utf8');
};

const mcpEnabled = (): boolean => BLOCK_ANY_RE.test(readConfig());

const setMcp = (on: boolean): { changed: boolean; detail: string } => {
  const text = readConfig();
  const had = BLOCK_ANY_RE.test(text);

  if (on) {
    if (ENABLED_RE.test(text)) {
      const next = text.replace(ENABLED_RE, '$1true');
      if (next === text) return { changed: false, detail: 'MCP 配置已在' };
      backupConfig(text);
      writeConfig(next);
      return { changed: true, detail: 'MCP 配置已写回 enabled=true' };
    }
    if (had) return { changed: false, detail: 'MCP 配置已在' };
    const agentJs = resolveAgentJs();
    if (!agentJs) throw new ServiceError(500, agentInstallHint());
    backupConfig(text);
    const emptyMcp = /"mcp"\s*:\s*\{\s*\}/.test(text);
    if (!MCP_ANCHOR_RE.test(text) || emptyMcp) {
      // 没有 mcp 段（新装的 OpenCode 常见），或 mcp 是空对象：整份解析后补一段。
      // 只有这条路径会重排格式；已有条目的文件仍走下面的手术式插入。
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const existing = parsed.mcp && typeof parsed.mcp === 'object' && !Array.isArray(parsed.mcp)
        ? parsed.mcp as Record<string, unknown>
        : {};
      parsed.mcp = { ...existing, 'infinite-canvas': mcpConfig(agentJs) };
      writeConfig(`${JSON.stringify(parsed, null, 2)}\n`);
      return { changed: true, detail: 'MCP 配置块已写入（原文件没有 mcp 条目，已补上）' };
    }
    const next = text.replace(MCP_ANCHOR_RE, (anchor) => `${anchor}\n${mcpBlock(agentJs)}`);
    writeConfig(next);
    return { changed: true, detail: 'MCP 配置块已写入' };
  }

  if (!had) return { changed: false, detail: 'MCP 配置本来就没有' };
  backupConfig(text);
  const next = BLOCK_FIRST_RE.test(text)
    ? text.replace(BLOCK_FIRST_RE, '')
    : text.replace(BLOCK_LAST_RE, '');
  writeConfig(next);
  return { changed: true, detail: 'MCP 配置块已移除' };
};

/* ---------------------------------------------------------------- 状态 */

type Step = { name: string; ok: boolean; detail: string };

const snapshot = async () => {
  const listening = await isListening();
  const agent = readAgentConfig();
  const agentJs = resolveAgentJs();
  const healthInfo = listening ? await health() : null;
  return {
    bridge: {
      listening,
      clients: healthInfo?.clients ?? 0,
      hasCanvas: Boolean(healthInfo?.hasCanvas),
      url: agent?.url ?? BRIDGE_DEFAULT_URL,
    },
    mcp: { enabled: mcpEnabled(), path: CONFIG_FILE },
    agent: { installed: Boolean(agentJs), path: agentJs, hasToken: Boolean(agent?.token) },
  };
};

const canvasLink = (): string => {
  const agent = readAgentConfig();
  if (!agent) return '';
  return `${CANVAS_SITE}?mode=recent#agentUrl=${agent.url}&agentToken=${agent.token}`;
};

const waitForCanvas = async (): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const info = await health();
    if (info?.hasCanvas) return true;
  }
  return false;
};

const turnOn = async () => {
  const steps: Step[] = [];
  try {
    const bridge = await ensureBridge();
    steps.push({ name: '桥接服务', ok: true, detail: bridge.detail });
  } catch (error) {
    steps.push({ name: '桥接服务', ok: false, detail: (error as Error).message });
    log(`开启失败：${(error as Error).message}`);
    return { ok: false, steps, status: await snapshot(), openUrl: '' };
  }

  try {
    const mcp = setMcp(true);
    steps.push({ name: 'MCP 配置', ok: true, detail: mcp.detail });
    log(`开启：${mcp.detail}`);
  } catch (error) {
    steps.push({ name: 'MCP 配置', ok: false, detail: (error as Error).message });
    return { ok: false, steps, status: await snapshot(), openUrl: '' };
  }

  const link = canvasLink();
  steps.push({ name: '画布网页', ok: Boolean(link), detail: link ? '正在打开（mode=recent）' : '缺少 token，先重启一次桥接' });
  return { ok: true, steps, status: await snapshot(), openUrl: link };
};

const turnOff = async () => {
  const steps: Step[] = [];
  let ok = true;

  try {
    const mcp = setMcp(false);
    steps.push({ name: 'MCP 配置', ok: true, detail: mcp.detail });
    log(`关闭：${mcp.detail}`);
  } catch (error) {
    ok = false;
    steps.push({ name: 'MCP 配置', ok: false, detail: (error as Error).message });
  }

  try {
    const bridge = await stopBridge();
    steps.push({ name: '桥接进程树', ok: true, detail: bridge.detail });
  } catch (error) {
    ok = false;
    steps.push({ name: '桥接进程树', ok: false, detail: (error as Error).message });
  }

  steps.push({ name: '浏览器', ok: true, detail: '按约定不动，那一页会显示未连接' });
  return { ok, steps, status: await snapshot(), openUrl: '' };
};

/* ---------------------------------------------------------------- 路由 */

const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      send(res, 200, await snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/on') {
      await readBody(req);
      send(res, 200, await turnOn());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/off') {
      await readBody(req);
      send(res, 200, await turnOff());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      await readBody(req);
      const bridge = await ensureBridge();
      const link = canvasLink();
      send(res, 200, { ok: Boolean(link), steps: [{ name: '桥接服务', ok: true, detail: bridge.detail }], status: await snapshot(), openUrl: link });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/probe') {
      await readBody(req);
      send(res, 200, { canvasReady: await waitForCanvas(), status: await snapshot() });
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    const failure = error instanceof ServiceError
      ? error
      : new ServiceError(500, error instanceof Error ? error.message : String(error));
    send(res, failure.status, { error: failure.message });
  }
});

if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required.');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`无限画布开关 service listening on 127.0.0.1:${PORT}`);
});
