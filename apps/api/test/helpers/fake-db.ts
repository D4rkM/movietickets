/**
 * Test double for the drizzle handle used by the admin services (unit tests,
 * only). Every query builder chain (`select`, `selectDistinct`, `insert`,
 * `update`, `delete`) resolves to the next queued result, in call order, no
 * matter which chained methods are used. `transaction(fn)` runs `fn` with the
 * same fake, and `query.<table>.findFirst/findMany` are plain jest mocks.
 */
export interface FakeDb {
  select: jest.Mock;
  selectDistinct: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  transaction: jest.Mock;
  query: Record<string, { findFirst: jest.Mock; findMany: jest.Mock }>;
  /** Queues the results the next builder chains resolve to (an Error makes that chain reject). */
  queue: (...results: unknown[]) => void;
  /** Every chained call made on the builders, e.g. ["select", "from", "where", "for"]. */
  calls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = [
  "from",
  "where",
  "innerJoin",
  "orderBy",
  "limit",
  "for",
  "values",
  "returning",
  "set",
];

export function createFakeDb(): FakeDb {
  const pending: unknown[] = [];
  const calls: FakeDb["calls"] = [];

  const startChain = (method: string) =>
    jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      const result = pending.length > 0 ? pending.shift() : [];
      const chain: Record<string, unknown> = {};
      for (const chainMethod of CHAIN_METHODS) {
        chain[chainMethod] = (...chainArgs: unknown[]) => {
          calls.push({ method: chainMethod, args: chainArgs });
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(resolve, reject);
      return chain;
    });

  const table = () => ({ findFirst: jest.fn(), findMany: jest.fn() });
  const db: FakeDb = {
    select: startChain("select"),
    selectDistinct: startChain("selectDistinct"),
    insert: startChain("insert"),
    update: startChain("update"),
    delete: startChain("delete"),
    transaction: jest.fn(),
    query: { movies: table(), cinemas: table(), rooms: table(), sessions: table() },
    queue: (...results) => pending.push(...results),
    calls,
  };
  db.transaction.mockImplementation((fn: (tx: FakeDb) => unknown) => fn(db));
  return db;
}

/** A drizzle-style error carrying a Postgres error code on `.cause`. */
export function postgresError(code: string): Error {
  return new Error("Failed query", { cause: { code } });
}
