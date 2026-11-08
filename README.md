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
- **No accidental hexes**: a walk starts recording hexes once you've walked
  100 m along your route from where you switched it on. Then the hexes from
  that stretch, starting hex included, are credited, and so is the distance.
  A GPS fix only unlocks a hex when it's in the inner 90% of the hex's area,
  so wobble along a street doesn't unlock the hex next door.
- **Street hexes** (~0.015 km²) everywhere.
- **Fading heat**: explored hexes stay explored, but cool down when you stay
  away. Heat halves every 30 days since your last walk through a hex, shown
  from ember red (just walked) to warm grey (100+ days). Walking through again warms
  it back up.
- **Score**: each hex is worth 1 point, plus +1 at 2 visits, +2 at 4, +3 at 8
  and so on, times its heat. A walk earns the points its hexes had cooled off.
- **Exploration stats**: hexes, points and area explored, plus a warmth bar
  showing how much of your map you've walked recently. While walking, the card
  shows the walk's state: waiting for GPS, warming up (the first 100 m),
  recording (new hexes and distance) or paused (moving too fast).
- **Walk reminders** (Android app, opt-in): forgot to tap *Start walk*? The
  phone's activity detection (motion, not GPS) notices you walking, and after
  3 minutes with no walk running Scoop offers one in a notification. Tap it and
  the walk starts. At most one every 3 hours, none 22:00–07:00, within 30 min of
  a walk you just stopped, or while a walk is recording.
- **"Looks like you're walking"** (web and app): with the map open and no walk
  running, a minute of walking pace (60 m or more) shows a banner offering to
  start one, and that minute counts toward the walk. *Not now* snoozes it for
  30 min, and it stays quiet for 30 min after a walk ends.
- **Walk summary**: distance, points, new hexes, hexes warmed back up, time
  and any badge you just earned.
- **Trends**: new hexes, points or distance per day, week or month. Private:
  worked out on your device.
- **Unexplored grid**: an outline of the hexes you haven't visited yet.
- **GPX import**: bring in past walks exported from Strava, Komoot, Garmin and
  similar apps. Imported tracks get the same walking-only check, so the file
  needs timestamps.
- **Backup / restore** as JSON. Your map lives on your device (`localStorage`).
  If you sign in, it also comes back from your account after a reinstall or on
  a new phone: your hexes, visit counts and walks are merged in, nothing lost.
  It stays in step across devices too: walk with the phone app and the map in
  your browser picks it up when you open it, switch back to the tab, or every
  couple of minutes while it's open (only what changed is downloaded).
- **Installable and offline**: add it to your home screen and it opens like an app.
- **Share cards**: turn the part of the map you're looking at, plus your totals,
  into an image for the share sheet. No account needed.
- **Privacy zones**: up to 3 circles (around home or work, say). Hexes inside them
  are never uploaded and never appear on share cards. Zones stay on your device.

## Look and feel

Everything happens over the map. Start or stop a walk at the bottom, open
**Me** (score, streaks, trends, badges, areas; the gear opens Settings) on the
left and **Friends** (Feed, Friends, Ranks, Challenges) on the right. Check in,
Leave a landmark and Locate sit on the right edge. Destructive actions (clearing your map,
removing a friend, deleting a challenge or your account) ask in a centred
dialog. Colour roles: green is for walking now and actions, ember for heat
only, blue for friends only. The app follows the system light or dark mode.

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
  API, cached on the device, never drawn on the map). Where OSM has no
  districts, Scoop's own outlines in `districts.geojson` are used instead
  (Greater Cairo and Giza so far). Hexes in those upload straight away, and the
  server fills in their country and city (Egypt, and Cairo or Giza
  governorate, fixed in the database; uploads can't change them). Elsewhere a hex waits for its OSM
  lookup, for up to 3 days. Your home district, city and country are
  where you score the most.
- **Leaderboards**: your friends, everyone in your district, city or
  country, or everyone anywhere, by current score or points earned this week
  or month. Outside the friends board only you and your friends are named;
  everyone else shows up as an anonymous Explorer.
- **Challenges**: race invited friends over 1–30 days, wherever they live. Each
  of you is ranked in your own district by the points you earn there, and the
  best percentile wins (6th of 500 beats 3rd of 4).
- **Landmarks**: leave a note on a hex you've walked (a viewpoint, a bit of
  history, street art, nature, food, a hidden gem) with a title and an
  optional note, using the flag button on the right edge. When another explorer
  passes through that hex, walking or just with the map open, Scoop tells them
  with a banner (and, in the Android app with the screen off during a walk, a
  notification). *Check it* opens the landmark and checks it off, then asks
  *Worth the stop?* 👍 or 👎. On the map, landmarks you haven't found yet show
  as **?**. You see how many explorers found each of yours, and their votes.
  Points (they fade like check-ins): leave one +3, find one +2, and +1 to the
  author each time theirs is found or gets a 👍. Removing a landmark takes back
  what it earned its author. One with 3 or more 👎 and at least twice as many
  👎 as 👍 is hidden from everyone but its author. Everyone signed in can find landmarks, but only you and
  your friends see who left one. Up to 25 out at once, one per hex; none
  inside privacy zones. You're told about a landmark once every 12 hours at
  most, and only once you're well inside its hex.
