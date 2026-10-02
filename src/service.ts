import { AlgoParams, DEFAULT_ALGO, FlashResult } from "./common";
import {
  PropertyImportRow,
  parseFeedCsv,
  parseFeedJson,
  parsePropertyCsv,
  parsePropertyJson,
} from "./importexport";
import { prepareFeed } from "./feed";
import { resolveK } from "./properties";
import { flash } from "./flash";
import { bubbleDewPressure, pressureScan } from "./bubble";
import { verifyBalance } from "./balance";
import { Store } from "./db";

export interface FlashRequestBody {
  propertyVersion: string;
  feedVersion: string;
  temperatureC: number;
  pressureKpa: number;
  normalize?: boolean;
  algo?: Partial<AlgoParams>;
  /** 可选：按组分 key 直接给定正的 K（优先于 Antoine） */
  directK?: Record<string, number>;
}

function mergeAlgo(partial?: Partial<AlgoParams>): AlgoParams {
  return { ...DEFAULT_ALGO, ...(partial ?? {}) };
}

export class FlashService {
  constructor(private store: Store) {}

  importProperties(label: string, source: { format: "json" | "csv"; text: string }): {
    versionId: number;
    count: number;
  } {
    const rows: PropertyImportRow[] =
      source.format === "csv"
        ? parsePropertyCsv(source.text)
        : parsePropertyJson(source.text);
    let versionId = this.store.getPropertyVersion(label);
    if (versionId === null) versionId = this.store.createPropertyVersion(label);
    for (const row of rows) {
      this.store.upsertComponent(
        versionId,
        row.key,
        row.name,
        row.cas ?? null,
        row.antoine ?? null,
      );
    }
    return { versionId, count: rows.length };
  }

  importFeed(args: {
    label: string;
    propertyVersion: string;
    format: "json" | "csv";
    text: string;
    normalize?: boolean;
    algo?: Partial<AlgoParams>;
  }): { feedVersionId: number; normalized: boolean; rawSum: number } {
    const algo = mergeAlgo(args.algo);
    const versionId = this.store.getPropertyVersion(args.propertyVersion);
    if (versionId === null) throw new Error(`物性版本 ${args.propertyVersion} 不存在`);
    const components = this.store.listComponents(versionId);
    const byKey = new Map<string, number>();
    const byId = new Map<number, number>();
    // ext_key 未直接返回，这里重新建立 key 映射
    const rawComps = this.store.db
      .prepare("SELECT id, ext_key FROM components WHERE version_id = ?")
      .all(versionId) as Array<{ id: number; ext_key: string }>;
    for (const rc of rawComps) {
      byKey.set(rc.ext_key, rc.id);
      byId.set(rc.id, rc.id);
    }
    void components;

    const parsed: Array<{ key?: string; componentId?: number; moles: number }> =
      args.format === "csv"
        ? parseFeedCsv(args.text).map((p) => ({ key: p.key, moles: p.moles }))
        : parseFeedJson(args.text);
    const entries = parsed.map((p) => {
      let id: number | undefined;
      if ("key" in p && p.key !== undefined) id = byKey.get(p.key);
      if (id === undefined && p.componentId !== undefined) id = byId.get(p.componentId);
      if (id === undefined) {
        throw new Error(`进料引用了未知组分：${p.key ?? p.componentId}`);
      }
      return { componentId: id, moles: p.moles };
    });

    const prepared = prepareFeed(entries, algo, args.normalize ?? false);
    const payload = {
      versionId: 0,
      name: args.label,
      normalized: prepared.normalized,
      rawSum: prepared.rawSum,
      entries: prepared.componentIds.map((id, i) => ({
        componentId: id,
        raw: prepared.rawMoles[i]!,
        used: prepared.z[i]!,
      })),
    };
    const feedVersionId = this.store.createFeedVersion(
      args.label,
      versionId,
      prepared.normalized,
      prepared.rawSum,
      payload,
    );
    return {
      feedVersionId,
      normalized: prepared.normalized,
      rawSum: prepared.rawSum,
    };
  }

  private loadContext(propertyLabel: string, feedLabel: string, algo: AlgoParams) {
    const propertyVersionId = this.store.getPropertyVersion(propertyLabel);
    if (propertyVersionId === null) throw new Error(`物性版本 ${propertyLabel} 不存在`);
    const storedComp = this.store.listComponents(propertyVersionId);
    const components = this.store.toComponentDefs(storedComp);
    const feedRow = this.store.getFeedVersion(feedLabel);
    if (feedRow === null) throw new Error(`进料版本 ${feedLabel} 不存在`);
    if (feedRow.payload.entries.some((e) => !components.some((c) => c.id === e.componentId))) {
      throw new Error("进料引用的组分不属于指定物性版本");
    }
    const prepared = prepareFeed(
      feedRow.payload.entries.map((e) => ({
        componentId: e.componentId,
        moles: e.raw,
      })),
      algo,
      feedRow.payload.normalized,
    );
    return { propertyVersionId, feedVersionId: feedRow.id, components, prepared };
  }

