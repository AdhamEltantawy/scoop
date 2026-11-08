# Production plan

_Proposed 7 November 2026, from a review of commit `6702b06`._

Scoop works well as a personal app for you and a few friends. This plan lists
what has to change before it's offered to the public, in the order to do it.
It comes from a review of the whole codebase (web app, Android app and
database), both test suites, a load test of the schema on a local Postgres, and
a read-only look at the live Supabase project's settings.

Each task says why it matters, what to do and how to tell it's done. Sizes are
rough: **S** is under a day, **M** two to four days, **L** one to two weeks.
Tasks marked **(you)** need the project owner (accounts, money, secrets); the
rest are code. This repository is public, so security issues are described only
as far as fixing them needs.

## Summary

| # | Workstream | Priority | Phase |
| --- | --- | --- | --- |
| 1 | Release signing | Critical | 0 |
| 2 | Area data owned by the server | High | 0–1 |
| 3 | Backend settings: backups, email, CAPTCHA | High | 0 |
| 4 | Tests in CI, releases on purpose | High | 0 |
| 5 | Score integrity: upload limits, landmarks | High | 1 |
| 6 | Privacy zones on every device | High | 1 |
| 7 | Moderation | Medium (High if landmarks stay public) | 1 |
| 8 | Leaderboards and the feed at scale | High | 2 |
| 9 | Migrations, staging, restore drill | Medium | 3 |
| 10 | Device storage and walk recovery | Medium | 3 |
| 11 | Map tiles and area lookups | Medium | 3 |
| 12 | Monitoring | Medium | 3 |
| 13 | Privacy notice, terms, fonts | Medium | 4 |
| 14 | Polish: Android, web, Google Play | Low | 4 |

Already solid, and worth keeping that way: user content is always rendered as
text (no HTML injection), every table has row level security with column-level
grants (friends can't read your visit dates), GPS tracks never leave the
device, photos are re-encoded without their location, account deletion works,
syncing merges without losing data, and both test suites pass.

## Decisions to make first (you)

1. **Where the Android app is distributed.** GitHub Releases (sideloading, as
   now) or Google Play. Play adds requirements (14.4) but manages the signing
   key and updates.
2. **Public leaderboards at launch, or friends only.** Workstream 5 limits
   cheating but can't prevent it: GPS can be faked. Launching with the Friends
   board only, and turning on the area and Everyone boards once 5 and 8 are
   done, is the low-risk option.
3. **Budget.** Supabase Pro (backups, no pausing: about $25 a month), a map
   tile provider and a transactional email provider. All have free or cheap
   tiers to start with.
4. **Launch area.** Starting with Greater Cairo and Giza keeps area handling
   small: Scoop's own districts cover them.
5. **Privacy zones in the account.** Protecting zones on every device (6.2)
   means storing them in your account, readable only by you. That changes a
   promise in the privacy notice ("Zones stay on your device").

## Phase 0: this week

### 1. Release signing (critical)

**Why.** The release key and its password are in this public repository, and
the published APKs are signed with it. Anyone can build an APK that Android
installs as an update over Scoop, keeping its permissions (location included),
its data and the signed-in session.

**1.1 A private key (you, S).**
- Generate a keystore on your own machine:
  `keytool -genkeypair -v -keystore scoop-release.keystore -alias scoop -keyalg RSA -keysize 4096 -validity 10000`.
  Keep the alias `scoop` and use one password for key and store (the workflow
  assumes both). Keep the file and password in a password manager.
- Add the `SCOOP_KEYSTORE_BASE64` (`base64 -w0 scoop-release.keystore` on
  Linux, `base64 -i scoop-release.keystore` on macOS) and
  `SCOOP_KEYSTORE_PASSWORD` repository secrets. The workflow already reads them.
- Treat the old key as burned: it stays in git history.

**1.2 No fallback to the public key (code, S).**
- `android/app/build.gradle`: release builds fail when no private key is
  configured. Debug builds use the standard debug key.
- `.github/workflows/android.yml`: fail when the secrets are missing instead of
  using the key in the repo.
- Delete `android/app/scoop.keystore` and update the README's *Signing* section.

**1.3 Moving people over (you + code, S).**
- Switching keys means one uninstall and reinstall. Signed-in users get their
  map back from their account; everyone else should export a backup first.
- Before switching, ship one last update with the old key that says what's
  coming, with buttons to sign in or export a backup.
- Android's key rotation (APK Signature Scheme v3) can carry installs over
  without a reinstall, but it's made for retiring a key, not a leaked one. A
  clean break is simpler to reason about.
- Put each APK's SHA-256 in its release notes.

**Done when** the latest release is signed with the new key and a release
build without the secrets fails.

### 2. Area data owned by the server (high)

**Why.** Two kinds of area data come from phones and are first-write-wins for
everyone: the country and city of Scoop's own districts (`learn_area_parents`
in `supabase/migrations/20261105000000_area_parents.sql`) and the names of
OpenStreetMap areas (the `areas` insert in `sync_cells`). One wrong upload,
deliberate or not, sets them for every user, for good.

