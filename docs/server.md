# The leaderboard server

A shared leaderboard on Cloudflare, deployed with [Alchemy](https://alchemy.run) 2 (beta.87). Players
have no account: a device registers a name and keeps the `Identity` it gets back. Each board is one
track under one rules version and holds each player's best run, with its replay, so anyone can race
it as a ghost. The server never takes a time from a request: it drives the replay again with
`runReplay(bytes, { ghost: false })` and files `Math.floor` of the time that gives.

The game talks to it only through the `Leaderboard` service in `src/api/contract.ts`:

```ts
import { layerHttp } from "./api/http.ts"
const leaderboard = layerHttp(import.meta.env.VITE_API_URL) // a Layer<Leaderboard>
```

`VITE_API_URL` is set by the stack for the deployed site and for `pnpm dev:server`. Under plain
`pnpm dev` it is undefined, so the page should treat that as "no leaderboard". Every failure the
contract does not name (offline, timeout after 15 s, a 5xx, a body it cannot read) comes back as
`Unavailable`. The client never throws.

## Files

| Where | What |
|---|---|
| `alchemy.run.ts` | The stack: the API Worker, its D1 database, and the site (`Cloudflare.Website.Vite`) built with `VITE_API_URL` |
| `src/api/http.ts` | `LeaderboardApi`, the routes, defined once with Effect's `HttpApi`; `layerHttp`, the typed client |
| `src/server/worker.ts` | The Worker: D1 binding, rate limit bindings, admin secret, CORS |
| `src/server/api.ts` | The admin routes, and the handlers for every route (`serverLayer`), served by the Worker and by the tests |
| `src/server/leaderboard.ts` | What the server does: players, names, runs, boards, admin, over a small `Sql` interface |
| `src/server/names.ts`, `blocklist.ts` | Name folding, kept-back names, the blocklist |
| `src/server/limits.ts` | The rate limits |
| `src/server/stage.ts` | Per-stage Worker names and rate limit namespaces |
| `migrations/` | D1 schema, applied by Alchemy on every deploy (and by the tests on Node's SQLite) |
| `scripts/admin.ts`, `e2e.ts`, `cpu.ts` | Admin, an end-to-end check over HTTP, a CPU load check |
| `test/names.test.ts`, `test/server.test.ts` | Name rules, and the whole server in memory through `layerHttp` |

## Commands

Cloudflare is reached through the Alchemy profile `admin` on this machine. The scripts pass
`--profile ${ALCHEMY_PROFILE:-admin}`, so set `ALCHEMY_PROFILE` to use another.

| | |
|---|---|
| `pnpm dev` | The page alone on port 5380, no server (unchanged) |
| `pnpm dev:server` | `alchemy dev`: the API in local workerd at http://localhost:1337 with a local D1, and the site in Vite at 5380 (5381 if `pnpm dev` already holds 5380). Stage `dev_<user>`, nothing in the cloud. Reads `.env` |
| `pnpm deploy:staging` | Deploys stage `staging`, reading `.env.staging`. Add `--yes` to skip the prompt |
| `pnpm deploy:prod` | Deploys stage `prod`, reading `.env.prod` |
| `pnpm destroy:staging` | Deletes everything in `staging`, its database included |
| `pnpm destroy:dev` | Deletes the local dev stage's state |
| `node scripts/e2e.ts <api url> --env <file>` | Register, refuse a taken and a blocked name, submit the real replay, board, rival, replay, rename; then bans the players it made |
| `node scripts/cpu.ts <api url> --env <file>` | 5 players × 6 submits, prints statuses, counts requests the platform killed |
| `pnpm exec alchemy logs --tail --stage staging --profile admin -r Api` | Live tail with each request's CPU and wall time. A tail session stores nothing |

Destroying prod (`alchemy destroy --stage prod --profile admin --env-file .env.prod`) deletes every
run. There is deliberately no script for it.

### The env files

Gitignored, one per stage: `.env` (local dev), `.env.staging`, `.env.prod`. Each holds:

```sh
ADMIN_SECRET=<64 hex characters>   # bound to the Worker as a secret at deploy; the admin script sends it
API_URL=<the api URL the deploy printed>   # read by scripts/admin.ts only
```

All three exist on this machine. To make one again: `printf 'ADMIN_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.prod`,
then deploy so the Worker gets the new value. Without `ADMIN_SECRET` (or one shorter than 16
characters) the admin routes answer `Unauthorised` to everything.

## What a stage creates on Cloudflare

For stage `<s>` (`staging`, `prod`):

- Worker `tabletop-grand-prix-api-<s>`: the API, on `https://tabletop-grand-prix-api-<s>.lass-maglio.workers.dev`.
  It has a D1 binding, six rate limit bindings (namespaces 7200–7205 for staging, 7100–7105 for prod),
  the `ADMIN_SECRET` secret, and its own URL.
- Worker `tabletop-grand-prix-<s>`: the site, assets only, on `https://tabletop-grand-prix-<s>.lass-maglio.workers.dev`. In `prod` it is also on the game's own address, https://tabletop-grand-prix.typeonce.games (`productionDomain` in `src/server/stage.ts`); the other stages stay on workers.dev.
- D1 database `Leaderboard` (Alchemy names it), primary in Western Europe (`weur`).

Workers Logs, invocation logs, traces and Logpush are off on both Workers. State goes to the
account's existing Alchemy state store (`Cloudflare.state()`, the `alchemy-state-store` Worker).
The first run here upgraded that Worker from v7 to v8.

`staging` is deployed and running:
API https://tabletop-grand-prix-api-staging.lass-maglio.workers.dev,
site https://tabletop-grand-prix-staging.lass-maglio.workers.dev. The site was last built from the
page in progress on 2026-11-15, which already reads `VITE_API_URL`. Deploying again rebuilds it.

## Routes

| Route | Contract | Notes |
|---|---|---|
| `GET /names?name=` | `checkName` | 204 when free |
| `POST /players {name}` | `register` | |
| `PUT /players/me/name {name}` | `rename` | signed in |
| `POST /runs {replay}` | `submit` | signed in |
| `GET /runs/:runId` | `replay` | |
| `GET /boards/:track?sector=` | `board` | signed in or not; `sector` (0 is the first) orders it by that sector |
| `GET /boards/:track/runs?from=&count=&sector=` | `page` | signed in or not |
| `GET /boards/:track/rival?fasterThanMs=` | `rival` | signed in or not |
| `GET /admin/players?search=&limit=`, `GET /admin/boards/:track/:rules`, `PUT /admin/players/:id/name`, `DELETE /admin/runs/:runId`, `POST /admin/players/:id/ban`, `POST /admin/sectors?limit=` | admin | `Authorization: Bearer <ADMIN_SECRET>` |

A player signs a request with `Authorization: Bearer <id>.<secret>`. The secret is 32 random bytes,
and the server keeps only its SHA-256. A header that does not prove a player is `Unauthorised` on
`rename` and `submit`, and on reads the request counts as coming from nobody. Failures have their
own statuses: `NameRefused` 422, `NameTaken` 409, `Unauthorised` 401, `RunRefused` 400,
`RateLimited` 429, `NotFound` 404.

CORS allows the stage's site, http://localhost:5380 and http://127.0.0.1:5380. Under `alchemy dev`
it allows any localhost port. The API works out the site's origin from its own workers.dev URL, since
the two only differ in the Worker name. The site's own domain in `prod` is allowed as well (`domainOriginFor`).

## Boards

- A board is `(track, rules)`, both read from the replay. A replay under other rules than the
  server's `rulesVersion` is refused with `other-rules`, and every read is of the server's rules.
- Each player keeps only their best run per board. One SQL upsert files a run only if it is
  strictly faster, so two runs sent at once cannot both stay, and an equal time keeps the first.
  A run that does not improve is answered with `improved: false`, the kept run's `runId` and rank,
  and this run's `timeMs`. Nothing is stored.
- Ranking orders by time, then by when the run was posted, so ties go to whoever posted first.
- `board`: the top 10, `total`, and `me`. `around` is the player's run with two runs on each
  side, minus any already in `top`: rank 15 gives 13–17, and rank 11 gives 11–13.
- Each run is filed with its sectors (`sectors_ms`, JSON): whole milliseconds that add up to its
  `time_ms` (`wholeSectors` in `src/api/sectors.ts`), and every board line carries them as
  `sectorsMs`. `board` and `page` with `sector` rank the runs by that sector alone, ties to whoever
  posted first; only runs whose sectors are known are on such a board, and its `total` and `me`
  are of it. A sector the track has not is `NotFound`.
- Runs filed before migration `0002_sectors` have no sectors until `pnpm admin <stage> fill-sectors`
  drives their replays again (`POST /admin/sectors`, up to 50 a request, 10 by default; the script
  asks for 20 at a time until none is left). Run it once after deploying. A replay that no longer
  drives is filed with `[]` and stays off the sector boards.
- `rival`: the slowest run strictly faster than `fasterThanMs` that is not the asker's, or the
  slowest run on the board when `fasterThanMs` is null. Null when nobody is ahead.
- Replays over 64 KB of text are refused with `too-large` before anything is decoded. A
  three-minute lap that changes input every tick is about 56 KB.
- Each request needs one or two D1 round trips: statements are batched, and the player's row is
  read alongside the board. From New Zealand to a `weur` database a round trip takes about 280 ms.

## Names

A name is tidied (`tidyName`) and checked for shape (`nameShape`) exactly as the game does, then:

1. **Folded** for comparison: NFKD with accents stripped, lowercased, ligatures written out
   (ß → ss), look-alikes as the letter they resemble (0→o, 1/l/i→i, 2→z, 3→e, 4→a, 5→s, 6/9→g,
   7→t, 8→b, plus Cyrillic and Greek look-alikes), and everything but letters and digits dropped.
   "Sandro", "s4ndr0", "S a n d r o" and "ѕаndrо" (Cyrillic) are one name. The folded form is unique
   in the database, so one name belongs to one device. A player may change how their own name is
   written ("lap king" → "LAP KING").
2. **Blocked** (`blocklist.ts`, English and Italian): `anywhere` words are refused even inside
   other letters, and each letter may repeat ("fuuuck"). `whole` words are refused only as the whole
   name or one of its words, split at separators or capitals ("Big Dick", "BigDick", "dick69"), so
   "Dickens", "Cocktail" and "Pacifica" pass. `innocent` words are removed before the `anywhere`
   check ("Scunthorpe", "Montenegro", "Shiitake"). Add a word, then a case to `test/names.test.ts`.
   Known trade-offs: "Negro" and "Negri" are also Italian surnames, and "negro" is refused anywhere;
   lowercase compounds of `whole` words ("bigdick") pass.
3. **Kept back** (`reserved`): admin, moderator, official, typeonce, pixijs and cloudflare
   anywhere in a name; staff, mod, pixi, ritmo, anonymous, guest, player, null, test, bot and others
   as the whole name, with or without digits after it ("Player1"). An admin may give a kept-back name
   (a placeholder), never a blocked one.

## Abuse

Rate limits (`limits.ts`) count per IP address (`cf-connecting-ip`) and, once a request is signed
in, per player. They use Cloudflare's rate limit binding, which counts roughly and per location.

| | per IP | per player |
|---|---|---|
| `checkName` | 20 / 10 s | |
| `register` | 10 / 60 s | |
| `rename` | 10 / 60 s | 3 / 60 s |
| `submit` | 30 / 60 s | 6 / 60 s |

Over a limit the answer is `RateLimited` with that limit's period as `retryAfterSeconds`. Reads are
not limited: the contract gives them no `RateLimited`. If the limiter itself fails, the request goes
through. No IP address is stored. It reaches the rate limiter as a key and nothing else.

## Admin

```sh
pnpm admin staging players [search]          # id, name, runs, since, BANNED
pnpm admin staging board [track] [limit]      # rank, time, name, run id, player id
pnpm admin staging rename <playerId> <name>
pnpm admin staging remove-run <runId>
pnpm admin staging ban <playerId>             # identity stops working, runs deleted, name stays taken
```

Use `dev` for local dev (http://localhost:1337) and `prod` for production. The secret is read from
the stage's env file and sent only to that stage's API. There is no unban: a ban sets `banned_at`
in `players`, and only clearing it in the D1 console undoes one.

## CPU time

Driving a lap again is the one expensive thing the server does. Measured on staging on 2026-11-15
(live tail, `scripts/cpu.ts` and `scripts/e2e.ts`):

| Request | CPU |
|---|---|
| `POST /runs`, the real 24.5 s lap (2 937 ticks), 22 requests | min 27, median 46, p90 114, max 181 ms. The first request in a fresh isolate is the slowest |
| `POST /runs`, a 3-minute idle replay (21 600 ticks, 40 characters of text) | 104–222 ms, refused as `unfinished` |
| every other route | 1–4 ms (about 30 ms for the first request in a fresh isolate) |

The account is on **Workers Free**: Cloudflare refused `limits.cpuMs` with "CPU limits are not
supported for the Free plan". Free allows 10 ms of CPU per request. **No request was killed**: 0 out
of about 40 submits between 27 and 222 ms, and none came back with error 1102. So the Free plan does
not enforce its 10 ms per request at this volume. Cloudflare does not document that leniency, and
it could change. If submits start being killed, the game sees `Unavailable`, and a dashboard check of **Metrics → Errors → Exceeded CPU Time Limits** would show it.

The options, if that day comes:

1. **Workers Paid** ($5 a month): 30 s per request by default. Then set `limits: { cpuMs: 2000 }`
   on the API Worker, which bounds what a hostile replay can cost.
2. **Verify inside a Durable Object.** SQLite-backed Durable Objects run on Free, and the Durable
   Objects limits page gives them 30 s of CPU per request. The same page's FAQ says they have the
   same per-invocation CPU limits as other Workers. Because of that contradiction, and because the
   plain Worker is not being killed, it is not built. It would be a `Verifier` object with
   `verify(replay)`, called with a random name per request so nothing queues behind one instance.
3. **A cheaper simulation** (`src/sim`). A lap costs about 12 ms warm in Node and 40–50 ms warm in
   workerd.
4. **A tighter cap on replay length.** A 40-character replay of three idle minutes costs 2 to 5 times
   a real lap. The submit rate limits bound this to about 30 such requests per minute per IP. A
   server-side cap below the game's three minutes would be a game rule, so it is not set.

## Testing

- `pnpm test` runs `test/names.test.ts` (folding, kept-back names, blocklist and innocent words) and
  `test/server.test.ts`. The second serves the real routes and handlers with
  `HttpRouter.toWebHandler` on Node's own SQLite (`node:sqlite`) with the real migrations, and asks
  through `layerHttp` with an in-memory `fetch`. It covers registering, taken, blocked and reserved
  names, submitting the real replay and every fault, best-run-only, ties, top / around / me, rival,
  rename, forged identities, rate limits, `Unavailable` for a broken database, an offline client and
  a garbled response, CORS, and admin.
- `node scripts/e2e.ts http://localhost:1337 --env .env` against `pnpm dev:server`, and
  `node scripts/e2e.ts https://tabletop-grand-prix-api-staging.lass-maglio.workers.dev --env .env.staging`
  against staging. Both pass.

## Alchemy, as found (beta.87)

- The docs' `HttpPlatformStub` for HttpApi on Workers is missing `platform` and `compression`, which
  effect 4.1.4 requires. `HttpApiBuilder.layer` also needs a `FileSystem`, now provided as
  `FileSystem.layerNoop({})`. See `src/server/api.ts`.
- `Cloudflare.Worker(id, props, impl)` does not accept props that need a service, here the
  `Stage` for the Worker's name. The class form `class Api extends Cloudflare.Worker<Api>()(id, props, impl) {}` does.
- `HttpRouter.cors` only takes a list of origins. The site's origin is only known at runtime, so
  the server uses `HttpRouter.middleware(HttpMiddleware.cors({ allowedOrigins: predicate }), { global: true })`.
- `D1.QueryDatabase`'s executors use `Effect.promise`, so a D1 error becomes a defect. `src/server/d1.ts`
  wraps the raw binding with typed errors and adds `batch`.
- `alchemy profile refresh --profile admin` hung with no output before `alchemy.run.ts` existed.
  The first real command (`alchemy dev`) refreshed the token instead.
- `Website.Vite` under `alchemy dev` quietly moves to 5381 when 5380 is taken. CORS in dev allows
  any localhost port for that reason.
- `alchemy logs --tail` showed 22 of 30 requests under load: tails are sampled.
- Docs and source agree on the rest (D1 `migrations`, `RateLimit` periods of 10 or 60 s,
  `Worker.URL`, `--env-file`, stages).
