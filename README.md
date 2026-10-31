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
- **No accidental hexes**: a walk starts recording hexes once you're 100 m
  from where you switched it on (that distance still counts), and a GPS fix
  only unlocks a hex when it's in the inner 90% of the hex's area, so wobble
  along a street doesn't unlock the hex next door.
- **Street hexes** (~0.015 km²) everywhere.
- **Fading heat**: explored hexes stay explored, but cool down when you stay
  away. Heat halves every 30 days since your last walk through a hex, shown
  from orange (just walked) to grey (months ago). Walking through again warms
  it back up.
- **Score**: each hex is worth 1 point, plus +1 at 2 visits, +2 at 4, +3 at 8
  and so on, times its heat. A walk earns the points its hexes had cooled off.
- **Exploration stats**: hexes visited, score, area covered, the share of the
  current view you've explored, plus distance and new hexes for the current walk.
- **Trends**: new hexes, points or distance per day, week or month. Private:
  worked out on your device.
- **Unexplored grid**: an outline of the hexes you haven't visited yet.
- **GPX import**: bring in past walks exported from Strava, Komoot, Garmin and
  similar apps. Imported tracks get the same walking-only check, so the file
  needs timestamps.
- **Backup / restore** as JSON. Your map lives on your device (`localStorage`).
- **Installable and offline**: add it to your home screen and it opens like an app.
- **Share cards**: turn the part of the map you're looking at, plus your totals,
  into an image for the share sheet. No account needed.
- **Privacy zones**: up to 3 circles (around home or work, say). Hexes inside them
  are never uploaded and never appear on share cards. Zones stay on your device.

## Community (optional)

Sign in with an emailed code to make Scoop social:

- **Friends**: add each other with an invite code or link. Friends see each
  other's maps (not the dates), walks, check-ins, scores and home district.
  Friendships last a month: in its last week you both tap *Renew*, and it only
  renews once you both have. A lapsed friendship can be renewed for 30 days.
- **Compare**: overlay a friend's hexes on your map, with a count of hexes you
  share, hexes only you have and hexes only they have.
- **Feed and kudos**: friends' walks, check-ins and badges, with emoji kudos.
- **Check-ins**: check in at a hex you've walked through with a photo (+3),
  coffee (+2), food (+2), or a meetup (+5, but only once a friend checks in at
  the same hex within 30 minutes). Check-in points fade like hexes do.
- **Official areas**: every hex is tagged with its country, city and district
  from OpenStreetMap's administrative boundaries (looked up via the Overpass
  API, cached on the device, never drawn on the map). Your home district, city
  and country are where you score the most.
- **Leaderboards**: your friends, or everyone in your district, city or
  country, by current score or points earned this week or month. On area
  boards only you and your friends are named; everyone else is anonymous.
- **Challenges**: race invited friends over 1–30 days, wherever they live. Each
  of you is ranked in your own district by the points you earn there, and the
  best percentile wins (6th of 500 beats 3rd of 4).
- **Community map**: street hexes explored by you and your friends, plus who
  got there first.
- **Badges and streaks**: 12 badges, plus your current and best daily walking streak.

What gets uploaded: hex ids with their first and last visit times, visit
counts and areas, and walk totals (start, end, km, new hexes). Visit times are
only used for scoring; nobody, including you, can read them back. **GPS tracks are never uploaded.** See [privacy.html](privacy.html).
Without an account, nothing changes and nothing leaves your device.

### Setting up the backend

The community features run on [Supabase](https://supabase.com) (the free tier is
enough). Until `config.js` is filled in, the app runs without them.

1. Create a Supabase project.
2. Apply the schema. Either run `supabase db push` with the
   [Supabase CLI](https://supabase.com/docs/guides/cli), or paste
   `supabase/migrations/*.sql` into the SQL editor. This creates the tables, row
   level security, the scoring and leaderboard functions, and the private
   `checkin-photos` storage bucket.
3. *Authentication → Emails*: add `{{ .Token }}` to the *Magic Link* and *Confirm signup* templates so the
   email includes the 6-digit code the app asks for. Email sign-in is enabled
   by default.
4. Copy the project URL and the **anon** key from *Project Settings → API* into
   `config.js`. The anon key is public by design, because row level security
   decides what each user can do. Never put the `service_role` key in the app.

## Tests

```sh
npm test          # unit tests for the community helpers (node --test)
npm run test:db   # schema + row level security tests against a local Postgres 16
                  # (set PGURL to a superuser connection, default postgres:///postgres)
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

It's a static site with no build step. Leaflet, h3-js and supabase-js are
included in `vendor/`.

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
| `social-core.js` | Pure helpers: heat and scores, edge band, areas, trends (unit tested) |
| `areas.js` | Official country / city / district lookup (OpenStreetMap via Overpass) |
| `social.js`, `config.js` | Community features, share cards, privacy zones |
| `supabase/migrations/` | Database schema, row level security, scoring (Supabase) |
| `supabase/tests/`, `scripts/test-db.sh`, `tests/` | Schema and unit tests |
| `privacy.html` | Privacy notice |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install / offline support |
| `vendor/` | Leaflet 1.9.4, h3-js 4.1.0, supabase-js 2.117.2, Capacitor core runtime (with licenses) |
| `android/`, `capacitor.config.json`, `scripts/build-web.mjs` | Android app (Capacitor) |
| `assets/` | Source images for the Android icon and splash screen |

Map tiles © OpenStreetMap contributors (or © Esri, depending on the map style you pick).
