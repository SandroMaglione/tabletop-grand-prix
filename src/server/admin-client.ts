/**
 * The admin's typed client, for `scripts/admin.ts` and the tests. Never part of the game.
 */
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import { ServerApi } from "./api.ts"

export const makeAdminClient = (baseUrl: string, fetch?: typeof globalThis.fetch) =>
  HttpApiClient.make(ServerApi, { baseUrl }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(fetch === undefined ? Layer.empty : Layer.succeed(FetchHttpClient.Fetch, fetch))
  )

export type AdminClient = Effect.Success<ReturnType<typeof makeAdminClient>>
