/**
 * The `Leaderboard` service over HTTP, against the server at `baseUrl`.
 *
 * `LeaderboardApi` is the one definition of the routes: the server (`src/server`) serves it,
 * and `layerHttp` builds the typed client from it. Every failure the contract does not name
 * (no network, a timeout, a status or body the client does not expect, a defect) comes out as
 * `Unavailable`, so the game never sees an exception.
 *
 * A player proves who they are with `Authorization: Bearer <id>.<secret>`.
 */
import { Effect, Layer, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import {
  Board,
  BoardPage,
  Entry,
  Identity,
  Leaderboard,
  NameRefused,
  NameTaken,
  NotFound,
  RateLimited,
  RunRefused,
  RunReplay,
  Submitted,
  Unauthorised,
  type Unavailable
} from "./contract.ts"

// ── The routes ─────────────────────────────────────────────────────────

/** Each failure has its own status, so the client knows which schema to read the body with. */
export const NameRefusedError = NameRefused.pipe(HttpApiSchema.status(422))
export const NameTakenError = NameTaken.pipe(HttpApiSchema.status(409))
export const UnauthorisedError = Unauthorised.pipe(HttpApiSchema.status(401))
export const RunRefusedError = RunRefused.pipe(HttpApiSchema.status(400))
export const RateLimitedError = RateLimited.pipe(HttpApiSchema.status(429))
export const NotFoundError = NotFound.pipe(HttpApiSchema.status(404))

/** The header a player's requests carry. */
const signedIn = { authorization: Schema.String }
/** The header a request that may come from nobody carries, when it comes from somebody. */
const maybeSignedIn = { authorization: Schema.optional(Schema.String) }

const NamePayload = Schema.Struct({ name: Schema.String })

export class PlayersGroup extends HttpApiGroup.make("players")
  .add(
    HttpApiEndpoint.get("checkName", "/names", {
      query: { name: Schema.String },
      error: [NameRefusedError, NameTakenError, RateLimitedError]
    })
  )
  .add(
    HttpApiEndpoint.post("register", "/players", {
      payload: NamePayload,
      success: Identity,
      error: [NameRefusedError, NameTakenError, RateLimitedError]
    })
  )
  .add(
    HttpApiEndpoint.put("rename", "/players/me/name", {
      headers: signedIn,
      payload: NamePayload,
      success: Identity,
      error: [NameRefusedError, NameTakenError, UnauthorisedError, RateLimitedError]
    })
  ) {}

export class RunsGroup extends HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.post("submit", "/runs", {
      headers: signedIn,
      payload: Schema.Struct({ replay: Schema.String }),
      success: Submitted,
      error: [RunRefusedError, UnauthorisedError, RateLimitedError]
    })
  )
  .add(
    HttpApiEndpoint.get("replay", "/runs/:runId", {
      params: { runId: Schema.String },
      success: RunReplay,
      error: NotFoundError
    })
  )
  .add(
    HttpApiEndpoint.get("board", "/boards/:track", {
      params: { track: Schema.String },
      query: { sector: Schema.optional(Schema.FiniteFromString) },
      headers: maybeSignedIn,
      success: Board,
      error: NotFoundError
    })
  )
  .add(
    HttpApiEndpoint.get("page", "/boards/:track/runs", {
      params: { track: Schema.String },
      query: { from: Schema.FiniteFromString, count: Schema.FiniteFromString, sector: Schema.optional(Schema.FiniteFromString) },
      headers: maybeSignedIn,
      success: BoardPage,
      error: NotFoundError
    })
  )
  .add(
    HttpApiEndpoint.get("rival", "/boards/:track/rival", {
      params: { track: Schema.String },
      query: { fasterThanMs: Schema.optional(Schema.FiniteFromString) },
      headers: maybeSignedIn,
      success: Schema.NullOr(Entry),
      error: NotFoundError
    })
  ) {}

export class LeaderboardApi extends HttpApi.make("Leaderboard").add(PlayersGroup).add(RunsGroup) {}

export const authorization = (identity: Pick<Identity, "id" | "secret">): string => `Bearer ${identity.id}.${identity.secret}`

// ── The client ─────────────────────────────────────────────────────────

/** How long the game waits for an answer before it goes on without one. */
const timeout = "15 seconds"

type Known = NameRefused | NameTaken | Unauthorised | RunRefused | RateLimited | NotFound
const knownTags: ReadonlySet<string> = new Set(["NameRefused", "NameTaken", "Unauthorised", "RunRefused", "RateLimited", "NotFound"])
const isKnown = (error: unknown): error is Known =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string" && knownTags.has(error._tag)

const unavailable: Unavailable = { _tag: "Unavailable" }

/**
 * Keeps the failures the contract names, and turns everything else into `Unavailable`. The
 * error types are the caller's to state: the contract says which of the known failures each
 * call can give, and the server gives no other.
 */
const settle = <A, E extends Known>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, E | Unavailable> =>
  effect.pipe(
    // No tracing headers: a browser asks the server's permission for every header that is not
    // a plain one, and a `traceparent` nobody reads would turn each request into two.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeout(timeout),
    Effect.catchCause((cause) => {
      const failure = cause.reasons.find((reason) => reason._tag === "Fail")
      const error = failure?._tag === "Fail" ? failure.error : undefined
      return Effect.fail(isKnown(error) ? (error as E) : unavailable)
    })
  )

export interface HttpOptions {
  /** The fetch to send with, for tests that answer in memory. The global one by default. */
  readonly fetch?: typeof globalThis.fetch
}

export const layerHttp = (baseUrl: string, options: HttpOptions = {}): Layer.Layer<Leaderboard> =>
  Layer.effect(
    Leaderboard,
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(LeaderboardApi, { baseUrl })
      const maybe = (identity: Identity | null) => (identity === null ? {} : { authorization: authorization(identity) })
      return Leaderboard.of({
        checkName: (name) => settle(client.players.checkName({ query: { name } })),
        register: (name) => settle(client.players.register({ payload: { name } })),
        rename: (identity, name) => settle(client.players.rename({ headers: { authorization: authorization(identity) }, payload: { name } })),
        submit: (identity, replay) => settle(client.runs.submit({ headers: { authorization: authorization(identity) }, payload: { replay } })),
        board: (track, identity, order) => settle(client.runs.board({ params: { track }, query: order === null ? {} : { sector: order }, headers: maybe(identity) })),
        page: (track, from, count, identity, order) =>
          settle(client.runs.page({ params: { track }, query: order === null ? { from, count } : { from, count, sector: order }, headers: maybe(identity) })),
        rival: (track, fasterThanMs, identity) =>
          settle(
            client.runs.rival({
              params: { track },
              query: fasterThanMs === null ? {} : { fasterThanMs },
              headers: maybe(identity)
            })
          ),
        replay: (runId) => settle(client.runs.replay({ params: { runId } }))
      })
    })
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(options.fetch === undefined ? Layer.empty : Layer.succeed(FetchHttpClient.Fetch, options.fetch))
  )