- **Community map**: street hexes explored by you and your friends, plus who
  got there first.
- **Badges and streaks**: 12 badges, plus your current and best daily walking streak.

What gets uploaded: hex ids with their first and last visit times, visit
counts and areas, and walk totals (start, end, km, new hexes). Visit times are
only used for scoring and for restoring your own map on your devices; nobody
else can read them. **GPS tracks are never uploaded.** See [privacy.html](privacy.html).
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
   email includes the code the app asks for (6 to 10 digits, whatever the
   project's Email OTP length is). Email sign-in is enabled
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

Both run on every pull request (`.github/workflows/test.yml`), and before every
APK release and web deploy.

## Android app

Releases are made on purpose: pushing a tag such as `v1.2.0` runs the tests,
then builds a signed APK with GitHub Actions (`.github/workflows/android.yml`)
and publishes it as a GitHub Release, with its SHA-256 in the notes. Running
the workflow by hand builds an APK as a workflow artifact without publishing it.

```sh
git tag v1.2.0 && git push origin v1.2.0
```

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

**Signing:** release builds need a private key; there is no key in the repo
and no fallback, so `assembleRelease` fails without one. Debug builds
(`./gradlew assembleDebug`) use the standard Android debug key.

1. Create a key once, on your own machine, and keep the file and password in
   a password manager:
   `keytool -genkeypair -v -keystore scoop-release.keystore -alias scoop -keyalg RSA -keysize 4096 -validity 10000`
   (use the same password for the key and the store).
2. For GitHub Actions, add the repository secrets `SCOOP_KEYSTORE_BASE64`
   (`base64 -w0 scoop-release.keystore` on Linux, `base64 -i scoop-release.keystore`
   on macOS) and `SCOOP_KEYSTORE_PASSWORD`.
3. For a local release build, set `SCOOP_KEYSTORE` (path to the file) and
   `SCOOP_KEYSTORE_PASSWORD`; `SCOOP_KEY_ALIAS` defaults to `scoop`.

Earlier APKs were signed with a key that was published in this repository, so
that key is retired. Moving from an old APK to one signed with the new key
means uninstalling once: sign in or export a backup first, then install the new
APK and sign in or restore.

## Running it in a browser

It's a static site with no build step. Leaflet, h3-js and supabase-js are
included in `vendor/`.

**Locally:**

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

**On your phone (Android or iPhone):** open
<https://adhameltantawy.github.io/scoop/> and use *Add to Home Screen*. Every push to the
default branch runs the tests and then redeploys it via `.github/workflows/pages.yml`. One-time setup: *Settings → Pages
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
| `index.html`, `style.css`, `tokens.css` | UI: the map plus bottom sheets. Colours, type, radii and motion live in `tokens.css` (Ember & Nile, light and dark) |
| `app.js` | Map, H3 logic, GPS tracking, storage |
| `social-core.js` | Pure helpers: heat and scores, edge band, areas, trends (unit tested) |
| `areas.js` | Official country / city / district lookup (OpenStreetMap via Overpass) |
| `districts.geojson` | Scoop's own district outlines where OSM has none; edit on geojson.io, ids `r9` + 11 digits |
| `social.js`, `config.js` | Community features, share cards, privacy zones |
| `supabase/migrations/` | Database schema, row level security, scoring (Supabase) |
| `supabase/tests/`, `scripts/test-db.sh`, `tests/` | Schema and unit tests |
| `privacy.html` | Privacy notice |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install / offline support |
| `vendor/` | Leaflet 1.9.4, h3-js 4.1.0, supabase-js 2.117.2, Capacitor core runtime (with licenses) |
| `android/`, `capacitor.config.json`, `scripts/build-web.mjs` | Android app (Capacitor) |
| `assets/` | Source images for the Android icon and splash screen |
| `docs/production-plan.md` | What has to change before a public launch, in order |

Map tiles © OpenStreetMap contributors (or © Esri, depending on the map style you pick).
