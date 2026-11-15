/**
 * What differs between stages: Worker names (so the API can work out the site's origin from
 * its own URL), and the rate limit namespaces (so staging and prod never share a budget).
 */

/** A stage as it may appear in a hostname. */
const dnsSafe = (stage: string): string => stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")

export const apiWorkerName = (stage: string): string => `tabletop-grand-prix-api-${dnsSafe(stage)}`
export const siteWorkerName = (stage: string): string => `tabletop-grand-prix-${dnsSafe(stage)}`

/** Where players find the game. Only production claims it; every other stage stays on workers.dev. */
export const productionDomain = "tabletop-grand-prix.typeonce.games"

/** The site's own domain in a stage that has one, as an origin the API allows; null elsewhere. */
export const domainOriginFor = (stage: string): string | null => (stage === "prod" ? `https://${productionDomain}` : null)

/** Origins a page may call the API from in every stage: `pnpm dev` and `pnpm dev:server`. */
export const localOrigins: ReadonlyArray<string> = ["http://localhost:5380", "http://127.0.0.1:5380"]

/**
 * The site's origin, from the API's own URL: both are `<name>.<account>.workers.dev`, so the
 * site's is the API's with the Worker name swapped. Null when the API is not served there
 * (local dev). The site's own domain, where a stage has one, is `domainOriginFor`.
 */
export const siteOriginFor = (apiUrl: string, stage: string): string | null => {
  try {
    const url = new URL(apiUrl)
    const [first, ...rest] = url.hostname.split(".")
    if (first !== apiWorkerName(stage) || rest.at(-1) !== "dev" || rest.at(-2) !== "workers") return null
    return `${url.protocol}//${[siteWorkerName(stage), ...rest].join(".")}`
  } catch {
    return null
  }
}

/** The first rate limit namespace of a stage. Cloudflare's namespace ids are account-wide. */
export const rateLimitBase = (stage: string): number => (stage === "prod" ? 7100 : stage === "staging" ? 7200 : 7300)

/** A page on this machine, on any port: allowed only while the API itself runs on this machine (`alchemy dev`). */
export const isLocalOrigin = (origin: string): boolean => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
