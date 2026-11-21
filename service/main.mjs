// service/main.ts
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var HOME = homedir();
var CONFIG_FILE = join(HOME, ".config", "opencode", "opencode.json");
var AGENT_CFG = join(HOME, ".infinite-canvas", "canvas-agent.json");
var DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR || join(HOME, ".openchamber-infinite-canvas");
var LOG_DIR = join(DATA_DIR, "logs");
var AGENT_VERSION = "0.6.0";
var AGENT_REL = join("node_modules", "@basketikun", "canvas-agent", "dist", "index.js");
var BRIDGE_PORT = 17371;
var BRIDGE_DEFAULT_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
var CANVAS_SITE = process.env.CANVAS_SITE || "https://canvas.best/canvas";
var BACKUPS_KEPT = 10;
var agentCandidates = () => [
  process.env.CANVAS_AGENT_JS || "",
  join(HOME, ".infinite-canvas", "agent", AGENT_REL),
  join(DATA_DIR, "agent", AGENT_REL)
].filter((path) => Boolean(path));
var resolveAgentJs = () => {
  for (const candidate of agentCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};
var agentInstallHint = () => [
  `找不到 Canvas Agent（@basketikun/canvas-agent ${AGENT_VERSION}）。`,
  "安装命令：",
  `npm install --prefix "${join(HOME, ".infinite-canvas", "agent")}" @basketikun/canvas-agent@${AGENT_VERSION}`,
  "已经装在别处的话，把用户环境变量 CANVAS_AGENT_JS 指向 ...\\dist\\index.js 后重启 OpenChamber。"
].join("\n");
var mcpConfig = (agentJs) => ({
  type: "local",
  command: ["node", agentJs, "mcp"],
  enabled: true,
  timeout: 12e4
});
var mcpBlock = (agentJs) => {
  const lines = JSON.stringify(mcpConfig(agentJs), null, 2).split("\n");
  return `${lines.map((line, index) => index === 0 ? `    "infinite-canvas": ${line}` : `    ${line}`).join("\n")},`;
};
var BLOCK_ANY_RE = /"infinite-canvas"\s*:\s*\{[^{}]*?\}/;
var BLOCK_FIRST_RE = /[\r\n]*[ \t]*"infinite-canvas"\s*:\s*\{[^{}]*?\}\s*,/;
var BLOCK_LAST_RE = /,[\r\n]*[ \t]*"infinite-canvas"\s*:\s*\{[^{}]*?\}(?=[\r\n]*[ \t]*\})/;
var ENABLED_RE = /("infinite-canvas"\s*:\s*\{[^{}]*?"enabled"\s*:\s*)(true|false)/;
var MCP_ANCHOR_RE = /"mcp"\s*:\s*\{/;
var ServiceError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var send = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
};
var readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 64 * 1024) {
      reject(new ServiceError(413, "请求体过大"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var log = (line) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
    writeFileSync(join(LOG_DIR, "service.log"), `[${stamp}] ${line}
`, { encoding: "utf8", flag: "a" });
  } catch {
  }
};
var isListening = () => new Promise((resolve) => {
  const socket = connect({ port: BRIDGE_PORT, host: "127.0.0.1" });
  const done = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(700);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
});
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var readAgentConfig = () => {
  if (!existsSync(AGENT_CFG)) return null;
  try {
    const parsed = JSON.parse(readFileSync(AGENT_CFG, "utf8"));
    if (!parsed.token) return null;
    return { url: parsed.url || BRIDGE_DEFAULT_URL, token: parsed.token };
  } catch {
    return null;
  }
};
var health = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${BRIDGE_DEFAULT_URL}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return { ok: Boolean(body.ok), clients: Number(body.clients ?? 0), hasCanvas: Boolean(body.hasCanvas) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
var ensureBridge = async () => {
  if (await isListening()) return { started: false, detail: "桥接已在运行，复用现有实例" };
  const agentJs = resolveAgentJs();
  if (!agentJs) throw new ServiceError(500, agentInstallHint());
  const child = spawn(process.execPath, [agentJs], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  log(`启动桥接 pid=${child.pid ?? "?"} agent=${agentJs}`);
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    if (await isListening() && readAgentConfig()) return { started: true, detail: `桥接已启动（pid ${child.pid ?? "?"}）` };
  }
  throw new ServiceError(504, `桥接启动超时：127.0.0.1:${BRIDGE_PORT} 一直没就绪，稍后再点一次「开启」试试。`);
};
var stopBridge = async () => {
  if (!await isListening()) return { stopped: false, detail: "桥接本来就没在运行" };
  const script = [
    `$conn = Get-NetTCPConnection -LocalPort ${BRIDGE_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($conn) {",
    "  $procId = $conn.OwningProcess",
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    "  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue",
    "}"
  ].join("; ");
  await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], (error) => {
      if (error) reject(new ServiceError(500, `停止桥接失败：${error.message}`));
      else resolve();
    });
  });
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    if (!await isListening()) {
      log("桥接已停止");
      return { stopped: true, detail: "桥接进程树已停止" };
    }
  }
  throw new ServiceError(500, "桥接进程仍在监听 17371，可能被其它程序占用");
};
var readConfig = () => {
  if (!existsSync(CONFIG_FILE)) return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  return readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
};
var backupConfig = (text) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 15);
    copyFileSync(CONFIG_FILE, join(LOG_DIR, `opencode.backup.${stamp}.json`));
    const backups = readdirSync(LOG_DIR).filter((name) => name.startsWith("opencode.backup.")).map((name) => ({ name, mtime: statSync(join(LOG_DIR, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    for (const extra of backups.slice(BACKUPS_KEPT)) unlinkSync(join(LOG_DIR, extra.name));
  } catch {
    log("配置备份失败（继续写入）");
  }
  void text;
};
var writeConfig = (next) => {
  try {
    JSON.parse(next);
  } catch (error) {
    throw new ServiceError(500, `生成的 JSON 不合法，已放弃写入：${error.message}`);
  }
  mkdirSync(join(HOME, ".config", "opencode"), { recursive: true });
  writeFileSync(CONFIG_FILE, next, "utf8");
};
var mcpEnabled = () => BLOCK_ANY_RE.test(readConfig());
var setMcp = (on) => {
  const text = readConfig();
  const had = BLOCK_ANY_RE.test(text);
  if (on) {
    if (ENABLED_RE.test(text)) {
      const next3 = text.replace(ENABLED_RE, "$1true");
      if (next3 === text) return { changed: false, detail: "MCP 配置已在" };
      backupConfig(text);
      writeConfig(next3);
      return { changed: true, detail: "MCP 配置已写回 enabled=true" };
    }
    if (had) return { changed: false, detail: "MCP 配置已在" };
    const agentJs = resolveAgentJs();
    if (!agentJs) throw new ServiceError(500, agentInstallHint());
    backupConfig(text);
    const emptyMcp = /"mcp"\s*:\s*\{\s*\}/.test(text);
    if (!MCP_ANCHOR_RE.test(text) || emptyMcp) {
      const parsed = JSON.parse(text);
      const existing = parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp) ? parsed.mcp : {};
      parsed.mcp = { ...existing, "infinite-canvas": mcpConfig(agentJs) };
      writeConfig(`${JSON.stringify(parsed, null, 2)}
`);
      return { changed: true, detail: "MCP 配置块已写入（原文件没有 mcp 条目，已补上）" };
    }
    const next2 = text.replace(MCP_ANCHOR_RE, (anchor) => `${anchor}
${mcpBlock(agentJs)}`);
    writeConfig(next2);
    return { changed: true, detail: "MCP 配置块已写入" };
  }
  if (!had) return { changed: false, detail: "MCP 配置本来就没有" };
  backupConfig(text);
  const next = BLOCK_FIRST_RE.test(text) ? text.replace(BLOCK_FIRST_RE, "") : text.replace(BLOCK_LAST_RE, "");
  writeConfig(next);
  return { changed: true, detail: "MCP 配置块已移除" };
};
var snapshot = async () => {
  const listening = await isListening();
  const agent = readAgentConfig();
  const agentJs = resolveAgentJs();
  const healthInfo = listening ? await health() : null;
  return {
    bridge: {
      listening,
      clients: healthInfo?.clients ?? 0,
      hasCanvas: Boolean(healthInfo?.hasCanvas),
      url: agent?.url ?? BRIDGE_DEFAULT_URL
    },
    mcp: { enabled: mcpEnabled(), path: CONFIG_FILE },
    agent: { installed: Boolean(agentJs), path: agentJs, hasToken: Boolean(agent?.token) }
  };
};
var canvasLink = () => {
  const agent = readAgentConfig();
  if (!agent) return "";
  return `${CANVAS_SITE}?mode=recent#agentUrl=${agent.url}&agentToken=${agent.token}`;
};
var waitForCanvas = async () => {
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const info = await health();
    if (info?.hasCanvas) return true;
  }
  return false;
};
var turnOn = async () => {
  const steps = [];
  try {
    const bridge = await ensureBridge();
    steps.push({ name: "桥接服务", ok: true, detail: bridge.detail });
  } catch (error) {
    steps.push({ name: "桥接服务", ok: false, detail: error.message });
    log(`开启失败：${error.message}`);
    return { ok: false, steps, status: await snapshot(), openUrl: "" };
  }
  try {
    const mcp = setMcp(true);
    steps.push({ name: "MCP 配置", ok: true, detail: mcp.detail });
    log(`开启：${mcp.detail}`);
  } catch (error) {
    steps.push({ name: "MCP 配置", ok: false, detail: error.message });
    return { ok: false, steps, status: await snapshot(), openUrl: "" };
  }
  const link = canvasLink();
  steps.push({ name: "画布网页", ok: Boolean(link), detail: link ? "正在打开（mode=recent）" : "缺少 token，先重启一次桥接" });
  return { ok: true, steps, status: await snapshot(), openUrl: link };
};
var turnOff = async () => {
  const steps = [];
  let ok = true;
  try {
    const mcp = setMcp(false);
    steps.push({ name: "MCP 配置", ok: true, detail: mcp.detail });
    log(`关闭：${mcp.detail}`);
  } catch (error) {
    ok = false;
    steps.push({ name: "MCP 配置", ok: false, detail: error.message });
  }
  try {
    const bridge = await stopBridge();
    steps.push({ name: "桥接进程树", ok: true, detail: bridge.detail });
  } catch (error) {
    ok = false;
    steps.push({ name: "桥接进程树", ok: false, detail: error.message });
  }
  steps.push({ name: "浏览器", ok: true, detail: "按约定不动，那一页会显示未连接" });
  return { ok, steps, status: await snapshot(), openUrl: "" };
};
var server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      send(res, 200, await snapshot());
      return;
    }
    if (req.method === "POST" && url.pathname === "/on") {
      await readBody(req);
      send(res, 200, await turnOn());
      return;
    }
    if (req.method === "POST" && url.pathname === "/off") {
      await readBody(req);
      send(res, 200, await turnOff());
      return;
    }
    if (req.method === "POST" && url.pathname === "/open") {
      await readBody(req);
      const bridge = await ensureBridge();
      const link = canvasLink();
      send(res, 200, { ok: Boolean(link), steps: [{ name: "桥接服务", ok: true, detail: bridge.detail }], status: await snapshot(), openUrl: link });
      return;
    }
    if (req.method === "POST" && url.pathname === "/probe") {
      await readBody(req);
      send(res, 200, { canvasReady: await waitForCanvas(), status: await snapshot() });
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const failure = error instanceof ServiceError ? error : new ServiceError(500, error instanceof Error ? error.message : String(error));
    send(res, failure.status, { error: failure.message });
  }
});
if (!PORT || !TOKEN) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required.");
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
  console.log(`无限画布开关 service listening on 127.0.0.1:${PORT}`);
});
