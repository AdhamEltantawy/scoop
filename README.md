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

## Android app

Every push builds an installable APK with GitHub Actions
(`.github/workflows/android.yml`) and publishes it as a GitHub Release.

**To install:** on your phone, open the repo's **Releases** page, download
`scoop.apk` from the latest release and open it. The first time, Android asks
you to allow installs from your browser. Newer APKs install over the old one
and keep your data.

The Android app keeps recording a walk with the screen off. It shows a
notification while a walk is running. When asked, allow location access
(*While using the app* is enough) and notifications.

It's the same web app wrapped with [Capacitor](https://capacitorjs.com), plus:
- background GPS via `@capacitor-community/background-geolocation`
- backups exported through Android's share sheet
- the back button minimizes the app instead of quitting it, so walks keep going

**Building locally** (needs Node 22, JDK 21 and the Android SDK):

```sh
npm ci
npm run android:sync          # copies the web app into android/
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

or run `npm run android:open` to work in Android Studio.

**Signing:** builds are signed with `android/app/scoop.keystore`, which is
checked into the repo so every build can upgrade the previous one. That's fine
for a personal sideloaded app. To use a private key instead, add the
`SCOOP_KEYSTORE_BASE64` and `SCOOP_KEYSTORE_PASSWORD` repository secrets (the
key alias must be `scoop`). Switching keys means uninstalling once, so export a
backup first.

## Running it in a browser

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
| `vendor/` | Leaflet 1.9.4, h3-js 4.1.0, Capacitor core runtime (with licenses) |
| `android/`, `capacitor.config.json`, `scripts/build-web.mjs` | Android app (Capacitor) |
| `assets/` | Source images for the Android icon and splash screen |

Map tiles © OpenStreetMap contributors, © CARTO.
