import { defineConfig } from "vite"
import { lockupMarkup } from "./src/host/brand/lockup.ts"

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  plugins: [
    {
      // The loading screen is plain markup in `index.html`, on screen before any script runs;
      // its Typeonce lockup is drawn from the same pixel art as the rest of the page.
      name: "loading-lockup",
      transformIndexHtml: (html) => html.replace("<!--typeonce-lockup-->", lockupMarkup(64))
    }
  ]
})
