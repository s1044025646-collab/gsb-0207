import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Store } from './db.js';
import { FlashService, ServiceError } from './service.js';
import { EquilibriumError } from './equilibrium.js';
import { FlashRequest } from './types.js';
import { DEFAULT_PRESSURE_UNIT } from './constants.js';

const PORT = Number(process.env.PORT ?? process.env.FLASH_PORT ?? 3000);
const DATA_DIR = process.env.FLASH_DATA_DIR ? resolve(process.env.FLASH_DATA_DIR) : resolve('data');

const store = new Store(resolve(DATA_DIR, 'flash.sqlite'));
const service = new FlashService(store);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, dataDir: DATA_DIR });
    }
    if (req.method === 'GET' && path === '/versions') {
      return send(res, 200, store.listVersions());
    }
    if (req.method === 'GET' && path === '/feeds') {
      return send(res, 200, store.listFeeds());
    }
    if (req.method === 'GET' && path === '/reports') {
      return send(res, 200, store.listReports());
    }
    if (req.method === 'GET' && path.startsWith('/reports/')) {
      const id = Number(path.split('/').pop());
      const rep = store.getReport(id);
      if (!rep) return send(res, 404, { error: `报告 ${id} 不存在` });
      return send(res, 200, {
        ...rep,
        request: JSON.parse(rep.requestJson),
        result: JSON.parse(rep.resultJson),
        algorithm: JSON.parse(rep.algorithmJson),
      });
    }

    if (req.method === 'POST' && path === '/import/properties') {
      const body = await readJson(req);
      const r = service.importVersion(body.rows ?? [], body.name, body.note ?? null);
      return send(res, 201, r);
    }
    if (req.method === 'POST' && path === '/import/feed') {
      const body = await readJson(req);
      const r = service.importFeed(body.rows ?? [], body.name);
      return send(res, 201, r);
    }
    if (req.method === 'POST' && path === '/flash') {
      const body = (await readJson(req)) as FlashRequest;
      return send(res, 200, service.flash(body, DEFAULT_PRESSURE_UNIT));
    }
    if (req.method === 'POST' && (path === '/bubble' || path === '/dew')) {
      const body = await readJson(req);
      return send(res, 200, service.bubbleOrDew(path.slice(1) as 'bubble' | 'dew', body.feedName, body.versionName, Number(body.temperature), body.normalize === true));
    }
    if (req.method === 'POST' && path === '/scan') {
      const body = await readJson(req);
      return send(res, 200, service.scan(body.feedName, body.versionName, Number(body.temperature), body.pressures.map(Number), body.normalize === true));
    }
    if (req.method === 'POST' && path === '/compare') {
      const body = await readJson(req);
      return send(res, 200, service.compare(body.base, body.other));
    }
    return send(res, 404, { error: `未找到路由 ${req.method} ${path}` });
  } catch (e) {
    const status = e instanceof ServiceError || e instanceof EquilibriumError || e instanceof SyntaxError ? 400 : 500;
    return send(res, status, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`理想闪蒸服务已启动: http://localhost:${PORT}  数据目录: ${DATA_DIR}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
