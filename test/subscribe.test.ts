/** The email sign-up's sending: only from the site's own pages, and off them a stand-in answer with nothing sent. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { endpoint, fakeOutcome, onSite, subscribe } from "../src/host/subscribe.ts"

test("only typeonce.games and its subdomains reach the endpoint", () => {
  assert.equal(onSite("typeonce.games"), true)
  assert.equal(onSite("tabletop-grand-prix.typeonce.games"), true)
  assert.equal(onSite("localhost"), false)
  assert.equal(onSite("127.0.0.1"), false)
  assert.equal(onSite("tabletop-grand-prix-staging.example.workers.dev"), false)
  assert.equal(onSite("typeonce.games.example.com"), false)
  assert.equal(onSite("nottypeonce.games"), false)
})

test("the stand-in answer tries every message", () => {
  assert.equal(fakeOutcome("player@example.com"), "ok")
  assert.equal(fakeOutcome("player.example.com"), "invalid_email")
  assert.equal(fakeOutcome(""), "invalid_email")
  assert.equal(fakeOutcome("limit@example.com"), "rate_limited")
  assert.equal(fakeOutcome("down@example.com"), "unavailable")
})

/** Runs `use` with `fetch` replaced by one that records what it was asked, and answers `answer`. */
const withFetch = async <A>(answer: Response | Error, use: (sent: Array<{ url: string; init: RequestInit | undefined }>) => Promise<A>): Promise<A> => {
  const original = globalThis.fetch
  const sent: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init })
    if (answer instanceof Error) throw answer
    return answer
  }) as typeof fetch
  try {
    return await use(sent)
  } finally {
    globalThis.fetch = original
  }
}

test("off the site nothing is sent", async () => {
  await withFetch(new Error("must not be called"), async (sent) => {
    assert.equal(await subscribe("player@example.com", { hostname: "localhost", href: "http://localhost:5380/" }, 0), "ok")
    assert.equal(await subscribe("down@example.com", { hostname: "localhost", href: "http://localhost:5380/" }, 0), "unavailable")
    assert.equal(sent.length, 0)
  })
})

test("on the site the address goes to the endpoint with the game, the page and an empty trap", async () => {
  const page = { hostname: "tabletop-grand-prix.typeonce.games", href: "https://tabletop-grand-prix.typeonce.games/?ref=x" }
  await withFetch(Response.json({ ok: true }), async (sent) => {
    assert.equal(await subscribe("player@example.com", page), "ok")
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.url, endpoint)
    assert.equal(sent[0]?.init?.method, "POST")
    assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), { email: "player@example.com", game: "tabletop-grand-prix", referrer: page.href, website: "" })
  })
  await withFetch(Response.json({ ok: false, error: "rate_limited" }, { status: 429 }), async () => assert.equal(await subscribe("a@b.co", page), "rate_limited"))
  await withFetch(Response.json({ ok: false, error: "invalid_request" }, { status: 400 }), async () => assert.equal(await subscribe("a@b.co", page), "unavailable"))
  await withFetch(new Response("Forbidden", { status: 403 }), async () => assert.equal(await subscribe("a@b.co", page), "unavailable"))
  await withFetch(new TypeError("offline"), async () => assert.equal(await subscribe("a@b.co", page), "unavailable"))
})
