// WebSocket server: ws://127.0.0.1:<port> (or a LAN/Tailscale address in remote mode). Clients
// send `hello` and get a `snapshot`, then every upsert. Multiple clients (the mod + CLI tools) are
// supported. Any browser origin (also `null`) and non-local Host headers are rejected, so a web
// page cannot drive your agents; remote clients additionally need the shared token. The same HTTP
// server also exposes POST /agentcraft/tool, the coordination endpoint the hermes backend's
// characters call (their "MCP tools": send_message, update_task, ask_user, ...).
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isLoopbackHost } from './config.js';
import type { Logger } from './context.js';
import type { Foreman } from './foreman.js';
import { parseClientMessage, PROTOCOL_VERSION, ServerMessage, type Outbound } from './protocol.js';

export interface ServerOptions {
  host: string;
  port: number;
  allowBrowserOrigins?: boolean;
  /** shared secret required from non-loopback clients (remote mode) */
  token?: string;
  /** validate every outbound message against the schema (tests/dev) */
  validateOutbound?: boolean;
  log: Logger;
}

/** Host header values a local client sends (DNS rebinding sends the attacker's host name). */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Why a WebSocket upgrade is refused, or undefined to accept. The mod (Java HttpClient) and our
 * CLI tools send no Origin header; every browser does, and a sandboxed iframe, a data: URL or a
 * file:// page sends the literal `null`, so any Origin at all - `null` included - is a web page.
 * The Host must be a loopback name - or, in remote mode (the Foreman bound to a LAN/Tailscale
 * address), exactly the address it was bound to, and the client must carry the shared token -
 * so a DNS-rebinding page still cannot reach us under its own name.
 */
export function refuseReason(req: IncomingMessage, allowBrowserOrigins = false, remote: { host: string; token?: string } | undefined = undefined): string | undefined {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowBrowserOrigins) return `browser origin ${origin || '(empty)'}`;
  const host = req.headers.host ?? '';
  if (!allowBrowserOrigins && !LOOPBACK_HOST.test(host)) {
    if (!remote) return `non-loopback Host header ${host || '(none)'}`;
    // remote mode: the Host must name the address we actually bound to
    const bound = new RegExp(`^${remote.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+$`, 'i');
    if (!bound.test(host)) return `non-local Host header ${host || '(none)'} (bound to ${remote.host})`;
    if (!remote.token) return 'remote mode requires a token';
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-agentcraft-token'] as string | undefined) ?? '';
    if (presented !== remote.token) return 'bad or missing token';
  }
  return undefined;
}

interface Client {
  ws: WebSocket;
  id: number;
  hello: boolean;
  name: string;
  alive: boolean;
}

/** Handles POST /agentcraft/tool (the hermes characters' coordination tools). */
export type ToolHandler = (req: { agentId: string; tool: string; args: Record<string, unknown> }) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }>;

export class ForemanServer {
  private wss: WebSocketServer | undefined;
  private http: http.Server | undefined;
  private clients = new Set<Client>();
  private unsub: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;
  port = 0;
  /** set by start(): true when bound to a non-loopback address (remote game client) */
  remote = false;
  /** injected by main: handles POST /agentcraft/tool for the hermes backend */
  toolHandler: ToolHandler | undefined;

  constructor(
    private foreman: Foreman,
    private opts: ServerOptions,
  ) {}

  get clientCount(): number {
    return [...this.clients].filter((c) => c.hello).length;
  }

  start(): Promise<number> {
    const remote = !isLoopbackHost(this.opts.host);
    this.remote = remote;
    const remoteGuard = remote ? { host: this.opts.host, token: this.opts.token } : undefined;
    return new Promise((resolve, reject) => {
      // one HTTP server for both the WebSocket upgrade and POST /agentcraft/tool
      const httpServer = http.createServer((req, res) => void this.onHttpRequest(req, res).catch((e) => this.opts.log.error(`http: ${(e as Error).stack ?? e}`)));
      const wss = new WebSocketServer({
        server: httpServer,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
          const why = refuseReason(info.req, !!this.opts.allowBrowserOrigins, remoteGuard);
          if (!why) return true;
          this.opts.log.warn(`rejected WebSocket: ${why}`);
          return false;
        },
      });
      this.wss = wss;
      this.http = httpServer;
      wss.once('error', (e) => reject(e));
      httpServer.once('error', (e: NodeJS.ErrnoException) => reject(e));
      httpServer.listen(this.opts.port, this.opts.host, () => {
        const addr = httpServer.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        wss.on('error', (e) => this.opts.log.error(`ws server: ${e.message}`));
        resolve(this.port);
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.unsub = this.foreman.subscribe((m) => this.broadcast(m));
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 15_000);
      this.heartbeat.unref?.();
    });
  }