**2.1 Fixed parents for own districts (code, S).**
- Look up the OpenStreetMap relation ids of Egypt and of the Cairo and Giza
  governorates.
- New migration: set `area_parents` for all 22 own districts from
  `own_district_regions` (country Egypt, city Cairo or Giza) with
  `borrowed = false`, then run `apply_area_parents()` on all of them to re-tag
  hexes and move points.
- Replace `sync_cells` with a version that no longer calls
  `learn_area_parents`, and drop that function.
- Test in `supabase/tests/social_test.sql`: an upload claiming another country
  or city for an own district changes nothing.

**2.2 Check production (you, S).** In the SQL editor, look through
`select * from public.area_parents order by district;` and
`select id, kind, name from public.areas order by kind, name;` for anything
odd, and correct it in the 2.1 migration.

**2.3 Names checked by the server (code, M, phase 1).**
- `sync_cells` stops writing names. Unknown ids are stored as pending (for
  example `areas.verified = false`, no name yet).
- A scheduled Edge Function (run by `pg_cron` and `pg_net`) fetches each
  pending relation's tags from OpenStreetMap (Overpass `rel(<id>); out tags;`),
  checks it's an administrative boundary and fills in its name and level.
- The app keeps showing the name it looked up itself until the server has one.

**Done when** nothing a phone uploads can change another user's area tags or
any area's name.

### 3. Backend settings (you, S)

**Why.** The project has no backups, sign-in codes are sent from a personal
Gmail account with a small hourly allowance, and there's no CAPTCHA, so anyone
can use up the allowance by requesting codes for random addresses and keep
real people from signing in.

- **Backups.** Move to Supabase Pro (daily backups, and no pausing after a
  week without activity). If that has to wait, take a nightly `pg_dump` to
  somewhere private. Not a GitHub Actions artifact: this repository is public.
- **Email.** A transactional provider (Postmark, Resend, Amazon SES, Brevo…)
  with a domain you own, SPF, DKIM and DMARC set up, and a project address as
  sender and contact. Then raise the hourly email limit under *Authentication →
  Rate Limits* to what launch needs.
- **CAPTCHA.** Ship the app change first: Cloudflare Turnstile or hCaptcha in
  the sign-in sheet, passing `options.captchaToken` to `signInWithOtp` on the
  first send and on *Resend code*. Then turn CAPTCHA on in Supabase Auth
  (*Attack Protection*). Older APKs can't start a new sign-in after that;
  existing sessions keep working.
