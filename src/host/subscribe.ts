/**
 * Sending an address to the studio's sign-up endpoint (the panel is `signup.ts`). The
 * endpoint sends a confirmation email, and only takes the pages of typeonce.games and its
 * subdomains, so off them (`pnpm dev`, the staging site) the form answers itself and sends
 * nothing (`fakeOutcome`).
 *
 *   POST https://typeonce.games/api/subscribe { email, game, referrer, website: "" }
 *   200 { ok: true } · 400 invalid_email | invalid_request · 429 rate_limited · 502 unavailable
 */

/** The studio's sign-up endpoint. */
export const endpoint = "https://typeonce.games/api/subscribe"
/** The tag the address gets: the game it came from. */
export const game = "tabletop-grand-prix"

export type Outcome = "ok" | "invalid_email" | "rate_limited" | "unavailable"

/** What the panel says for each outcome, in the capitals of the game's panels. */
export const messages: Record<Outcome, string> = {
  ok: "CHECK YOUR INBOX TO CONFIRM.",
  invalid_email: "THAT ADDRESS DOES NOT LOOK RIGHT.",
  rate_limited: "TOO MANY TRIES. WAIT A MINUTE AND TRY AGAIN.",
  unavailable: "THAT DID NOT GO THROUGH. TRY AGAIN."
}

const isOutcome = (value: unknown): value is Outcome => typeof value === "string" && value in messages

/** Whether the endpoint takes sign-ups from a page on `hostname`. */
export const onSite = (hostname: string): boolean => hostname === "typeonce.games" || hostname.endsWith(".typeonce.games")

/**
 * The answer a page off the site gives itself, to try every message: an address without `@`
 * is wrong, one starting `limit@` is rate limited, one starting `down@` does not go through,
 * any other succeeds.
 */
export const fakeOutcome = (email: string): Outcome =>
  !email.includes("@") ? "invalid_email" : email.startsWith("limit@") ? "rate_limited" : email.startsWith("down@") ? "unavailable" : "ok"

/** The page the sign-up comes from. */
export interface Page {
  readonly hostname: string
  readonly href: string
}

/** Sends `email` from `page`, or off the site answers after a moment without sending anything. Never fails. */
export const subscribe = async (email: string, page: Page, fakeDelayMs: number = 600): Promise<Outcome> => {
  if (!onSite(page.hostname)) {
    await new Promise((resolve) => setTimeout(resolve, fakeDelayMs))
    return fakeOutcome(email)
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `website` is the endpoint's trap for bots: a person never fills it.
      body: JSON.stringify({ email, game, referrer: page.href, website: "" })
    })
    if (response.ok) return "ok"
    const { error } = (await response.json()) as { readonly error?: unknown }
    return isOutcome(error) ? error : "unavailable"
  } catch {
    return "unavailable"
  }
}
