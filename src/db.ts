import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Component, Feed, FlashResult, PropertyVersion, ScanResult, BubbleDewResult } from './types.js';
import { AlgorithmParams, DEFAULT_ALGORITHM_PARAMS } from './constants.js';

export interface StoredReport {
  id: number;
  kind: string;
  feedId: number | null;
  versionId: number | null;
  requestJson: string;
  resultJson: string;
  algorithmJson: string;
  createdAt: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS property_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES property_versions(id),
        name TEXT NOT NULL,
        cas TEXT,
        pressure_unit TEXT NOT NULL,
        antoine_a REAL, antoine_b REAL, antoine_c REAL,
        t_min REAL, t_max REAL,
        UNIQUE(version_id, name)
      );
      CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        total_moles REAL NOT NULL DEFAULT 1,
        composition_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        feed_id INTEGER,
        version_id INTEGER,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        algorithm_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createVersion(name: string, note: string | null = null): number {
    const ts = new Date().toISOString();
    const r = this.db.prepare('INSERT INTO property_versions(name, created_at, note) VALUES (?,?,?)').run(name, ts, note);
    return Number(r.lastInsertRowid);
  }

  getVersion(name: string): (PropertyVersion & { rowId: number }) | null {
    const row = this.db.prepare('SELECT id,name,created_at,note FROM property_versions WHERE name=?').get(name) as
      | { id: number; name: string; created_at: string; note: string | null }
      | undefined;
    return row ? { id: row.id, rowId: row.id, name: row.name, createdAt: row.created_at, note: row.note } : null;
  }

  listVersions(): PropertyVersion[] {
    return (this.db.prepare('SELECT id,name,created_at,note FROM property_versions ORDER BY id').all() as Array<{
      id: number; name: string; created_at: string; note: string | null;
    }>).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, note: r.note }));
  }

  addComponent(versionId: number, c: Component): void {
    this.db
      .prepare(
        `INSERT INTO components(version_id,name,cas,pressure_unit,antoine_a,antoine_b,antoine_c,t_min,t_max)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(versionId, c.name, c.cas ?? null, c.pressureUnit, c.antoineA, c.antoineB, c.antoineC, c.tMin, c.tMax);
  }

  getComponents(versionId: number): Component[] {
    return (this.db
      .prepare(
        `SELECT name,cas,pressure_unit,antoine_a,antoine_b,antoine_c,t_min,t_max
         FROM components WHERE version_id=? ORDER BY name`,
      )
      .all(versionId) as Array<{
      name: string; cas: string | null; pressure_unit: string;
      antoine_a: number | null; antoine_b: number | null; antoine_c: number | null;
      t_min: number | null; t_max: number | null;
    }>).map((r) => ({
      id: null,
      name: r.name,
      cas: r.cas,
      pressureUnit: r.pressure_unit,
      antoineA: r.antoine_a,
      antoineB: r.antoine_b,
      antoineC: r.antoine_c,
      tMin: r.t_min,
      tMax: r.t_max,
    }));
  }

  upsertFeed(name: string, composition: Record<string, number>, totalMoles = 1): number {
    const existing = this.db.prepare('SELECT id FROM feeds WHERE name=?').get(name) as { id: number } | undefined;
    const ts = new Date().toISOString();
    if (existing) {
      this.db.prepare('UPDATE feeds SET composition_json=?, total_moles=?, created_at=? WHERE id=?').run(
        JSON.stringify(composition), totalMoles, ts, existing.id,
      );
      return existing.id;
    }
    const r = this.db
      .prepare('INSERT INTO feeds(name,total_moles,composition_json,created_at) VALUES (?,?,?,?)')
      .run(name, totalMoles, JSON.stringify(composition), ts);
    return Number(r.lastInsertRowid);
  }

  getFeed(name: string): (Feed & { rowId: number }) | null {
    const row = this.db
      .prepare('SELECT id,name,total_moles,composition_json FROM feeds WHERE name=?')
      .get(name) as { id: number; name: string; total_moles: number; composition_json: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      rowId: row.id,
      name: row.name,
      totalMoles: row.total_moles,
      composition: JSON.parse(row.composition_json) as Record<string, number>,
    };
  }

  listFeeds(): Feed[] {
    return (this.db.prepare('SELECT id,name,total_moles,composition_json FROM feeds ORDER BY id').all() as Array<{
      id: number; name: string; total_moles: number; composition_json: string;
    }>).map((r) => ({ id: r.id, name: r.name, totalMoles: r.total_moles, composition: JSON.parse(r.composition_json) }));
  }

  /** 冻结一次计算的请求、结果与算法参数，返回报告 id，重启后可复核。 */
  saveReport(
    kind: 'flash' | 'bubble' | 'dew' | 'scan' | 'compare',
    feedId: number | null,
    versionId: number | null,
    request: unknown,
    result: FlashResult | BubbleDewResult | ScanResult | unknown,
    algorithm: AlgorithmParams = DEFAULT_ALGORITHM_PARAMS,
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO reports(kind,feed_id,version_id,request_json,result_json,algorithm_json,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(kind, feedId, versionId, JSON.stringify(request), JSON.stringify(result), JSON.stringify(algorithm), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getReport(id: number): StoredReport | null {
    const row = this.db
      .prepare('SELECT id,kind,feed_id,version_id,request_json,result_json,algorithm_json,created_at FROM reports WHERE id=?')
      .get(id) as
      | { id: number; kind: string; feed_id: number | null; version_id: number | null; request_json: string; result_json: string; algorithm_json: string; created_at: string }
      | undefined;
    return row
      ? { id: row.id, kind: row.kind, feedId: row.feed_id, versionId: row.version_id, requestJson: row.request_json, resultJson: row.result_json, algorithmJson: row.algorithm_json, createdAt: row.created_at }
      : null;
  }

  listReports(): Array<{ id: number; kind: string; createdAt: string }> {
    return (this.db.prepare('SELECT id,kind,created_at FROM reports ORDER BY id').all() as Array<{
      id: number; kind: string; created_at: string;
    }>).map((r) => ({ id: r.id, kind: r.kind, createdAt: r.created_at }));
  }

  close(): void {
    this.db.close();
  }
}
