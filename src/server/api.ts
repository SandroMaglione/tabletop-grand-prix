/**
 * The server's routes: the game's (`LeaderboardApi`, `src/api/http.ts`) and the admin's, and
 * the handlers that answer them with `makeLeaderboard`. The Worker serves this; the tests serve
 * the same thing in memory.
 */
import { Effect, Layer, Redacted, Schema } from "effect"
import * as Etag from "effect/http/Etag"
import * as HttpMiddleware from "effect/http/HttpMiddleware"
import * as HttpPlatform from "effect/http/HttpPlatform"
import * as HttpRouter from "effect/http/HttpRouter"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type { RateLimited } from "../api/contract.ts"
import { LeaderboardApi, NameRefusedError, NameTakenError, NotFoundError, UnauthorisedError } from "../api/http.ts"
import { type LeaderboardServer, readAuthorization, sameText } from "./leaderboard.ts"
import { type Action, type Limiter, limits } from "./limits.ts"

// ── The admin's routes ─────────────────────────────────────────────────

const admin = { authorization: Schema.String }

export const AdminPlayer = Schema.Struct({ id: Schema.String, name: Schema.String, createdAt: Schema.Number, banned: Schema.Boolean, runs: Schema.Number })
export const AdminRun = Schema.Struct({
  rank: Schema.Number,
  runId: Schema.String,
  playerId: Schema.String,
  name: Schema.String,
  timeMs: Schema.Number,
  postedAt: Schema.Number
})

export class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("players", "/admin/players", {
      headers: admin,
      query: { search: Schema.optional(Schema.String), limit: Schema.optional(Schema.FiniteFromString) },
      success: Schema.Array(AdminPlayer),
      error: UnauthorisedError
    })
  )
  .add(
    HttpApiEndpoint.get("runs", "/admin/boards/:track/:rules", {
      headers: admin,
      params: { track: Schema.String, rules: Schema.FiniteFromString },
      query: { limit: Schema.optional(Schema.FiniteFromString) },
      success: Schema.Array(AdminRun),
      error: UnauthorisedError
    })
  )
  .add(
    HttpApiEndpoint.put("rename", "/admin/players/:playerId/name", {
      headers: admin,
      params: { playerId: Schema.String },
      payload: Schema.Struct({ name: Schema.String }),
      success: Schema.Struct({ name: Schema.String }),
      error: [UnauthorisedError, NotFoundError, NameRefusedError, NameTakenError]
    })
  )
  .add(
    HttpApiEndpoint.delete("removeRun", "/admin/runs/:runId", {
      headers: admin,
      params: { runId: Schema.String },
      error: [UnauthorisedError, NotFoundError]
    })
  )
  .add(
    HttpApiEndpoint.post("ban", "/admin/players/:playerId/ban", {
      headers: admin,
      params: { playerId: Schema.String },
      success: Schema.Struct({ runsRemoved: Schema.Number }),
      error: [UnauthorisedError, NotFoundError]
    })
  ) {}

/** Everything the Worker serves. The game's client is built from `LeaderboardApi` alone; `scripts/admin.ts` from this. */
export class ServerApi extends LeaderboardApi.add(AdminGroup) {}

// ── The handlers ───────────────────────────────────────────────────────

export interface ServeOptions<R> {
  readonly leaderboard: LeaderboardServer<R>
  readonly limiter: Limiter<R>
  /** The admin's secret. Empty turns the admin routes off. */
  readonly adminSecret: Redacted.Redacted<string>
  /** Origins the browser may call from, or a test of an origin. */
  readonly allowedOrigins: ReadonlyArray<string> | ((origin: string) => boolean)
}

/** Where a request comes from, for rate limits only: it is never written anywhere. */
const clientAddress = Effect.map(HttpServerRequest, (request) => request.headers["cf-connecting-ip"] ?? "local")

const rateLimited = (action: Action, scope: "ip" | "player"): RateLimited => ({ _tag: "RateLimited", retryAfterSeconds: limits[action][scope]?.period ?? 60 })

