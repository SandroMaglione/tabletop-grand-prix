/**
 * The leaderboard's Worker: `serverLayer` (`api.ts`) on D1, with Cloudflare's rate limit
 * bindings, deployed by `alchemy.run.ts`.
 *
 * Driving a replay again is the expensive part of a request (`runReplay`, about 2 900 ticks
 * of the simulation for a 24 s lap). See `docs/server.md` for what it costs in CPU time.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import { Config, Effect, Layer, Redacted } from "effect"
import * as HttpRouter from "effect/http/HttpRouter"
import { serverLayer } from "./api.ts"
import { sqlFromD1 } from "./d1.ts"
import { makeLeaderboard } from "./leaderboard.ts"
import { type Action, type Limiter, limits, type Scope } from "./limits.ts"
import { apiWorkerName, isLocalOrigin, localOrigins, rateLimitBase, siteOriginFor } from "./stage.ts"

export const Database = Cloudflare.D1.Database("Leaderboard", { migrations: "./migrations", primaryLocationHint: "weur" })

/** Each (action, scope) pair in `limits.ts` is one binding, in a fixed order so its namespace id never moves. */
const bindings: ReadonlyArray<readonly [Action, Scope]> = [
  ["checkName", "ip"],
  ["register", "ip"],
  ["rename", "ip"],
  ["rename", "player"],
  ["submit", "ip"],
  ["submit", "player"]
]

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.map(Effect.service(Stage), (stage) => ({
    main: import.meta.url,
    name: apiWorkerName(stage),
    compatibility: { date: "2026-10-01" },
    // Nothing about a request is kept: no Workers Logs, no traces, no Logpush. The server
    // stores no IP address, and neither does Cloudflare's logging on its behalf.
    observability: { enabled: false, logs: { enabled: false, invocationLogs: false }, traces: { enabled: false } },
    logpush: false
  })),
  Effect.gen(function* () {
    const stage = yield* Stage
    const db = yield* Cloudflare.D1.QueryDatabase(Database)
    // Read from the stage's env file at deploy (`.env.staging`, `.env.prod`); bound as a secret.
    const adminSecret = yield* Config.Redacted("ADMIN_SECRET").pipe(Config.withDefault(Redacted.make("")))
    const ownUrl = yield* Cloudflare.Worker.URL

    const base = rateLimitBase(stage)
    const limiters = new Map<string, Cloudflare.RateLimitClient>()
    for (const [index, [action, scope]] of bindings.entries()) {
      const limit = limits[action][scope]
      if (limit === undefined) continue
      const client = yield* Cloudflare.RateLimit(`LIMIT_${action.toUpperCase()}_${scope.toUpperCase()}`, {
        namespaceId: base + index,
        simple: { limit: limit.limit, period: limit.period }
      })
      limiters.set(`${action}:${scope}`, client)
    }
    const limiter: Limiter<RuntimeContext> = (action, scope, key) => {
      const client = limiters.get(`${action}:${scope}`)
      if (client === undefined) return Effect.succeed(true)
      // When the limiter itself fails, let the request through: it guards against floods only.
      return client.limit({ key }).pipe(
        Effect.map((outcome) => outcome.success),
        Effect.catch(() => Effect.succeed(true))
      )
    }

    /** Filled on the first request, when the Worker's own URL can be read. */
    let siteOrigin: string | null = null
    let local = false
    const allowedOrigin = (origin: string) => localOrigins.includes(origin) || origin === siteOrigin || (local && isLocalOrigin(origin))

    const handler = yield* HttpRouter.toHttpEffect(
      serverLayer({ leaderboard: makeLeaderboard(sqlFromD1(db.raw)), limiter, adminSecret, allowedOrigins: allowedOrigin })
    )

    return {
      fetch: Effect.gen(function* () {
        if (siteOrigin === null) {
          const url = yield* ownUrl
          siteOrigin = siteOriginFor(url, stage) ?? ""
          local = isLocalOrigin(new URL(url).origin)
        }
        return yield* handler
      })
    }
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding, Cloudflare.Workers.RateLimitBinding)))
) {}
