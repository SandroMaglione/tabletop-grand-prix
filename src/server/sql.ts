/**
 * The little the server asks of a database: run a statement with values, get rows back. D1 in
 * the Worker (`d1.ts`), Node's own SQLite in the tests (`test/sqlite.ts`), the same SQL.
 */
import { Data, type Effect } from "effect"

export type SqlValue = string | number | null

export interface Statement {
  readonly query: string
  readonly values?: ReadonlyArray<SqlValue>
}

export class SqlError extends Data.TaggedError("SqlError")<{ readonly cause: unknown }> {}

/** `R` is what the database needs from the runtime to be reached (D1 needs the Worker's). */
export interface Sql<R = never> {
  /** The rows a statement gives (a `RETURNING` clause included). */
  readonly all: <Row>(query: string, values?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<Row>, SqlError, R>
  /**
   * Several statements in one round trip, in order, all or none: the rows each gives. A D1
   * query from a Worker far from the database costs a round trip, so the server asks for
   * what it needs at once.
   */
  readonly batch: (statements: ReadonlyArray<Statement>) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError, R>
  /** Runs a statement and says how many rows it changed. */
  readonly run: (query: string, values?: ReadonlyArray<SqlValue>) => Effect.Effect<number, SqlError, R>
}
