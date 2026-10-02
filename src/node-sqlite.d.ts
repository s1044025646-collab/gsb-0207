declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; enableForeignKeyConstraints?: boolean });
    open(): void;
    close(): void;
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
  }
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    setAllowBareNamedParameters(enabled: boolean): void;
  }
}
