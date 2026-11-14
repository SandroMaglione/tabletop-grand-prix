/**
 * The server's `Sql` on Node's own SQLite, with the real migrations applied: the same SQL
 * D1 runs, in memory.
 */
import { readdirSync, readFileSync } from "node:fs"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect } from "effect"
import { type Sql, SqlError, type SqlValue, type Statement } from "../src/server/sql.ts"

const migrations = new URL("../migrations/", import.meta.url)

export const memorySql = (): { readonly sql: Sql; readonly db: DatabaseSync } => {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"))
  const values = (list: ReadonlyArray<SqlValue>): Array<SQLInputValue> => [...list]
  const sql: Sql = {
    all: <Row>(query: string, list: ReadonlyArray<SqlValue> = []) =>
      Effect.try({ try: () => db.prepare(query).all(...values(list)) as unknown as ReadonlyArray<Row>, catch: (cause) => new SqlError({ cause }) }),
    // As D1 does: in order, inside one transaction.
    batch: (statements: ReadonlyArray<Statement>) =>
      Effect.try({
        try: () => {
          db.exec("BEGIN")
          try {
            const results = statements.map(({ query, values: list = [] }) => db.prepare(query).all(...values(list)) as ReadonlyArray<unknown>)
            db.exec("COMMIT")
            return results
          } catch (error) {
            db.exec("ROLLBACK")
            throw error
          }
        },
        catch: (cause) => new SqlError({ cause })
      }),
    run: (query: string, list: ReadonlyArray<SqlValue> = []) =>
      Effect.try({ try: () => Number(db.prepare(query).run(...values(list)).changes), catch: (cause) => new SqlError({ cause }) })
  }
  return { sql, db }
}