  /** POST /agentcraft/tool: the hermes characters' coordination tools (send_message, ask_user, ...). */
  private async onHttpRequest(req: IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/agentcraft/tool') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const why = refuseReason(req, !!this.opts.allowBrowserOrigins, this.remote ? { host: this.opts.host, token: this.opts.token } : undefined);
    if (why) {
      this.opts.log.warn(`rejected /agentcraft/tool: ${why}`);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: why }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const body: string = await new Promise((resolveBody) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 512 * 1024) {
          req.destroy();
          resolveBody('');
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolveBody(''));
    });
    if (!body) {
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'empty or oversized body' }));
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }
    const b = parsed as { agent?: unknown; tool?: unknown; args?: unknown };
    const agentId = typeof b.agent === 'string' ? b.agent.trim() : '';
    const tool = typeof b.tool === 'string' ? b.tool.trim() : '';
    const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? (b.args as Record<string, unknown>) : {};
    if (!agentId || !tool) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'need "agent" and "tool"' }));
      return;
    }
    if (!this.toolHandler) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no backend handles /agentcraft/tool (start with --backend hermes)' }));
      return;
    }
    const out = await this.toolHandler({ agentId, tool, args });
    res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error }));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = { ws, id: this.nextId++, hello: false, name: `client${this.nextId - 1}`, alive: true };
    this.clients.add(client);
    this.opts.log.info(`client #${client.id} connected from ${req.socket.remoteAddress ?? '?'}`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) {
        this.send(client, { type: 'error', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        let re: string | undefined;
        try {
          const raw = JSON.parse(data.toString()) as { id?: unknown };
          if (typeof raw.id === 'string') re = raw.id;
        } catch {
          /* ignore */
        }
        this.send(client, { type: 'error', message: `bad message: ${parsed.error}`, ...(re ? { re } : {}) });
        if (re) this.send(client, { type: 'ack', re, ok: false, error: parsed.error });
        return;
      }
      const msg = parsed.msg;
      if (msg.type === 'hello') {
        client.hello = true;
        client.name = `${msg.client ?? 'client'}#${client.id} (${msg.modVersion})`;
        this.opts.log.info(`hello from ${client.name}`);
      } else if (!client.hello) {
        // be lenient: treat the first intent as an implicit hello so tools can fire-and-forget
        client.hello = true;
      }
      void this.foreman.handle(msg, (out) => this.send(client, out));
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.opts.log.info(`client #${client.id} disconnected`);
    });
    ws.on('error', (e) => this.opts.log.warn(`client #${client.id}: ${e.message}`));
  }

  private serialize(m: Outbound): string | undefined {
    const full = { v: PROTOCOL_VERSION, ...m };
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`outbound ${m.type} violates protocol: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        throw new Error(`outbound ${m.type} violates protocol`);
      }
    }
    return JSON.stringify(full);
  }

  private send(c: Client, m: Outbound): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const s = this.serialize(m);
    if (s) c.ws.send(s);
  }

  broadcast(m: Outbound): void {
    let s: string | undefined;
    for (const c of this.clients) {
      if (!c.hello || c.ws.readyState !== c.ws.OPEN) continue;
      s ??= this.serialize(m);
      if (s) c.ws.send(s);
    }
  }

  async stop(): Promise<void> {
    this.unsub?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      try {
        c.ws.close(1001, 'foreman shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      setTimeout(() => {
        for (const c of this.clients) c.ws.terminate();
        resolve();
      }, 1000).unref?.();
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.closeAllConnections?.();
      this.http.close(() => resolve());
      setTimeout(resolve, 1000).unref?.();
    });
  }
}
