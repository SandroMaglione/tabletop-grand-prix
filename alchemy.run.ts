/**
 * The leaderboard and the site on Cloudflare: the API Worker (`src/server/worker.ts`) with its
 * D1 database and rate limits, and the game built by Vite with `VITE_API_URL` pointing at the
 * API. `docs/server.md` has the commands; every stage (`dev_<user>` locally, `staging`, `prod`)
 * is its own copy of all of it.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import { Stage } from "alchemy/Stage"
import * as Effect from "effect/Effect"
import { siteWorkerName } from "./src/server/stage.ts"
import Api, { Database } from "./src/server/worker.ts"

export default Alchemy.Stack(
  "TabletopGrandPrix",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Stage
    const database = yield* Database
    const api = yield* Api
    const site = yield* Cloudflare.Website.Vite("Site", {
      name: siteWorkerName(stage),
      env: { VITE_API_URL: api.url.as<string>() },
      compatibility: { date: "2026-10-01" },
      // The same port as `pnpm dev`, so local dev is one of the origins the API allows.
      dev: { port: 5380 },
      observability: { enabled: false, logs: { enabled: false, invocationLogs: false }, traces: { enabled: false } },
      logpush: false
    })
    return { api: api.url, site: site.url, database: database.databaseId }
  })
)
