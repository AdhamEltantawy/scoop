# Scoop

A personal web app for exploring your city on foot. The world is split into
[H3](https://h3geo.org) hexagons, and every hexagon you walk through gets
filled in, so you can see which parts of your neighbourhood you haven't
explored yet.

## Features

- **Walk tracking**: tap *Start walk* and the app follows your GPS, filling in
  each hexagon you pass through. Gaps between GPS fixes are filled along the
  hex grid, and inaccurate fixes are skipped.
- **Walking only**: the app pauses marking when you go faster than
  walking speed (9 km/h, or 16 km/h if you allow running). It uses the speed
  your GPS reports, or your average speed over the last 20 s.
  - It pauses after 3 fast readings in a row, so one GPS glitch doesn't count.
  - Hexes are held for 30 s before they're saved. When a car pulls away, the
    hexes from just before it sped up get dropped.
  - It resumes only after a full minute at walking speed, so red lights and
    traffic jams don't count. That minute is then credited to your walk.
- **Three hex sizes**: district (~0.7 km²), block (~0.1 km²) and street
  (~0.015 km²). Cells are stored at the street size, so you can switch sizes
  without losing detail.
- **Exploration stats**: hexes visited, area covered, the share of the current
  view you've explored, plus distance and new hexes for the current walk.
- **Unexplored grid**: an outline of the hexes you haven't visited yet.
- **GPX import**: bring in past walks exported from Strava, Komoot, Garmin and
  similar apps. Imported tracks get the same walking-only check, so the file
  needs timestamps.
- **Backup / restore** as JSON. All data stays on your device unless you share it.
- **Installable and offline**: add it to your home screen and it opens like an app.
- **Share cards**: turn the part of the map you're looking at, plus your totals,
  into an image for the share sheet.
- **Privacy zones**: up to 3 circles (around home or work, say). Hexes inside
  them are left out of share cards and Scoop files.

## Community

Scoop is social without accounts or servers: you and your friends swap
**Scoop files** through WhatsApp, email or any app in the share sheet
(*Community → Friends → Share my Scoop file*, then *Add a friend's Scoop
file…* on the other phone). Everything below is worked out on your phone from
the files you have, so it works offline. Send a new file whenever you want
friends to see your latest walks.

- **Compare**: overlay a friend's hexes on your map, with a count of hexes you
  share, hexes only you have and hexes only they have.
- **Feed**: your and your friends' walks and check-ins from the last 60 days.
- **Check-ins and hex scores**: check in at a hex you've walked through with a
  photo (+3), coffee (+2), food (+2), or a meetup (+5, once a friend's file shows
  them checking in at the same hex within 30 minutes). Hexes also score for
  repeat visits: +1 at 2 visits, +2 at 4, +3 at 8, and so on (all-time only).
- **Leaderboard**: you and your friends, this week or all time, by score, new
  hexes or distance.
- **Challenges**: race friends over 1–30 days, optionally counting only the
  hexes in one part of town. Invites travel inside your Scoop file.
- **Community map**: blocks explored by you and your friends, and who got
  there first.
- **Badges and streaks**: 12 badges, plus your current and best daily walking streak.

A Scoop file holds your name, hex ids with the day you first visited each and
how often, walk totals (start, end, km, new hexes), check-ins (not photos) and
challenges. **It never holds GPS tracks**, and leaves out anything inside your
privacy zones. Your check-ins, name and challenges are part of *Export backup*;
friends' files and photos are not. See [privacy.html](privacy.html).

## Tests

```sh
npm test   # unit tests for the community logic (node --test)
```

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

**On your phone (Android or iPhone):** open
<https://adhameltantawy.github.io/scoop/> and use *Add to Home Screen*. Every push
redeploys it via `.github/workflows/pages.yml`. One-time setup: *Settings → Pages
→ Source: GitHub Actions*.

On iPhone, keep the app open with the screen on while walking: iOS stops giving
location to web apps once the screen locks.

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
| `social.js` | Community features, share cards, privacy zones |
| `social-core.js`, `tests/` | Scoop files, scores, badges and streaks, with unit tests |
| `privacy.html` | Privacy notice |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install / offline support |
| `vendor/` | Leaflet 1.9.4, h3-js 4.1.0, Capacitor core runtime (with licenses) |
| `android/`, `capacitor.config.json`, `scripts/build-web.mjs` | Android app (Capacitor) |
| `assets/` | Source images for the Android icon and splash screen |

Map tiles © OpenStreetMap contributors (or © Esri, depending on the map style you pick).
