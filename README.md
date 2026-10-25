# Scoop

A personal web app for exploring your city on foot. The world is split into
[H3](https://h3geo.org) hexagons, and every hexagon you walk through gets
filled in, so you can see which parts of your neighbourhood you haven't
explored yet.

## Features

- **Walk tracking**: tap *Start walk* and the app follows your GPS, filling in
  each hexagon you pass through. Gaps between GPS fixes are filled along the
  hex grid, and fixes that are too inaccurate or too fast (bus, bike, train)
  are skipped.
- **Manual marking**: tap the pencil, then tap hexes to mark or unmark places
  you've already been.
- **Three hex sizes**: district (~0.7 km²), block (~0.1 km²) and street
  (~0.015 km²). Cells are stored at the street size, so you can switch sizes
  without losing detail.
- **Exploration stats**: hexes visited, area covered, the share of the current
  view you've explored, plus distance and new hexes for the current walk.
- **Unexplored grid**: an outline of the hexes you haven't visited yet.
- **GPX import**: bring in past walks exported from Strava, Komoot, Garmin and similar apps.
- **Backup / restore** as JSON. All data stays on your device (`localStorage`).
- **Installable and offline**: add it to your home screen and it opens like an app.

## Running it

It's a static site with no build step. Leaflet and h3-js are included in
`vendor/`.

**Locally:**

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

**On your phone:** browsers only allow GPS on HTTPS, so host it somewhere. The
easiest option is GitHub Pages: *Settings → Pages → Deploy from a branch*, pick
the branch and `/ (root)`. Open the URL on your phone, then use *Add to Home
Screen*.

## Tips

- Keep the app open with the screen on while walking. Mobile browsers pause
  location in background tabs. The app asks the phone to keep the screen awake
  while a walk is running.
- Export a backup now and then. Clearing your browser data erases your map.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | UI |
| `app.js` | Map, H3 logic, GPS tracking, storage |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install / offline support |
| `vendor/` | Leaflet 1.9.4 and h3-js 4.1.0 (with licenses) |

Map tiles © OpenStreetMap contributors, © CARTO.
