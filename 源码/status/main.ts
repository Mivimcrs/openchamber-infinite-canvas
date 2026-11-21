/**
 * 无限画布开关卡片（contributes.statusSection）。
 *
 * 卡片只负责画和发指令：真正的进程与配置操作全部在 service 里。
 * 所有状态都从 service 现场读（端口、/health、opencode.json），不在前端缓存，
 * 所以用脚本改过配置后，这里也会显示同一份真相。
 */
import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

type Status = {
  bridge: { listening: boolean; clients: number; hasCanvas: boolean; url: string };
  mcp: { enabled: boolean; path: string };
  agent: { installed: boolean; hasToken: boolean };
};

type Step = { name: string; ok: boolean; detail: string };
type ActionResult = { ok: boolean; steps: Step[]; status: Status; openUrl: string };
type ProbeResult = { canvasReady: boolean; status: Status };

const host = connectHost();
const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('#root 缺失');

const POLL_MS = 5000;

let status: Status | null = null;
let busy = false;
let note = '';
let noteTone: 'ok' | 'err' | '' = '';
let timer: ReturnType<typeof setTimeout> | null = null;

const describe = (error: unknown): string => {
  if (error instanceof HostRequestError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/** 面板 → service。service 未启动时宿主要求先由面板发起，错误会被翻译成人话。 */
const call = async <T>(path: string, method: 'GET' | 'POST' = 'GET', body = '{}'): Promise<T> => {
  const result = await host.serviceRequest({ method, path, body: method === 'POST' ? body : undefined });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    parsed = null;
  }
  if (result.status < 200 || result.status >= 300) {
    const message = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
      ? String((parsed as { error: string }).error)
      : `服务返回 HTTP ${result.status}`;
    throw new Error(message);
  }
  return parsed as T;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (key: string, value: string, tone: 'ok' | 'warn' | 'err' | 'muted' | '' = '') => {
  const wrap = el('div', 'row');
  wrap.append(el('span', 'k', key));
  const v = el('span', 'v', value);
  if (tone) v.dataset.tone = tone;
  wrap.append(v);
  return wrap;
};

const summarize = (result: ActionResult): string => {
  const bad = result.steps.find((step) => !step.ok);
  if (bad) return `${bad.name}：${bad.detail}`;
  return result.steps.map((step) => step.detail).join('；');
};

const render = (): void => {
  const state = status;
  const rows = el('div', 'rows');

  const head = el('div', 'head');
  const dot = el('span', 'dot');
  const title = el('span', 'title', '无限画布');
  head.append(dot, title, el('span', 'spacer'), el('span', 'tag', state?.bridge.hasCanvas ? `画布连接 ${state.bridge.clients}` : ''));

  if (!state) {
    dot.dataset.state = 'off';
    rows.append(row('状态', '正在读取…', 'muted'));
  } else {
    const on = state.mcp.enabled;
    dot.dataset.state = on ? (state.bridge.listening ? 'on' : 'half') : 'off';

    rows.append(state.bridge.listening
      ? row('桥接', `运行中 · ${state.bridge.url.replace(/^https?:\/\//, '')}`, 'ok')
      : row('桥接', '未运行', 'muted'));

    rows.append(state.bridge.hasCanvas
      ? row('画布', '已连接', 'ok')
      : row('画布', state.bridge.listening ? '等待网页连接' : '—', state.bridge.listening ? 'warn' : 'muted'));

    rows.append(state.mcp.enabled
      ? row('MCP', '配置已写入（几秒内工具可用）', 'ok')
      : row('MCP', '未写入', 'muted'));
  }

  const actions = el('div', 'actions');
  const toggle = el('button', 'primary', busy ? '处理中…' : status?.mcp.enabled ? '关闭（含桥接）' : '开启（起桥 + 开画布）');
  toggle.dataset.mode = status?.mcp.enabled ? 'on' : 'off';
  toggle.disabled = busy || !status;
  toggle.addEventListener('click', () => { void toggleFlow(); });

  const open = el('button', 'ghost', '打开画布');
  open.disabled = busy;
  open.addEventListener('click', () => { void openFlow(); });
  actions.append(toggle, open);

  const noteNode = el('div', 'note', note);
  if (noteTone) noteNode.dataset.tone = noteTone;

  root.replaceChildren(head, rows, actions, noteNode);
};

const refresh = async (): Promise<void> => {
  try {
    status = await call<Status>('/status');
    if (!busy && !note) note = status.mcp.enabled ? '' : '';
  } catch (error) {
    note = describe(error);
    noteTone = 'err';
  }
  render();
};

const toggleFlow = async (): Promise<void> => {
  if (!status) return;
  busy = true;
  note = '';
  noteTone = '';
  render();
  try {
    const turningOff = status.mcp.enabled;
    const result = await call<ActionResult>(turningOff ? '/off' : '/on', 'POST', '{}');
    status = result.status;
    noteTone = result.ok ? 'ok' : 'err';
    note = summarize(result);

    if (!turningOff && result.openUrl) {
      try {
        await host.openUrl(result.openUrl);
      } catch {
        note = `配置已写入，但没能自动打开网页：${result.openUrl}`;
        noteTone = 'err';
        busy = false;
        render();
        return;
      }
      note = '画布页已打开，等它连上…';
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const probe = await call<ProbeResult>('/probe', 'POST', '{}');
      status = probe.status;
      note = probe.canvasReady ? '画布已连接，可以直接操作了' : '页面还在加载，连上后状态会自己变';
      noteTone = probe.canvasReady ? 'ok' : '';
    }
  } catch (error) {
    note = describe(error);
    noteTone = 'err';
    void host.toast({ kind: 'error', message: note }).catch(() => undefined);
  } finally {
    busy = false;
    render();
  }
};

const openFlow = async (): Promise<void> => {
  busy = true;
  note = '';
  noteTone = '';
  render();
  try {
    const result = await call<ActionResult>('/open', 'POST', '{}');
    status = result.status;
    if (!result.openUrl) throw new Error('缺少 token：先点一次「开启」，或重启桥接');
    await host.openUrl(result.openUrl);
    note = '已打开画布页，等它连上…';
    noteTone = '';
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const probe = await call<ProbeResult>('/probe', 'POST', '{}');
    status = probe.status;
    note = probe.canvasReady ? '画布已连接' : '页面还在加载，连上后状态会自己变';
    noteTone = probe.canvasReady ? 'ok' : '';
  } catch (error) {
    note = describe(error);
    noteTone = 'err';
  } finally {
    busy = false;
    render();
  }
};

const poll = (): void => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!busy) await refresh();
    poll();
  }, POLL_MS);
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // 同一份页面既做状态卡片（surface=status）又做侧边栏面板（surface=panel）。
  document.body.dataset.surface = ctx.surface;
  render();
  void refresh();
  poll();
});
