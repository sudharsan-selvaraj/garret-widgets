# Garret Widgets

The curated widget registry for **Garret**. The app's in-app marketplace reads
[`index.json`](./index.json) and installs the chosen pack's prebuilt `.garret` over HTTPS — no build
step and no install scripts run on the user's machine.

## How it works

- Pack **sources** live under [`packs/`](./packs) — one folder per pack (`garret.manifest.json` + a
  `ui/` tree).
- CI ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) builds every pack into a
  `.garret` and attaches it to the **`packs`** GitHub Release. Binaries are never committed to source.
- [`index.json`](./index.json) lists each pack and points `url` at its release asset.

## Adding a widget

1. Create `packs/<your-pack>/` with a `garret.manifest.json` (`apiVersion: 2`) and a `ui/` tree.
2. Add an entry to `index.json`:

   ```json
   {
     "id": "publisher.pack",
     "name": "Display Name",
     "publisher": "publisher",
     "description": "One line.",
     "version": "1.0.0",
     "url": "https://github.com/sudharsan-selvaraj/garret-widgets/releases/download/packs/publisher.pack.garret",
     "hasHost": false
   }
   ```

   Set `hasHost: true` if the pack ships a native host (raw Node); Garret shows a host-access warning
   before install.
3. Open a PR. On merge to `main`, CI rebuilds and re-uploads the release asset.

Build locally with `node scripts/build.mjs` (outputs `dist/*.garret`).
