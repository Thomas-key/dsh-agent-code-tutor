/**
 * Editor API 桥客户端 —— 一行一个 JSON 的 TCP(协议见 ../../agent_code_tutor/API.md)。
 *
 * 这里**不 import 任何 DSH 包**:纯 Node,可以在插件里当普通模块用,
 * 也可以自己写个脚本单独验。
 *
 * 约定:
 * - 每条请求带自增 `id` 和**会话 `token`**;响应原样带回,迟到的响应丢弃。
 * - 断线后下一次请求自动重连 —— code-server 重启一次,DSH 这边不用重启。
 * - 没有 `id` 的消息是推送:交给 onEvent 注册的处理函数,不进请求表。
 */

import net from 'node:net';

export const DEFAULT_PORT = 41890;

/** 桥上的失败:连接不上、操作报错、超时。message 直接给模型看。 */
export class BridgeError extends Error {
  constructor(message, code = 'EDITOR_BRIDGE') {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function abortError() {
  const error = new Error('编辑器操作被取消');
  error.name = 'AbortError';
  return error;
}

export class Bridge {
  constructor({ host = '127.0.0.1', port = DEFAULT_PORT, token = '' } = {}) {
    this.host = host;
    this.port = port;
    /** 会话身份:每个请求都要带,和工作区设置 tutorApi.conversationToken 一致。 */
    this.token = token;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    /** id -> { finish(msg), fail(error) },两者都幂等。 */
    this.pending = new Map();
    this.connecting = null;
    /** 关过就不许再连 —— 否则"关闭"和"正在连接"会比赛,赢了那边就漏一个 socket。 */
    this.closed = false;
  }

  get connected() {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * 发一条请求。
   * @param {string} op - scene/read/insert/wait/...
   * @param {object} params - 其余协议字段。
   * @param {{signal?: AbortSignal, timeoutMs?: number, token?: string}} options
   *   `token` 覆盖这条请求的工作区身份 —— 一个插件可能同时绑着多个编辑器。
   *   `timeoutMs <= 0` 表示**不设超时**:等着,一直等到编辑器回话。
   *   交棒类的调用就该这样 —— 用户在读代码,DSH 这边等回复不烧 token。
   * @returns {Promise<any>} 完整的响应信封(含 result,可能含 scene / events)。
   */
  async request(op, params = {}, { signal, timeoutMs = 30000, token } = {}) {
    if (this.closed) throw new BridgeError('连接已关闭', 'EDITOR_CLOSED');
    if (signal?.aborted) throw abortError();
    const unlimited = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
    await this.#connect(unlimited ? 5000 : Math.min(timeoutMs, 5000));
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new BridgeError('编辑器连接不可用');

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timer = null;
      let done = false;

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (msg) => {
        if (done) return;
        done = true;
        cleanup();
        // 成功时交出整条信封:除了 result,还可能带 scene / events
        if (msg && msg.ok) resolve(msg);
        else reject(new BridgeError(String(msg?.error?.message ?? '编辑器的返回里没有 ok'), 'EDITOR_OP_FAILED'));
      };
      const fail = (error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(abortError());

      if (!unlimited) {
        timer = setTimeout(() => {
          fail(new BridgeError(`${op} 超过 ${Math.round(timeoutMs / 1000)}s 没有返回`, 'EDITOR_TIMEOUT'));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { finish, fail });

      try {
        // token 跟着每个请求走 —— 忘了它会被服务端直接拒掉。
        // 传了 token 就用调用方的(按会话挑工作区),否则用插件默认的。
        const effectiveToken = token ?? this.token;
        socket.write(JSON.stringify({ id, token: effectiveToken, op, ...params }) + '\n');
      } catch (error) {
        fail(new BridgeError(`写不进编辑器连接:${error.message}`));
      }
    });
  }

  /**
   * 收"推送":扩展发来的、没有 id 的消息(人从状态栏问了 agent 一句)。
   * @param {(event: object) => void} handler
   */
  onEvent(handler) {
    this.eventHandler = typeof handler === 'function' ? handler : null;
  }

  /** 主动连上(不等有工具调用)。唤醒要靠这条常连接。 */
  async ensureConnected(timeoutMs = 5000) {
    await this.#connect(timeoutMs);
  }

  /** 发一条不需要回复的消息。 */
  notify(message) {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(JSON.stringify(message) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** 关掉连接(插件卸载时用)。 */
  close() {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.buffer = '';
    if (socket) socket.destroy();
    this.#failAll(new BridgeError('编辑器连接已关闭', 'EDITOR_CLOSED'));
  }

  #connect(timeoutMs) {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeError(`连不上编辑器 ${this.host}:${this.port}(扩展没在听)`, 'EDITOR_OFFLINE'));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      const onError = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(this.#connectionError(error));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);

        // 自环守卫:扩展宿主重启的瞬间,内核可能把连接合成 127.0.0.1:P → 127.0.0.1:P,
        // 看起来连上了,其实请求会被自己收回来 —— 然后一直等一个不会来的响应。
        if (socket.localPort === socket.remotePort) {
          socket.destroy();
          reject(new BridgeError(`端口 ${this.port} 上有自环 socket(连到了自己)`, 'EDITOR_OFFLINE'));
          return;
        }

        if (this.closed) {
          // close() 抢在前面了:别把这个 socket 挂上去,否则永远没人关
          socket.destroy();
          reject(new BridgeError('连接已关闭', 'EDITOR_CLOSED'));
          return;
        }
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('error', () => this.#drop(socket));
        socket.on('close', () => this.#drop(socket));
        resolve();
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  #connectionError(error) {
    if (error?.code === 'ECONNREFUSED') {
      return new BridgeError(
        `连不上编辑器 ${this.host}:${this.port} —— 在 code-server 里 Reload Window,确认 Editor API 扩展已激活;` +
          `端口对不上就改设置 tutorApi.port(扩展)和 port(这个插件),两边要一致`,
        'EDITOR_OFFLINE',
      );
    }
    return new BridgeError(`连不上编辑器:${error?.message ?? error}`, 'EDITOR_OFFLINE');
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // 没有 id 的是推送(反方向):交给注册的处理函数,不走请求表。
      if (message.event !== undefined && message.id === undefined) {
        try {
          this.eventHandler?.(message);
        } catch {}
        continue;
      }
      const entry = this.pending.get(message.id);
      // 迟到的响应(取消后的 wait、超时后的请求)直接丢掉。
      if (!entry) continue;
      this.pending.delete(message.id);
      entry.finish(message);
    }
  }

  #drop(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = '';
    this.#failAll(new BridgeError('编辑器连接断了(code-server 窗口关掉或重载了)', 'EDITOR_CLOSED'));
  }

  #failAll(error) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.fail(error);
  }
}
