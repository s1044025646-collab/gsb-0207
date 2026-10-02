import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { FlashService } from "./service";
import { Store } from "./db";
import { ValidationError } from "./common";
import { toCsv } from "./importexport";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function createApp(store: Store): ReturnType<typeof createServer> {
  const service = new FlashService(store);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/versions") {
        return send(res, 200, {
          propertyVersions: store.listPropertyVersions(),
          feedVersions: store.listFeedVersions(),
        });
      }
      if (method === "GET" && path.startsWith("/runs/")) {
        const id = Number(path.split("/").pop());
        const run = store.getRun(id);
        if (!run) return send(res, 404, { error: "run not found" });
        const format = url.searchParams.get("format");
        if (format === "csv" && run.kind === "flash") {
          const r = run.report as {
            result: {
              components: Array<Record<string, number | string | null>>;
            };
          };
          const comps = r.result.components;
          const header = Object.keys(comps[0] ?? {});
          const csv = toCsv([
            header,
            ...comps.map((c) => header.map((h) => c[h] ?? null)),
          ]);
          res.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="run-${id}.csv"`,
          });
          return res.end(csv);
        }
        return send(res, 200, run);
      }
      if (method === "GET" && path === "/runs") {
        return send(res, 200, { runs: store.listRuns(100) });
      }

      if (method !== "POST") return send(res, 405, { error: "method not allowed" });
      const raw = await readBody(req);
      let body: unknown = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "请求体不是合法 JSON" });
        }
      }

      if (path === "/properties/import") {
        const b = body as {
          label: string;
          format?: "json" | "csv";
          text?: string;
          components?: unknown;
        };
        const text =
          b.format === "csv"
            ? (b.text ?? "")
            : JSON.stringify({ components: b.components ?? JSON.parse(b.text ?? "{}").components });
        const out = service.importProperties(b.label, {
          format: b.format === "csv" ? "csv" : "json",
          text,
        });
        return send(res, 200, out);
      }
      if (path === "/feeds/import") {
        const b = body as {
          label: string;
          propertyVersion: string;
          format?: "json" | "csv";
          text?: string;
          entries?: unknown;
          normalize?: boolean;
        };
        const text =
          b.format === "csv"
            ? (b.text ?? "")
            : JSON.stringify({ entries: b.entries ?? JSON.parse(b.text ?? "{}").entries });
        const out = service.importFeed({
          label: b.label,
          propertyVersion: b.propertyVersion,
          format: b.format === "csv" ? "csv" : "json",
          text,
          normalize: b.normalize,
        });
        return send(res, 200, out);
      }
      if (path === "/flash") {
        return send(res, 200, service.runFlash(body as never));
      }
      if (path === "/bubble-dew") {
        return send(res, 200, service.runBubbleDew(body as never));
      }
      if (path === "/scan") {
        return send(res, 200, service.runScan(body as never));
      }
      if (path === "/compare") {
        const b = body as { runIdA: number; runIdB: number };
        return send(res, 200, service.compareRuns(b.runIdA, b.runIdB));
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof ValidationError ? 422 : 400;
      return send(res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
