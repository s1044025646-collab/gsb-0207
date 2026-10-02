#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../db.js';
import { FlashService, ServiceError } from '../service.js';
import { EquilibriumError } from '../equilibrium.js';

interface CliConfig {
  dataDir: string;
}

function readConfig(): CliConfig {
  return { dataDir: process.env.FLASH_DATA_DIR ? resolve(process.env.FLASH_DATA_DIR) : resolve('data') };
}

function makeService(): { service: FlashService; store: Store } {
  const cfg = readConfig();
  const store = new Store(resolve(cfg.dataDir, 'flash.sqlite'));
  return { service: new FlashService(store), store };
}

function fail(err: unknown): never {
  const msg = err instanceof ServiceError || err instanceof EquilibriumError
    ? `错误：${err.message}`
    : (err as Error).stack ?? String(err);
  console.error(msg);
  process.exit(1);
}

function print(obj: unknown, csv: string | null = null): void {
  if (csv !== null) {
    process.stdout.write(csv.endsWith('\n') ? csv : csv + '\n');
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      feed: { type: 'string' },
      version: { type: 'string' },
      t: { type: 'string' },
      p: { type: 'string' },
      k: { type: 'string' },
      normalize: { type: 'boolean', default: false },
      file: { type: 'string' },
      name: { type: 'string' },
      note: { type: 'string' },
      pressures: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string', default: 'json' },
      id: { type: 'string' },
      compare: { type: 'string' },
    },
  });

  const cmd = positionals[0] ?? 'help';
  const { service, store } = makeService();

  try {
    switch (cmd) {
      case 'import-props': {
        const r = service.importVersionFromCsv(values.file!, values.name!, values.note ?? null);
        print(r);
        break;
      }
      case 'import-feed': {
        const r = service.importFeedFromCsv(values.file!, values.name!);
        print(r);
        break;
      }
      case 'list-versions':
        print(store.listVersions());
        break;
      case 'list-feeds':
        print(store.listFeeds());
        break;
      case 'flash': {
        const result = service.flash(
          {
            feedName: values.feed!,
            versionName: values.version!,
            temperature: Number(values.t),
            pressure: values.p === undefined ? null : Number(values.p),
            userK: values.k ? JSON.parse(values.k) : null,
            normalize: values.normalize,
          },
          'kPa',
        );
        const csv = values.format === 'csv' ? service.flashToCsv(result) : null;
        if (values.out) writeFileSync(values.out, csv ?? JSON.stringify(result, null, 2));
        print(values.out ? { reportId: result.reportId, out: values.out } : result, csv);
        break;
      }
      case 'bubble':
      case 'dew': {
        const r = service.bubbleOrDew(cmd, values.feed!, values.version!, Number(values.t), values.normalize);
        print(r);
        break;
      }
      case 'scan': {
        const pressures = String(values.pressures!).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        const r = service.scan(values.feed!, values.version!, Number(values.t), pressures, values.normalize);
        const csv = values.format === 'csv' ? service.scanToCsv(r) : null;
        print(r, csv);
        break;
      }
      case 'compare': {
        const [feed2, version2] = String(values.compare!).split(':');
        const base = {
          feedName: values.feed!,
          versionName: values.version!,
          temperature: Number(values.t),
          pressure: Number(values.p),
          normalize: values.normalize,
        };
        const r = service.compare(base, { ...base, feedName: feed2, versionName: version2 || base.versionName });
        print(r);
        break;
      }
      case 'report': {
        const rep = store.getReport(Number(values.id));
        if (!rep) throw new ServiceError(`报告 ${values.id} 不存在`);
        print({ ...rep, request: JSON.parse(rep.requestJson), result: JSON.parse(rep.resultJson), algorithm: JSON.parse(rep.algorithmJson) });
        break;
      }
      case 'list-reports':
        print(store.listReports());
        break;
      default:
        process.stdout.write(
          [
            '理想混合物闪蒸 CLI',
            '命令：',
            '  import-props --file props.csv --name V1 [--note ...]',
            '  import-feed  --file feed.csv --name F1',
            '  list-versions | list-feeds | list-reports',
            '  flash --feed F1 --version V1 --t 60 --p 101.325 [--k \'{"A":2.1}\'] [--normalize] [--format csv]',
            '  bubble --feed F1 --version V1 --t 60 [--normalize]',
            '  dew    --feed F1 --version V1 --t 60 [--normalize]',
            '  scan   --feed F1 --version V1 --t 60 --pressures 10,50,101.325,200 [--format csv]',
            '  compare --feed F1 --version V1 --t 60 --p 101.325 --compare F2:V2',
            '  report --id 1',
            '环境变量：FLASH_DATA_DIR（默认 ./data）',
          ].join('\n') + '\n',
        );
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

main().catch(fail);
