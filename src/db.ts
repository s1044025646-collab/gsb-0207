import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AlgoParams, AntoineCoeff, ComponentDef } from "./common";

export interface StoredComponent {
  id: number;
  versionId: number;
  name: string;
  cas: string | null;
  antoine: AntoineCoeff | null;
}

export interface StoredFeed {
  versionId: number;
  name: string;
  normalized: boolean;
  rawSum: number;
  entries: Array<{ componentId: number; raw: number; used: number }>;
}

export interface RunRecord {
  runId: number;
  kind: string;
  createdAt: string;
  propertyVersionId: number;
  feedVersionId: number;
  temperatureC: number;
  pressureKpa: number | null;
  algo: AlgoParams;
  request: unknown;
  report: unknown;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS property_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES property_versions(id),
        ext_key TEXT NOT NULL,
        name TEXT NOT NULL,
        cas TEXT,
        antoine_json TEXT,
        UNIQUE(version_id, ext_key)
      );
      CREATE TABLE IF NOT EXISTS feed_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_version_id INTEGER NOT NULL REFERENCES property_versions(id),
        label TEXT NOT NULL UNIQUE,
        normalized INTEGER NOT NULL,
        raw_sum REAL NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        property_version_id INTEGER NOT NULL,
        feed_version_id INTEGER NOT NULL,
        temperature_c REAL NOT NULL,
        pressure_kpa REAL,
        algo_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createPropertyVersion(label: string): number {
    const r = this.db
      .prepare("INSERT INTO property_versions(label) VALUES (?)")
      .run(label);
    return Number(r.lastInsertRowid);
  }

  getPropertyVersion(label: string): number | null {
    const row = this.db
      .prepare("SELECT id FROM property_versions WHERE label = ?")
      .get(label) as { id: number } | undefined;
    return row ? row.id : null;
  }

  listPropertyVersions(): Array<{ id: number; label: string; createdAt: string }> {
    return this.db
      .prepare("SELECT id, label, created_at AS createdAt FROM property_versions ORDER BY id")
      .all() as Array<{ id: number; label: string; createdAt: string }>;
  }

  upsertComponent(
    versionId: number,
    extKey: string,
    name: string,
    cas: string | null,
    antoine: AntoineCoeff | null,
  ): number {
    const existing = this.db
      .prepare("SELECT id FROM components WHERE version_id = ? AND ext_key = ?")
      .get(versionId, extKey) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE components SET name=?, cas=?, antoine_json=? WHERE id=?",
        )
        .run(name, cas, antoine ? JSON.stringify(antoine) : null, existing.id);
      return existing.id;
    }
    const r = this.db
      .prepare(
        "INSERT INTO components(version_id, ext_key, name, cas, antoine_json) VALUES (?,?,?,?,?)",
      )
      .run(versionId, extKey, name, cas, antoine ? JSON.stringify(antoine) : null);
    return Number(r.lastInsertRowid);
  }

  listComponents(versionId: number): StoredComponent[] {
    const rows = this.db
      .prepare(
        "SELECT id, version_id AS versionId, name, cas, antoine_json AS aj FROM components WHERE version_id = ? ORDER BY id",
      )
      .all(versionId) as Array<{
      id: number;
      versionId: number;
      name: string;
      cas: string | null;
      aj: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      versionId: r.versionId,
      name: r.name,
      cas: r.cas,
      antoine: r.aj ? (JSON.parse(r.aj) as AntoineCoeff) : null,
    }));
  }

  toComponentDefs(stored: StoredComponent[]): ComponentDef[] {
    return stored.map((s) => ({
      id: s.id,
      name: s.name,
      cas: s.cas,
      antoine: s.antoine,
    }));
  }

  createFeedVersion(
    label: string,
    propertyVersionId: number,
    normalized: boolean,
    rawSum: number,
    payload: StoredFeed,
  ): number {
    const r = this.db
      .prepare(
        "INSERT INTO feed_versions(label, property_version_id, normalized, raw_sum, payload_json) VALUES (?,?,?,?,?)",
      )
      .run(label, propertyVersionId, normalized ? 1 : 0, rawSum, JSON.stringify(payload));
    return Number(r.lastInsertRowid);
  }

  getFeedVersion(label: string): { id: number; payload: StoredFeed } | null {
    const row = this.db
      .prepare(
        "SELECT id, payload_json AS pj FROM feed_versions WHERE label = ?",
      )
      .get(label) as { id: number; pj: string } | undefined;
    return row ? { id: row.id, payload: JSON.parse(row.pj) as StoredFeed } : null;
  }

  listFeedVersions(): Array<{
    id: number;
    label: string;
    propertyVersionId: number;
    normalized: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, label, property_version_id AS pvid, normalized FROM feed_versions ORDER BY id`,
      )
      .all() as Array<{ id: number; label: string; pvid: number; normalized: number }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      propertyVersionId: r.pvid,
      normalized: r.normalized === 1,
    }));
  }

  saveRun(args: {
    kind: string;
    propertyVersionId: number;
    feedVersionId: number;
    temperatureC: number;
    pressureKpa: number | null;
    algo: AlgoParams;
    request: unknown;
    report: unknown;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO runs(kind, property_version_id, feed_version_id, temperature_c,
           pressure_kpa, algo_json, request_json, report_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        args.kind,
        args.propertyVersionId,
        args.feedVersionId,
        args.temperatureC,
        args.pressureKpa,
        JSON.stringify(args.algo),
        JSON.stringify(args.request),
        JSON.stringify(args.report),
      );
    return Number(r.lastInsertRowid);
  }

  getRun(runId: number): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id AS runId, kind, created_at AS createdAt, property_version_id AS propertyVersionId,
                feed_version_id AS feedVersionId, temperature_c AS temperatureC,
                pressure_kpa AS pressureKpa, algo_json AS algo, request_json AS request,
                report_json AS report
         FROM runs WHERE id = ?`,
      )
      .get(runId) as
      | Omit<RunRecord, "algo" | "request" | "report"> & {
          algo: string;
          request: string;
          report: string;
        }
      | undefined;
    if (!row) return null;
    return {
      ...row,
      algo: JSON.parse(row.algo) as AlgoParams,
      request: JSON.parse(row.request),
      report: JSON.parse(row.report),
    };
  }

  listRuns(limit = 50): Array<{ runId: number; kind: string; createdAt: string }> {
    return this.db
      .prepare(
        `SELECT id AS runId, kind, created_at AS createdAt FROM runs
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ runId: number; kind: string; createdAt: string }>;
  }

  close(): void {
    this.db.close();
  }
}
