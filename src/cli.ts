#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "./db";
import { FlashService } from "./service";
import { createApp } from "./server";
import { toCsv } from "./importexport";
import { ValidationError } from "./common";

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; args: Args; positionals: string[] } {
  const args: Args = {};
  const positionals: string[] = [];
  for (const tok of argv) {
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) args[tok.slice(2, eq)] = tok.slice(eq + 1);
      else args[tok.slice(2)] = true;
    } else positionals.push(tok);
  }
  return { cmd: positionals[0] ?? "", args, positionals: positionals.slice(1) };

}

function dataDir(): string {
  return resolve(process.env.FLASH_DATA_DIR ?? join(process.cwd(), "data"));
}

function openStore(): Store {
  mkdirSync(dataDir(), { recursive: true });
  return new Store(join(dataDir(), "flash.sqlite"));
}

function output(data: unknown, args: Args, csvFlatten?: (d: unknown) => Array<Array<string | number | null>>): void {
  if (args.format === "csv" && csvFlatten) {
    process.stdout.write(toCsv(csvFlatten(data)) + "\n");
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
  if (typeof args.out === "string") {
    const text =
      args.format === "csv" && csvFlatten
        ? toCsv(csvFlatten(data))
        : JSON.stringify(data, null, 2);
    writeFileSync(args.out, text, "utf8");
  }
}

function readInput(args: Args): { format: "json" | "csv"; text: string } {
  const format = (args.format === "csv" ? "csv" : "json") as "json" | "csv";
  if (typeof args.file === "string") {
    return { format: args.format === "csv" ? "csv" : (args.file.endsWith(".csv") ? "csv" : "json"), text: readFileSync(args.file, "utf8") };
  }
  throw new ValidationError("需要 --file=<路径>");
}

function flashRows(d: unknown): Array<Array<string | number | null>> {
  const r = d as { result: { components: Array<Record<string, number | string | null>> } };
  const comps = r.result.components;
  const header = Object.keys(comps[0] ?? {});
  return [header, ...comps.map((c) => header.map((h) => c[h] ?? null))];
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const store = openStore();
  const service = new FlashService(store);
  try {
    switch (cmd) {
      case "serve": {
        const port = Number(args.port ?? process.env.PORT ?? 3000);
        const app = createApp(store);
        app.listen(port, () => {
          console.log(`闪蒸服务已启动: http://localhost:${port}  数据目录: ${dataDir()}`);
        });
        return;
      }
      case "import-props": {
        const inp = readInput(args);
        const out = service.importProperties(String(args.label ?? "default"), inp);
        output(out, args);
        return;
      }
      case "import-feed": {
        const inp = readInput(args);
        const out = service.importFeed({
          label: String(args.label ?? "feed"),
          propertyVersion: String(args.props ?? "default"),
          format: inp.format,
          text: inp.text,
          normalize: args.normalize === true || args.normalize === "true",
        });
        output(out, args);
        return;
      }
      case "flash": {
        const body = {
          propertyVersion: String(args.props ?? "default"),
          feedVersion: String(args.feed ?? "feed"),
          temperatureC: Number(args.t),
          pressureKpa: Number(args.p),
          normalize: args.normalize === true || args.normalize === "true",
          directK: args.k ? JSON.parse(String(args.k)) : undefined,
        };
        const out = service.runFlash(body);
        output(out, args, flashRows);
        return;
      }
      case "bubble-dew": {
        const out = service.runBubbleDew({
          propertyVersion: String(args.props ?? "default"),
          feedVersion: String(args.feed ?? "feed"),
          temperatureC: Number(args.t),
        });
        output(out, args);
        return;
      }
      case "scan": {
        const out = service.runScan({
          propertyVersion: String(args.props ?? "default"),
          feedVersion: String(args.feed ?? "feed"),
          temperatureC: Number(args.t),
          pressuresKpa: String(args.pressures ?? "")
            .split(",")
            .filter(Boolean)
            .map(Number),
        });
        output(out, args);
        return;
      }
      case "run": {
        const run = store.getRun(Number(args.id));
        if (!run) throw new ValidationError(`运行 ${args.id} 不存在`);
        output(run, args);
        return;
      }
      case "runs": {
        output({ runs: store.listRuns(100) }, args);
        return;
      }
      case "compare": {
        output(service.compareRuns(Number(args.a), Number(args.b)), args);
        return;
      }
      case "demo": {
        const { runDemo } = await import("./demo");
        runDemo(store, service);
        return;
      }
      default:
        console.log(`用法: flash <serve|import-props|import-feed|flash|bubble-dew|scan|run|runs|compare|demo> [选项]
  serve --port=3000
  import-props --label=v1 --file=props.json [--format=json|csv]
  import-feed  --label=f1 --props=v1 --file=feed.json [--normalize]
  flash --props=v1 --feed=f1 --t=25 --p=50 [--k='{"benzene":2.1}'] [--format=json|csv] [--out=文件]
  bubble-dew --props=v1 --feed=f1 --t=25
  scan --props=v1 --feed=f1 --t=25 --pressures=10,30,50,80
  run --id=1   runs   compare --a=1 --b=2
  demo
环境变量: PORT, FLASH_DATA_DIR`);
    }
  } finally {
    // serve 保持连接；其余命令关闭
    if (cmd !== "serve") store.close();
  }
}

main().catch((err: unknown) => {
  console.error("错误:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
