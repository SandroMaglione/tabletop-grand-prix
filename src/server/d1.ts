/**
 * `Sql` over a D1 database binding.
 */
import { Effect } from "effect"
import { type Sql, SqlError, type SqlValue, type Statement } from "./sql.ts"

/** The part of D1's binding the server uses (`@cloudflare/workers-types` is not a direct dependency). */
export interface D1Like {
  prepare(query: string): D1StatementLike
  batch(statements: ReadonlyArray<D1StatementLike>): Promise<ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>>
}
interface D1StatementLike {
  bind(...values: ReadonlyArray<unknown>): D1StatementLike
  all<Row>(): Promise<{ readonly results: ReadonlyArray<Row> }>
  run(): Promise<{ readonly meta: { readonly changes: number } }>
}

export const sqlFromD1 = <R>(database: Effect.Effect<D1Like, never, R>): Sql<R> => {
  const statement = (query: string, values: ReadonlyArray<SqlValue>) =>
    Effect.map(database, (db) => (values.length > 0 ? db.prepare(query).bind(...values) : db.prepare(query)))
  return {
    all: <Row>(query: string, values: ReadonlyArray<SqlValue> = []) =>
      Effect.flatMap(statement(query, values), (prepared) =>
        Effect.tryPromise({ try: () => prepared.all<Row>(), catch: (cause) => new SqlError({ cause }) })
      ).pipe(Effect.map((result) => result.results)),
    batch: (statements: ReadonlyArray<Statement>) =>
      Effect.flatMap(database, (db) =>
        Effect.tryPromise({
          try: () => db.batch(statements.map(({ query, values = [] }) => (values.length > 0 ? db.prepare(query).bind(...values) : db.prepare(query)))),
          catch: (cause) => new SqlError({ cause })
        })
      ).pipe(Effect.map((results) => results.map((result) => result.results))),
    run: (query: string, values: ReadonlyArray<SqlValue> = []) =>
      Effect.flatMap(statement(query, values), (prepared) =>
        Effect.tryPromise({ try: () => prepared.run(), catch: (cause) => new SqlError({ cause }) })
      ).pipe(Effect.map((result) => result.meta.changes))
  }
}
