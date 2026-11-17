# Developing Tabletop Grand Prix

Made with [ritmo](https://ritmo.typeonce.dev) and PixiJS 3D, on WebGPU where the browser has it and WebGL elsewhere (`?renderer=webgl` asks for WebGL).

```sh
pnpm install
pnpm dev      # http://localhost:5380
pnpm check
```

The design is in [docs/design.md](docs/design.md); the leaderboard's server (Cloudflare, set up with Alchemy) is in [docs/server.md](docs/server.md).

- `pnpm dev` runs the page alone, with no leaderboard. Add `?server=fake` to the address for a stand-in board with made-up drivers.
- `pnpm dev:server` runs the page with a local server and database.
- `pnpm deploy:staging --yes` and `pnpm deploy:prod --yes` deploy the site and the server.
- `node scripts/online-real.ts <site url>` plays a first visit on a deployed site (drive a lap, pick a name, post it, read the board); use it on staging.
- `node scripts/lap-end.ts` drives a lap on the dev server and checks what follows the finish (the wipe, the replay, the board, `R`), with pictures in `output/`.
- `pnpm verify:engines` checks that a replay gives the same lap in Chromium, Firefox, WebKit and Node.
- `node scripts/trailer.ts` films the trailer (`--stills` films the same race as clean pictures), and `node scripts/cards.ts` draws the link card, the icon and the release pictures from a still.
