/**
 * The end of the loading screen. The screen itself is plain markup in `index.html`, so it is
 * up from the page's first paint, while the script is still on its way: the Typeonce lockup
 * floating on the dark cover of the lap-end wipe. Once the game has drawn, the cover leaves
 * to the left and is taken out of the page.
 */

/** The game is on screen: let the loading screen go. Safe to call more than once. */
export const finishLoading = (host: Document): void => {
  const loading = host.getElementById("tgp-loading")
  if (loading === null || loading.classList.contains("tgp-loading-out")) return
  loading.classList.add("tgp-loading-out")
  // After its way out (the transition in `index.html`, with a margin).
  setTimeout(() => loading.remove(), 700)
}
