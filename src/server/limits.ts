/**
 * How often a request may come from one place, and from one player. Cloudflare's rate limit
 * binding counts per period of 10 or 60 seconds, per Cloudflare location, roughly: it stops a
 * flood, not a careful person. Each line is one binding on the Worker (`worker.ts`).
 */
import type { Effect } from "effect"

export type Action = "checkName" | "register" | "rename" | "submit"
export type Scope = "ip" | "player"

export interface Limit {
  readonly limit: number
  readonly period: 10 | 60
}

export const limits: Record<Action, { readonly ip: Limit; readonly player?: Limit }> = {
  // The game asks while the player types, after a pause.
  checkName: { ip: { limit: 20, period: 10 } },
  // A household or a classroom shares one address.
  register: { ip: { limit: 10, period: 60 } },
  rename: { ip: { limit: 10, period: 60 }, player: { limit: 3, period: 60 } },
  // A lap takes over twenty seconds, so a player sends at most a few a minute.
  submit: { ip: { limit: 30, period: 60 }, player: { limit: 6, period: 60 } }
}

/** Counts one request against a limit: true when it is still within it. */
export type Limiter<R = never> = (action: Action, scope: Scope, key: string) => Effect.Effect<boolean, never, R>