export const serverLayer = <R>(options: ServeOptions<R>) => {
  const { leaderboard, limiter } = options

  /** Counts the request against the limits on where it comes from (and who sends it), and refuses it once over. */
  const throttle = (action: Action, playerId: string | null) =>
    Effect.gen(function* () {
      const address = yield* clientAddress
      if (!(yield* limiter(action, "ip", address))) return yield* Effect.fail(rateLimited(action, "ip"))
      if (playerId !== null && limits[action].player !== undefined && !(yield* limiter(action, "player", playerId))) {
        return yield* Effect.fail(rateLimited(action, "player"))
      }
    })

  const players = HttpApiBuilder.group(ServerApi, "players", (handlers) =>
    handlers
      .handle("checkName", ({ query }) => Effect.andThen(throttle("checkName", null), leaderboard.checkName(query.name)))
      .handle("register", ({ payload }) => Effect.andThen(throttle("register", null), leaderboard.register(payload.name)))
      .handle("rename", ({ headers, payload }) =>
        Effect.gen(function* () {
          const player = yield* leaderboard.authenticate(headers.authorization)
          yield* throttle("rename", player.id)
          return yield* leaderboard.rename(player, payload.name)
        })
      )
  )

  const runs = HttpApiBuilder.group(ServerApi, "runs", (handlers) =>
    handlers
      .handle("submit", ({ headers, payload }) =>
        Effect.gen(function* () {
          const player = yield* leaderboard.authenticate(headers.authorization)
          yield* throttle("submit", player.id)
          return yield* leaderboard.submit(player, payload.replay)
        })
      )
      .handle("replay", ({ params }) => leaderboard.replay(params.runId))
      .handle("board", ({ params, headers }) => leaderboard.board(params.track, headers.authorization))
      .handle("rival", ({ params, query, headers }) => leaderboard.rival(params.track, query.fasterThanMs ?? null, headers.authorization))
  )

  const isAdmin = (header: string) => {
    const secret = Redacted.value(options.adminSecret)
    const given = /^Bearer (.+)$/.exec(header.trim())?.[1] ?? ""
    // A player's token is never the admin's, even if someone set the secret to look like one.
    return secret.length >= 16 && readAuthorization(header) === null && sameText(given, secret)
  }
  const asAdmin = <A, E, Q>(header: string, effect: Effect.Effect<A, E, Q>) =>
    isAdmin(header) ? effect : Effect.fail({ _tag: "Unauthorised" } as const)

  const adminHandlers = HttpApiBuilder.group(ServerApi, "admin", (handlers) =>
    handlers
      .handle("players", ({ headers, query }) => asAdmin(headers.authorization, leaderboard.adminPlayers(query.search ?? "", Math.min(query.limit ?? 50, 500))))
      .handle("runs", ({ headers, params, query }) =>
        asAdmin(headers.authorization, leaderboard.adminRuns(params.track, params.rules, Math.min(query.limit ?? 50, 500)))
      )
      .handle("rename", ({ headers, params, payload }) =>
        asAdmin(headers.authorization, Effect.map(leaderboard.adminRename(params.playerId, payload.name), (name) => ({ name })))
      )
      .handle("removeRun", ({ headers, params }) => asAdmin(headers.authorization, leaderboard.adminRemoveRun(params.runId)))
      .handle("ban", ({ headers, params }) => asAdmin(headers.authorization, leaderboard.adminBan(params.playerId)))
  )

  return HttpApiBuilder.layer(ServerApi).pipe(
    Layer.provide([players, runs, adminHandlers]),
    Layer.provide([Etag.layer, HttpPlatformStub, Path.layer, FileSystem.layerNoop({})]),
    Layer.provide(
      HttpRouter.middleware(
        HttpMiddleware.cors({
          allowedOrigins: options.allowedOrigins,
          allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
          // The tracing headers are what Effect's client adds unless told not to: an older page still gets through.
          allowedHeaders: ["Content-Type", "Authorization", "traceparent", "tracestate", "b3"],
          maxAge: 86400
        }),
        { global: true }
      )
    )
  )
}

/** Workers have no file system: nothing here serves or uploads files, so file responses die and `FileSystem` is a no-op. */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: { algorithms: new Set<HttpPlatform.CompressionAlgorithm>(), compressResponse: (response) => Effect.succeed(response) },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse is not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse is not supported")
})