  runFlash(body: FlashRequestBody): { runId: number; result: FlashResult; balance: unknown } {
    const algo = mergeAlgo(body.algo);
    const ctx = this.loadContext(body.propertyVersion, body.feedVersion, algo);
    const extKeys = this.store.db
      .prepare("SELECT id, ext_key FROM components WHERE version_id = ?")
      .all(ctx.propertyVersionId) as Array<{ id: number; ext_key: string }>;
    const keyOf = new Map(extKeys.map((e) => [e.id, e.ext_key]));
    const k = ctx.prepared.componentIds.map((id, i) => {
      const comp = ctx.components.find((c) => c.id === id)!;
      const dk = body.directK?.[keyOf.get(id)!];
      return resolveK({
        directK: dk,
        antoine: comp.antoine,
        temperatureC: body.temperatureC,
        pressureKpa: body.pressureKpa,
        hasFeed: !ctx.prepared.zero[i],
      });
    });
    const result = flash({
      components: ctx.components,
      feed: ctx.prepared,
      k,
      temperatureC: body.temperatureC,
      pressureKpa: body.pressureKpa,
      algo,
    });
    let balance = null;
    try {
      balance = verifyBalance(result, algo);
    } catch {
      balance = { skipped: true, reason: "degenerate-k-all-one" };
    }
    const report = { result, balance, normalization: {
      normalized: ctx.prepared.normalized,
      rawSum: ctx.prepared.rawSum,
      corrections: ctx.prepared.corrections,
    } };
    const runId = this.store.saveRun({
      kind: "flash",
      propertyVersionId: ctx.propertyVersionId,
      feedVersionId: ctx.feedVersionId,
      temperatureC: body.temperatureC,
      pressureKpa: body.pressureKpa,
      algo,
      request: body,
      report,
    });
    return { runId, result, balance };
  }

  runBubbleDew(args: {
    propertyVersion: string;
    feedVersion: string;
    temperatureC: number;
    algo?: Partial<AlgoParams>;
  }) {
    const algo = mergeAlgo(args.algo);
    const ctx = this.loadContext(args.propertyVersion, args.feedVersion, algo);
    const bd = bubbleDewPressure(ctx.components, ctx.prepared, args.temperatureC);
    const runId = this.store.saveRun({
      kind: "bubble-dew",
      propertyVersionId: ctx.propertyVersionId,
      feedVersionId: ctx.feedVersionId,
      temperatureC: args.temperatureC,
      pressureKpa: null,
      algo,
      request: args,
      report: bd,
    });
    return { runId, ...bd };
  }

  runScan(args: {
    propertyVersion: string;
    feedVersion: string;
    temperatureC: number;
    pressuresKpa: number[];
    algo?: Partial<AlgoParams>;
  }) {
    const algo = mergeAlgo(args.algo);
    const ctx = this.loadContext(args.propertyVersion, args.feedVersion, algo);
    const points = pressureScan(
      ctx.components,
      ctx.prepared,
      args.temperatureC,
      args.pressuresKpa,
      algo,
    );
    const runId = this.store.saveRun({
      kind: "pressure-scan",
      propertyVersionId: ctx.propertyVersionId,
      feedVersionId: ctx.feedVersionId,
      temperatureC: args.temperatureC,
      pressureKpa: null,
      algo,
      request: args,
      report: { points },
    });
    return { runId, points };
  }

  compareRuns(runIdA: number, runIdB: number) {
    const a = this.store.getRun(runIdA);
    const b = this.store.getRun(runIdB);
    if (!a || !b) throw new Error("对比的运行记录不存在");
    const keyMap = (versionId: number) => {
      const rows = this.store.db
        .prepare(
          `SELECT c.id AS cid, c.ext_key AS k FROM components c
           WHERE c.version_id = ?`,
        )
        .all(versionId) as Array<{ cid: number; k: string }>;
      return new Map(rows.map((r) => [r.cid, r.k]));
    };
    const keysA = keyMap(a.propertyVersionId);
    const keysB = keyMap(b.propertyVersionId);
    const ra = (a.report as { result?: FlashResult }).result;
    const rb = (b.report as { result?: FlashResult }).result;
    if (!ra || !rb) {
      return {
        runA: { id: a.runId, kind: a.kind },
        runB: { id: b.runId, kind: b.kind },
        note: "两条记录类型不同或不含闪蒸结果，仅返回原始报告",
        reportA: a.report,
        reportB: b.report,
      };
    }
    const mapA = new Map(
      ra.components.map((c) => [keysA.get(c.componentId) ?? String(c.componentId), c]),
    );
    const componentDiffs = rb.components.map((cb) => {
      const cbKey = keysB.get(cb.componentId) ?? String(cb.componentId);
      const ca = mapA.get(cbKey);
      return {
        componentKey: cbKey,
        name: cb.name,
        kA: ca?.k ?? null,
        kB: cb.k,
        deltaK: cb.k - (ca?.k ?? cb.k),
        feedMolesA: ca?.feedMoles ?? null,
        feedMolesB: cb.feedMoles,
        xA: ca?.x ?? null,
        xB: cb.x ?? null,
        yA: ca?.y ?? null,
        yB: cb.y ?? null,
      };
    });
    return {
      runA: {
        id: a.runId,
        propertyVersionId: a.propertyVersionId,
        feedVersionId: a.feedVersionId,
        pressureKpa: a.pressureKpa,
        regime: ra.regime,
        beta: ra.beta,
      },
      runB: {
        id: b.runId,
        propertyVersionId: b.propertyVersionId,
        feedVersionId: b.feedVersionId,
        pressureKpa: b.pressureKpa,
        regime: rb.regime,
        beta: rb.beta,
      },
      regimeChanged: ra.regime !== rb.regime,
      componentDiffs,
    };
  }
}