- **Site URL.** Set *Authentication → URL Configuration → Site URL* to the
  public web address (it's still the default).

**Done when** a backup exists, codes come from the project's domain, and
requesting a code without a CAPTCHA token fails.

### 4. Tests in CI, releases on purpose (code, S)

**Why.** Neither workflow runs the tests, and every push to the default branch
publishes an APK to everyone and redeploys the web app.

- A new `.github/workflows/test.yml`, reusable (`workflow_call`) and run on
  pull requests: `npm test`, `npm run test:db` against a `postgres:16` service
  container, and `node --check` on every script.
- `android.yml` and `pages.yml` call it first (`needs: test`).
- Publish releases from `v*` tags or a manual run, not every push. Only the
  release job gets `contents: write`.
- Pin third-party actions to commit SHAs.

**Done when** a failing test stops both the APK release and the web deploy.

## Phase 1: integrity and privacy

### 5. Score integrity (high)

**Why.** Every score input is the app's word: which hexes, how many visits and
when, where check-ins and landmark finds happen. Nothing on the server limits
how much one account claims, so public boards can be topped in minutes and one
account can fill the database. Limits can't stop someone faking GPS, but they
cap the damage and keep the boards believable.

**5.1 Upload limits in `sync_cells` (code, M).** Starting values, to tune with
real data:
- Visit times can't be in the future: clamp them to `now()`.
- A hex's visit count is at most 1 + the number of your walks on the server.
  The app uploads walks before hexes (swap the two calls in `sync()` in
  `social.js`).
- Walks: lasting at least distance ÷ 16 km/h and at most 24 hours, and not
  overlapping your other walks.
- At most 2,500 new hexes per day (by last-visit day), and at most 15,000
  hexes visited in any 30 days.
- Over a limit, the extra is dropped rather than the upload failing, so honest
  edge cases don't break syncing, and the account is noted in a `flags` table.

**5.2 Check-ins and landmarks (code, M).**
- `find_landmark` works only for a landmark in a hex you uploaded with a last
  visit in the past hour. The app uploads that one hex just before finding it,
  without waiting for its area.
- `landmarks_near` sends the title and note only for landmarks you left or
  found, so the "?" really is a secret.
- Daily limits: 20 check-ins, 30 landmark finds, 5 new landmarks.
- Votes count towards hiding a landmark only from accounts at least 7 days old
  with 100 or more hexes.

**5.3 Review (code, S).** A `profiles.hidden_from_boards` flag, set by you in the
SQL editor, that takes an account off the area and Everyone boards, and a saved
query listing flagged accounts.

**Done when** every limit has a test in `supabase/tests/social_test.sql` and the
flag works.

### 6. Privacy zones on every device (high)

**Why.** Zones live on one device, but hexes sync between devices. Hexes a
device only downloaded are never marked as uploaded, so a device without the
zone sends them back to the server after another device took them off. The
privacy notice promises the opposite.

**6.1 Quick fix, same privacy promise (code, S).**
- After a pull (`pullFromServer()` in `social.js`), mark each pulled hex as
  uploaded, so a device never sends back what it only downloaded.
- A device with zones that pulls hexes inside them deletes them from the
  server again.

**6.2 Full fix (code, M, after decision 5).**
- A `privacy_zones` table only its owner can read: each zone's centre, radius
  and the street hexes it covers (worked out on the device).
- `sync_cells` drops hexes in any of the caller's zones, and adding a zone
  deletes the matching hexes, check-ins and landmarks on the server.
- Every device loads the zones from the account and applies them.
- Optional: move each new zone's centre by a random 0–30% of its radius, so
  the gap in your map doesn't point straight at home.
- Update `privacy.html` and the README.

**Done when** a test shows that hexes inside a zone set on one device don't
reach the server from another.

### 7. Moderation (medium, high if landmarks stay public)

**Why.** Landmark titles and notes reach every signed-in user, and the only
control is 👎. App stores expect a way to report content, and to block people
where users interact.

- **Report** a landmark: a `reports` table users can only add to, one report
  per person per landmark. Three reports hide a landmark until you review it.
- **Block** someone: they can't send you friend requests, and you stop seeing
  their landmarks.
- A saved query in the SQL editor for reviewing reports.

**Done when** reporting and blocking work in the app, with tests.

## Phase 2: scale

### 8. Leaderboards and the feed (high)

**Why.** Every ranking is worked out from every hex, check-in and landmark
point of everyone involved, on every request. On a local copy with 1,000 users
× 1,000 hexes, the areas on *Me* took 42 s to load, the Everyone and city
boards 20 s each, and a feed page 11 s with 300,000 walks (see the appendix).
Supabase stops signed-in queries after 8 s.

**8.1 Scores kept up to date, not recomputed (code, L).** Heat halves every 30
days, which makes the current score easy to store. For hexes, and the same way
for check-in and landmark points:

```
score(t) = Σ value_i · 2^(−(t − last_i) / 30 days)
         = 2^(−(t − t0) / 30 days) · Σ value_i · 2^((last_i − t0) / 30 days)
```

The sum on the right, `S`, doesn't change as time passes.
- Store `S` per person and area in `area_scores(user_id, area, kind, s)`, with
  `area = '*'` for Everyone. Triggers on `user_cells`, `checkins` and
  `landmark_points` add each new term and subtract the old one.
- People rank the same by `S` as by their current score, so a board is an index
  scan on `(area, s desc)` for the top 50 plus a count of the rows above yours.
  Shown values are `S · 2^(−(now − t0) / 30 days)`.
- Clamp `last` to the upload time (a future visit counts as now, as `heat()`
  already does).
- With `t0` = 1 January 2026 the exponent grows by about 12 a year, so a
  double holds `S` for decades. A nightly `pg_cron` job recomputes everything
  from the source rows, to correct rounding and catch anything missed.
- A home area (`home_area`) becomes the row of that kind with the highest `S`.

**8.2 Week, month and challenges (code, M).** A `daily_scores(user_id, area, day, points)`
table, filled by the same triggers and from `score_events`, indexed on
`(area, day)`. Week and month boards add up their days; challenges add up the
challenge's days in each member's home district. `friend_stats` and
`challenge_standings` read these tables instead of ranking whole districts per
person.

**8.3 Feed and check-in pins (code, M).** A `feed_page(before)` function that
looks up you and your friends first, then takes each person's latest 20 walks,
check-ins and badges through per-user indexes and merges them, instead of
filtering whole tables through row level security. The same for check-in pins
(`loadCheckinMarkers()`). The *Me* sheet reuses area ranks fetched in the last
few minutes instead of asking again on every open.

**8.4 Load test (code, S).** A script in `scripts/` that seeds a local database
with 10,000 users × 2,000 hexes and 300,000 walks, then times every leaderboard
and feed function. Target: under 300 ms each. Run it before any change to
scoring.

**8.5 Advisor clean-up (code, S).** From Supabase's advisors: revoke `execute`
from `anon` on `is_friend`, `is_connected`, `is_challenge_member` and
`can_view_folder`; set `search_path` on the 9 functions without one; index the
5 foreign keys without one.

**Done when** the load test meets its target.

## Phase 3: reliability and operations

### 9. Migrations and staging (you + code, S)

**Why.** The schema was pasted into the SQL editor, so nothing records which
migrations production has, and every change is tried on production first.

- `supabase init` and `supabase link`, then record the existing migrations as
  applied without running them:
  `supabase migration repair --status applied 20261026000000 20261031000000 20261102000000 20261102120000 20261104000000 20261105000000 20261107000000 20261108000000`.
- A second, free project as staging. Changes go to staging with
  `supabase db push` and only then to production.
- New migrations need timestamps after `20261108000000` (dated 8 November
  2026), or `db push` refuses them as out of order.
- Practise a restore once: restore a backup into staging and run the tests
  against it.

### 10. Device storage and walk recovery (code)

**10.1 IndexedDB (M).** Everything lives in `localStorage`, at about 174
characters per hex for a signed-in user (map, sync state and area tags).
Browsers allow about 5 million characters per site, so saving starts to fail
somewhere around 28,000–30,000 hexes (about 430 km²). The whole map is also
rewritten on every save during a walk.
- Move hexes, walks, sync state and area tags to IndexedDB, one record per hex,
  writing only what changed.
- Migrate once from the old keys. Settings can stay in `localStorage`.
- Backup files keep their format.

**10.2 Walks survive a restart (M).** A walk in progress only exists in memory
(`app.js`: "A walk never survives the app restarting"). Save its state every
10 s and whenever the app goes to the background. On start, an unfinished walk
less than 15 minutes old carries on; an older one is saved as it was, with its
summary.

**10.3 Checked backup files (S).** *Restore backup* takes whatever the file
says. Accept only timestamps between 2000 and tomorrow, whole visit counts from
1 to 10,000, and walks with a valid start, an end after it and 0–300 km; say
how many entries were skipped.

### 11. Map tiles and area lookups (you + code, M)

**Why.** Tiles come from the OpenStreetMap Foundation's servers and
openstreetmap.fr, Esri's endpoints are used without an account, and area
lookups go to the public Overpass server. These run on donated resources for
light use, and their policies let them block heavy or unidentified traffic
without notice.

- Pick a tile provider with a production plan (keeping the OpenStreetMap
  attribution), and restrict its key to the web domain and the app.
- Identify the Android app in its requests: `appendUserAgent` in
  `capacitor.config.json`, for example
  `Scoop/1.0 (+https://github.com/AdhamEltantawy/scoop)`.
- Area lookups: a commercial or self-hosted Overpass, or tagging on the server
  from admin boundaries imported once for the launch area (PostGIS), if an H3
  extension is available on Supabase (*Database → Extensions*).
- Read the current OSMF tile usage policy, the Overpass API usage notes and
  Esri's terms before launch.

### 12. Monitoring (code, S)

**Why.** Nobody hears about failed syncs or functions that time out.

- A `client_errors` table the app can only add to (message, stack, app
  version, platform; never coordinates), at most 20 rows a day per person,
  deleted after 30 days by `pg_cron`. Report `window.onerror`, unhandled
  promise rejections and failed syncs.
- Look at Supabase's reports and advisors weekly, and set up alerts once on
  Pro.

## Phase 4: before announcing

### 13. Privacy notice, terms, fonts (you + code, S–M)

- **Fonts.** Serve Bricolage Grotesque, Instrument Sans and IBM Plex Sans
  Arabic from the repo (with their licences) instead of Google Fonts, and add
  them to the service worker's shell. Today every visit asks Google for them,
  which `privacy.html` doesn't mention.
- **`privacy.html`.** Who runs Scoop and an email contact; the services
  involved (Supabase in the EU, the email provider, map tiles, Overpass); how
  long data is kept; people's rights and how to use them; a minimum age; the
  change from 6.2.
- **Terms of use.** What can go in landmarks and check-ins, and that accounts
  can be removed for abuse. Link both from the sign-in sheet.
- **Download my data.** A function that returns your rows on the server as
  JSON, next to *Delete account*.

### 14. Polish (code, S each)

- **14.1 Notification icon.** Walk reminders and landmark alerts use the colour
  launcher icon as their small icon (`WalkDetector.java`,
  `LandmarkNotifier.java`), which many phones show as a grey square. Add a
  white-on-transparent vector icon.
- **14.2 Android manifest.** Mark the location plugin's service
  `android:exported="false"` (with `tools:replace`), decide on `allowBackup`
  (or add data extraction rules), and turn on R8 and test it.
- **14.3 Web.** A Content-Security-Policy (the inline `onerror` on the
  `districts.js` script tag has to go first). The service worker should cache
  only successful responses (`sw.js`) and include `districts.js`.
- **14.4 Google Play, if chosen.** Play App Signing, the Data safety form, the
  foreground service (location) declaration, an account-deletion web page and
  the user-generated content requirements (workstream 7).
- **14.5 Dependencies.** Update Capacitor (8.6.0 is out) and keep an eye on
  `npm audit`: today 6 moderate issues, all in build tools, nothing that ships.

## Progress

- **8 November 2026.** Code done for 1.2 (no fallback signing key; the key is
  out of the repo), 2.1 (fixed parents for own districts, migration
  `20261109000000_fixed_area_parents.sql`, not yet applied to production), 4
  (tests in CI, releases from tags, actions pinned) and 6.1 (pulled hexes never
  uploaded back; zones enforced on pull). Still needed from you: 1.1 and 1.3
  (new key, secrets, telling users), applying the 2.1 migration, and 3.

## Launch checklist

- [ ] APKs signed with a private key; the old key out of the repo; users told how to move over
- [ ] Uploads can't change own districts' parents or area names; production data checked
- [ ] Upload limits, landmark rules and the review flag live, with tests
- [ ] Privacy zones hold across devices
- [ ] Backups on, and one restore practised
- [ ] Email from a project domain; CAPTCHA on; email limit sized for launch
- [ ] Every leaderboard and feed function under 300 ms in the load test
- [ ] Tests gate releases; releases come from tags
- [ ] Migrations tracked; staging in use
- [ ] Tiles and area lookups on services that allow the expected traffic
- [ ] Reporting and blocking live (if landmarks are public)
- [ ] Privacy notice and terms updated, with a contact address
- [ ] Error reports arriving, and someone reading them

## Working through this plan

- One pull request per numbered task, with its tests. A security fix and its
  test go in the same pull request, since this repository is public.
- Database changes go to staging first, then production: with
  `supabase db push` once task 9 is done, pasted into the SQL editor until then.
- Keep this file current: tick the checklist and note decisions as they're
  made.

## Appendix: measurements (7 November 2026)

Leaderboard and feed functions on a local Postgres 16, schema as of
`20261108000000`, with 1,000 users × 1,000 hexes:

| Function | Time |
| --- | --- |
| `my_areas('now')` (*Me* sheet, *Ranks* tab) | 42.2 s |
| `area_leaderboard(null, 'now')` (Everyone) | 19.8 s |
| `area_leaderboard(<city>, 'now')` | 19.8 s |
| `area_leaderboard(<district>, 'now')` (50 people) | 1.6 s |
| Feed walks query, 300,000 walks, no friends | 10.6 s |

- 1,000,000 hex rows take 208 MB with their indexes (the free plan's database
  holds 500 MB).
- Device storage per hex for a signed-in user: about 86 characters in
  `scoop.v1`, 68 in `scoop.sync.v1` and 20 in `scoop.areas.v1`.
- The unit tests (27) and the database test suite pass.
