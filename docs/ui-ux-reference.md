# Scoop: UI/UX reference

_Written 16 November 2026, from the code on branch `landmarks-anywhere-feed-fix` (commit `083ed1e`)._
_Updated 17 November 2026 for the belonging flow (PRs #20, #21 and #22, branch `belonging-home`). What
changed is summarised in [§21](#21-belonging-flow-what-changed-november-2026) and what's left to do in
[§22](#22-next-steps); the sections in between were corrected where the belonging flow changed them._

This document describes Scoop as it is built today: every screen, state, flow,
piece of copy and design token, so design work can start from what exists. It
describes behaviour, not implementation. Where a number matters to the
experience (a distance, a time limit, a zoom level), it's given. Sources are
`index.html`, `style.css`, `tokens.css`, `app.js`, `social.js` and
`social-core.js`.

---

## Contents

1. [The product in one page](#1-the-product-in-one-page)
2. [Design principles already in the product](#2-design-principles-already-in-the-product)
3. [Platforms and modes](#3-platforms-and-modes)
4. [Information architecture](#4-information-architecture)
5. [The main screen: map and floating chrome](#5-the-main-screen-map-and-floating-chrome)
6. [The walk: phases and the stats card](#6-the-walk-phases-and-the-stats-card)
7. [Map visual language](#7-map-visual-language)
8. [Sheets, screen by screen](#8-sheets-screen-by-screen)
9. [Overlays: onboarding, dialog, banners, toasts](#9-overlays-onboarding-dialog-banners-toasts)
10. [Key user flows](#10-key-user-flows)
11. [Scoring, heat and badges (what the numbers mean)](#11-scoring-heat-and-badges-what-the-numbers-mean)
12. [Social model: who sees what](#12-social-model-who-sees-what)
13. [Design system](#13-design-system)
14. [Component catalogue](#14-component-catalogue)
15. [Empty, loading, error and offline states](#15-empty-loading-error-and-offline-states)
16. [Notifications (Android)](#16-notifications-android)
17. [Accessibility and internationalisation](#17-accessibility-and-internationalisation)
18. [Microcopy reference](#18-microcopy-reference)
19. [Known UX gaps and open questions](#19-known-ux-gaps-and-open-questions)
20. [Glossary](#20-glossary)
21. [Belonging flow: what changed (November 2026)](#21-belonging-flow-what-changed-november-2026)
22. [Next steps](#22-next-steps)

---

## 1. The product in one page

**Scoop turns walking around your city into filling in a map.** The world is
divided into hexagons about the size of a street block (H3 resolution 10,
roughly 0.015 km² each). When you walk through a hex, it lights up. Over weeks
it cools from ember red to warm grey unless you walk it again. The map is never
lost; it just shows what you've walked _recently_.

**Core loop:** open the app → tap _Start walk_ → walk → watch new hexes appear
→ tap _Stop walk_ → see a summary (distance, points, new hexes, badge) → come
back later to warm hexes up again or push into the unexplored grid.

**Optional social layer** (needs an account; email code sign-in):
friends, comparing maps, a feed with kudos, check-ins at places, leaderboards by
district/city/country, time-boxed challenges between friends, and
**landmarks**: notes left on a hex that other explorers are told about when
they pass through.

**Who it's for:** people who walk in a city and like seeing progress. The
current launch focus is Greater Cairo and Giza (the app ships its own district
outlines there, and Arabic names render correctly), but it works anywhere.

**Privacy stance (it shapes the UI):** your map lives on your phone. Without an
account nothing leaves the device. With one, only hex ids, visit counts/times
and walk totals are uploaded. **GPS tracks never leave the phone.** Privacy
zones (up to 3 circles) hide everything inside them from uploads and share
images.

---

## 2. Design principles already in the product

These are visible in the code and copy. Keep them unless deliberately changing
direction.

1. **The map is the app.** There are no pages. Everything happens over a
   full-screen map: floating cards on top, buttons at the bottom and right edge,
   bottom sheets for everything else.
2. **One primary action.** _Start walk_ / _Stop walk_ is the biggest thing on
   screen, centred at the bottom, always reachable by thumb.
3. **Colour has strict roles** ("2c: warmth is the brand", since the belonging flow).
   - **Ember (`--accent`)**: shared warmth and the main action: Start walk, primary buttons, recording.
   - **Blue (`--you`)**: you and your choices: your dot and ring, your rank row, selected options,
     switches, your points, this walk's outline.
   - **Pine (`--friend`)**: friends and circles.
   - **Ink (`--ink`)**: alerts and secondary actions; your own kudos.
   - **Heat scale**: map heat only.
   - **Amber (`--warning`)**: the paused state and renew prompts.
   - **Crimson (`--danger`)**: destructive actions only.
4. **The walk tells you its state.** The top card changes layout for each
   phase (waiting for GPS, warming up, recording, paused) so you always know
   whether you're being counted.
5. **Forgiving by design.** Hexes are never lost, only cooled. Restoring a
   backup merges and never deletes. Paused walks keep their hexes. Stopping
   too early says why nothing was saved.
6. **Destructive actions are centred dialogs**, with a safer alternative
   offered where one exists (_Export a backup first_).
7. **Calm copy.** Plain, short, second person, no exclamation marks except in
   invite text and the empty feed. Explains _why_ ("Step away from tall
   buildings").
8. **Private by default, and it says so.** Footnotes in Me, Settings, sign-in
   and Friends repeat what stays on the phone and what others see.
9. **Light outdoors, dark at night.** Light mode is the default (readable in
   sunlight); dark follows the system setting.

---

## 3. Platforms and modes

| | Web / PWA (Android, iPhone, desktop) | Android app (Capacitor wrapper) |
| --- | --- | --- |
| Install | _Add to Home Screen_ | Sideloaded APK from GitHub Releases |
| GPS with screen off | No. Screen must stay on; app requests a wake lock during a walk | Yes. Foreground notification "Scoop is recording your walk" |
| Walk reminders | No | Yes, opt-in (activity recognition) |
| Landmark notifications | No (banner + vibration only) | Yes, when the screen is off |
| Backup export | Downloads a `.json` file | Opens the Android share sheet |
| Back button | Browser default | Closes dialog → sheet → onboarding, else minimises (never quits mid-walk) |
| Tip under Walking settings | "Keep the screen on while walking: phones pause location in background tabs." | "Walks keep recording with the screen off — look for the notification." |

**Two app modes, controlled by CSS body classes:**

- **Community off** (no backend configured): no Friends button, no check-in or
  landmark buttons, and the walk button stays centred thanks to a spacer.
- **Community on, signed out**: the Friends button shows; tapping it opens
  sign-in. Check-in and landmark buttons are hidden.
- **Signed in**: check-in and landmark buttons appear on the right edge.

**Body state classes** (useful for designing every combination):
`walking`, `community-on`, `signed-in`, `sheet-open`, `comparing`,
`landmark-alert-on`, `has-fix`, plus `data-phase` = `empty | idle | gps | warm | rec | paused`.

---

## 4. Information architecture

```
Map (always underneath)
├── Stats card (top)                  ← changes with walk phase
├── Compare bar (under stats)         ← only while comparing with a friend
├── Right edge: Check in · Leave a landmark · Locate
├── Banners (above bottom row): "Looks like you're walking" · Landmark alert
├── Bottom row: [Me] [Start/Stop walk] [Friends]
│
├── Me sheet
│   ├── Settings sheet (gear)
│   │   └── Privacy zones sheet
│   ├── Sign in sheet (if signed out)
│   └── Share map as image (system share sheet)
├── Friends sheet (signed in; else → Sign in)
│   ├── Feed
│   ├── Friends  (invite code, add, requests, list, lapsed)
│   ├── Ranks    (Friends / District / City / Country / Everyone × Now / Week / Month)
│   └── Challenges
│       ├── New challenge
│       └── Challenge detail
├── Check in sheet
├── Landmark sheet (several modes: leave · list on hex · found · secret · yours)
├── Walk saved (summary) sheet
├── Onboarding (first launch; 4 cards + "Location is off")
└── Confirmation dialog (destructive actions)
```

Only one sheet is open at a time. Opening a sheet closes any other. Navigation
"back" inside sheets uses a text link at the top-left (`‹ Settings`,
`‹ Challenges`); there's no navigation stack beyond that.

---

## 5. The main screen: map and floating chrome

### Layout (portrait phone)

```
┌───────────────────────────────┐
│ ┌───────────────────────────┐ │  Stats card · 12px + safe area from top
│ │  1,204    318     18.2    │ │  14px side margins, max 492px wide
│ │  hexes   points  km² expl.│ │
│ │  ▓▓▓▓▓▓▒▒▒░░░░  64% warm  │ │
│ └───────────────────────────┘ │
│ ┌ (Compare bar, if on) ─────┐ │
│          ( toast )            │
│                               │
│            MAP                │
│                          (✚)  │  Check in      52px round
│                          (⚑)  │  Landmark      52px round, 12px gap
│                          (◎)  │  Locate        52px round
│ ┌ banner (nudge/landmark) ──┐ │  100px + safe area from bottom
│ (·)  [ ⬢  Start walk     ] (👥)│  Bottom row: 56px · 64px pill · 56px
│ © OSM                         │  30px + safe area from bottom
└───────────────────────────────┘
```

- **Map**: full-bleed, no zoom buttons (pinch only). Attribution sits bottom-left
  above the bottom row.
- **Me button** (left, 56px circle): white with a 3px green ring and the user's
  initial (`·` when signed out).
- **Walk button** (centre, flexible width, 64px tall, fully rounded): green with
  a hexagon glyph and "Start walk". While walking it turns ink-coloured
  (near-black in light mode) with a square stop glyph and "Stop walk".
- **Friends button** (right, 56px circle): two-person icon. Only with community
  on; hidden while walking.
- **Edge controls** (right, stacked): Check in (pin with plus), Leave a landmark
  (flag), Locate (crosshair). Check in and Landmark appear only when signed in
  and **stay visible during a walk**. Locate moves into the bottom row while
  walking (green crosshair, replacing Friends).
- When the landmark alert banner is up, the edge controls move up (to 180px from
  the bottom) so they aren't covered.

### While walking

```
(  spacer  ) [ ■  Stop walk ] (◎ green)
```

The Me and Friends buttons hide, so a stray tap can't open a sheet mid-walk.
The map follows your position until you drag it; tapping Locate re-enables
following.

### Your position

A dark dot (8px radius, 3px white ring) with a faint accuracy circle (10%
fill). While a walk is waiting for GPS the dot turns grey (`#8A8178`). During a
walk, the hex you're standing in gets a dashed dark outline (dash 4 3, 1.6px).

---

## 6. The walk: phases and the stats card

The stats card at the top has **six layouts**, one per phase. This is the
product's main feedback surface.

| Phase | When | Card content |
| --- | --- | --- |
| `empty` | No walk, nothing ever explored | **"Your map is waiting"** / "Tap Start walk and head out. Your first hexes light up once you've walked 100 m." |
| `idle` | No walk, map has hexes | 3 stats (hexes · points · km² explored) + **warmth bar** (segments coloured by heat band, sized by hex count) + "NN% warm" |
| `gps` | Walk started, GPS not accurate enough yet | Grey pulsing dot · "Waiting for better GPS" · big **±NN m** · "needs ±40 m" · "Step away from tall buildings. We'll start on our own." |
| `warm` | GPS OK, first 100 m not yet walked | Green ring dot · "Warming up" · timer · big **NN m** "until hexes start counting" · green progress bar |
| `rec` | Recording | Green pulsing dot · "Recording" · timer · big green **+N** "new hexes" · **N.NN** "km this walk" |
| `paused` | Moving faster than walking speed | Card turns amber (`--warning-bg`, 1.5px amber border) · pause glyph · "Paused · moving faster than walking" · countdown · **"Looks like you're on wheels"** · "Recording picks up again after a minute at walking speed. Your N new hexes are safe." |

**Timer** format: `m:ss`, or `h:mm:ss` after an hour. It updates every second.

### Rules behind the phases (affect what users perceive)

- **GPS accuracy threshold**: set in Settings (25 / 40 / 75 / 150 m; default 40).
  Worse fixes are ignored.
- **Warm-up**: hexes only start counting after 100 m along your route. Then the
  first 100 m _is_ credited, starting hex included. This prevents "I opened the
  app at home and got my building's hex".
- **Inner 90%**: a hex only unlocks when you're well inside it, so walking along
  a street doesn't unlock the hex across the road.
- **Speed limit**: 9 km/h (Walking) or 16 km/h (Walk + run). Pauses after 3 fast
  readings in a row; resumes after a full **minute** at walking speed (red lights
  and traffic jams don't resume it). Hexes are held 30 s before being saved, so
  when a car pulls away the hexes from just before are dropped.
- **Stopping with nothing saved** (under 100 m): no summary; a toast says
  "Nothing recorded · hexes count once you've walked 100 m".

### Map during a walk

Hexes from this walk are drawn in **bright mint green** (`--walk`) with a dark
green outline, on top of the heat layer, so you can see this walk's trail. When
the walk ends they become ember (just walked).

---

## 7. Map visual language

### Layers, bottom to top

| Layer | Look | When visible |
| --- | --- | --- |
| Basemap | OSM (default), Esri streets, Humanitarian, Satellite | Always; picked in Settings |
| Community map | Violet heat bands `--community-0`…`-3` (heat ≥ .75 / .5 / .25 / older), no stroke; every hex anyone walked, so it never reads as yours (hidden under 3% heat) | Signed in, toggled on in Settings, zoom ≥ 14 |
| Privacy zones | Grey dashed circle (dash 6 5), 12% fill | Only after "Show on map" or adding a zone |
| Unexplored grid | Thin dark hex outlines (white on satellite) | Toggle on (default), zoom ≥ 12, not too many hexes in view |
| Explored hexes | Five heat bands (below) | Always |
| This walk | Mint green fill, dark green stroke | During a walk |
| Friend overlay | Blue outlines **inset to 86%** with 14% blue fill, so your heat colours still show inside | While comparing |
| Your position | Dark dot + accuracy circle | Once there's a GPS fix |
| Check-in pins | 30px white circle, emoji, blue border (green if yours) | Zoom ≥ 16 |
| Check-in bubbles | 20px circle with a count, grouped by block; tap zooms in | Zoom 13–15 |
| Landmark pins | 30px rounded square (8px radius) | Signed in, zoom ≥ 15 |

### Heat bands

Heat halves every 30 days since your last walk through a hex.

| Band | Label | Heat | Fill | Stroke | Fill opacity |
| --- | --- | --- | --- | --- | --- |
| 0 | Now | ≥ 0.75 (< ~12 days) | `#E0301E` | `#9A1D0E` | .72 |
| 1 | 1 mo | ≥ 0.5 | `#EE6B2F` | `#B0441A` | .62 |
| 2 | 2 mo | ≥ 0.25 | `#F49E5E` | `#B26D33` | .55 |
| 3 | 3 mo | ≥ 0.1 | `#EBC8A2` | `#A68A6B` | .50 |
| 4 | 100d+ | < 0.1 | `#C9BCAE` | `#857868` | .48 |

Every band has a darker stroke so even the coldest hex reads as "explored".
Colder bands are drawn first so warmer outlines sit on top. "% warm" on the
stats card counts bands 0–2.

Zoomed out (below 14) or with more than 8,000 hexes in view, hexes merge into
shapes without individual outlines.

### Landmark pin states

| State | Look |
| --- | --- |
| Not found yet (secret) | **?** in muted grey, dashed grey border |
| Found by you | Kind emoji, blue border |
| Yours | Kind emoji, green border |
| Several on one hex | Green count badge top-right (e.g. `3`) |
| Has 👍 votes | Small white tag under the pin: `👍4`, visible even when secret, so people can judge from afar |

Landmark kinds: 🌅 Viewpoint · 🏛️ History · 🎨 Street art · 🌳 Nature ·
🥙 Food & drink · 💎 Hidden gem.

---

## 8. Sheets, screen by screen

All sheets slide up from the bottom (340 ms, `cubic-bezier(.2,.8,.2,1)`), have
a grab handle, a 26px top radius, max 84% of the screen height, max 520px wide,
and scroll internally. A dim scrim covers the map; tapping it closes the sheet.
`Esc` and the Android back button also close.

### 8.1 Me

Opened from the Me button.

1. **Header**: 52px avatar with green ring and initial · name ("Your map" when
   signed out) · subtitle · gear button (→ Settings).
   - Subtitle variants: "Signed out · everything stays on this phone",
     "Pick a username to finish signing in", "Walks mostly in Zamalek", or
     "@username".
2. **Three tiles**: score · day streak · best streak.
3. **Signed-out promo** (tinted green panel, only when signed out): **"Walk with
   friends"** / "Sign in to compare maps, climb your district's ranks and race in
   challenges. Your map stays on this phone either way." / button _Sign in_ (or
   _Finish signing in_).
4. **Trends panel**: title (e.g. "New hexes · weekly") + span ("12 weeks") ·
   readout line · bar chart (tap a bar to read it; the current period is
   selected by default) · two small segmented controls: **Hexes / Points / Km**
   and **Day / Week / Month** · summary line ("Last 12 weeks: 84 new hexes ·
   best: Week of 3 Nov (22 new hexes)").
   - Day = 14 bars, Week = 12, Month = 12. Bars are green at 45% opacity, the
     selected one is 100%. Zero periods show as a 2px grey line.
   - Choice is remembered on the device.
5. **Badges**: label "BADGES · 4 OF 12" · 6-column grid of hexagon badges.
   Earned ones are ember red with white glyphs; unearned are grey. Long-press /
   hover shows the description (title attribute only).
6. **Your areas** (signed in): list of district, city, country with "#12 of 340"
   and a green "top 3.5%".
7. **Share my map as an image** (outline button).
8. Footnote: "Trends are private: worked out on this phone from your walks."

> Note: the score tile first shows the on-device hex score, then (signed in)
> is replaced with the server score, which also counts check-ins and landmarks.
> The number can jump when the sheet opens.

### 8.2 Settings

Opened from the gear in Me. Title "Settings" with a close (✕) button.

1. **Heat legend panel**: five hexes, "Now · 1 mo · 2 mo · 3 mo · 100d+", and
   "Hexes cool over the weeks: their heat and points halve every 30 days. Walk
   them again to warm them up — they're never lost."
2. **MAP**
   - Segmented: **OSM · Esri · Humanitarian · Satellite**
   - Toggle: **Show unexplored grid** (on by default)
   - Toggle (signed in): **Community map** / "How warm every hex is,
     whoever walked it. Tap one for how many explorers; friends' names show." Not remembered between
     sessions.
3. **WALKING**
   - "Count hexes when": **Walking · 9 km/h** / **Walk + run · 16 km/h**
   - "Ignore GPS fixes worse than": **25 m · 40 m · 75 m · 150 m**
   - Toggle (Android only): **Remind me to start a walk** / "When your phone
     notices you walking", with a footnote on limits.
   - Platform tip (see §3).
4. **PRIVACY & DATA** (list card)
   - Privacy zones › "0 of 3"
   - Import GPX › "Strava, Komoot…"
   - Export backup ›
   - Restore backup › "Merges"
   - Clear everything (red)
5. **Account**
   - Signed out: _Sign in_ outline button.
   - Signed in: ACCOUNT label · Username and Display name fields · _Save
     profile_ · list card: **Sync now** › "Synced 14:02" / "Not synced yet" /
     "Offline · will sync when back online" / "Sync failed: …" · **Delete
     account** (red) · _Sign out_ outline button.
6. Footnote: "Your map, walks, trends and privacy zones stay on this phone.
   Signed in, friends see which hexes you've explored — never when, and never
   your route."

### 8.3 Privacy zones

From Settings. Back link "‹ Settings".

- Title **Privacy zones** / "Put a zone around home or work. Hexes inside it are
  never shared, never looked up and never on share cards. Zones stay on this
  phone."
- One card per zone: dashed ring icon · "Zone 1" · "300 m" · radius segmented
  (**200 · 300 · 500 · 800 m**) · _Show on map_ · _Remove_ (red outline).
- _Add zone at map centre_ (green outline). Disabled at 3: "Up to 3 zones".
- New zones default to 300 m at the current map centre. There's no way to drag
  a zone; you move the map first, then add.

### 8.4 Sign in (3 steps)

A 3-segment progress bar under the title.

| Step | Title | Content | CTA |
| --- | --- | --- | --- |
| 1 | Sign in | "We'll email you a sign-in code. No password to remember." · Email field · footnote on what's uploaded | Send code |
| 2 | Check your email | "Enter the code we sent to **you@…**." · large centred code field (6–10 digits, letter-spaced) · _Resend code_ link | Sign in |
| 3 | Pick a name | Username (3–20, a–z 0–9 _) · Display name (optional, 40) · "Friends see your display name. Everyone else only ever sees "Explorer"." · _Use a different email_ | Start exploring |

The CTA stays disabled until the field is valid. Success toasts: "Signed in as
Name" or "Welcome, Name".

### 8.5 Friends (4 tabs)

Opened from the Friends button. Title "Friends", tabs as a segmented control:
**Feed · Friends · Ranks · Challenges**. The last tab is remembered (default
Ranks).

**Feed**
- Mixed list of friends' (and your) walks, check-ins and badges, newest first,
  20 at a time with _Load more_.
- Row: avatar · "**Name** walked 3.2 km · 14 new hexes" · "2 h ago".
  - Walks get a **kudos bar**: 👏 🔥 ❤️ 👣 chips with counts. One kudos per
    person per walk; tapping another emoji switches it. Disabled on your own walks.
  - Check-ins: "checked in · ☕ coffee", optional italic note, optional photo
    (full width, max 320px tall), _Show on map_ link.
  - Meetups: "met up with **Name** 🤝" or "is up for a meetup 🤝".
  - Badges: "earned 🔥 On a roll".
- Your own items say "You".

**Friends**
- **Invite card**: "Your invite code" + code in large letters + _Share invite_
  (shares "Explore the city with me on Scoop!" plus a link).
- **Add form**: input "Friend's invite code or link" + _Add_.
- **REQUESTS** (incoming): avatar, name, @username, _Accept_ chip / _Decline_ link.
- **FRIENDS · N**: each row has avatar, name, "District · 42 pts this week",
  score, _Remove_ link (red), and actions: _Compare maps_ chip (toggles to
  _Hide map_) and a **renewal chip**:
  - green "21 days left" (active)
  - amber button "Renew · 5 days left" (last week)
  - amber "Renew — they did" (they renewed, you haven't)
  - grey "Waiting for them" (you renewed)
- "Waiting on: Name, Name" (outgoing requests).
- **LAPSED**: "Renewable for N more days" + _Renew_.
- Footnote explaining the 30-day friendship and what friends see.

**Ranks**
- **Scope chips**: Friends · District · Name · City · Name · Country · Name ·
  Everyone (only areas you have points in appear).
- **Period** segmented: **Now · This week · This month**.
- **Standing panel** (tinted): "You're #3 of 7 friends" / "You're #120 of 4,310
  in Cairo" + "Top 2.8% · where you walk most". Or "Just you so far" / "No
  points in X yet".
- **Rank list**: position · dot (green you, blue friend, grey stranger) · name ·
  value. Your row is tinted green and labelled "Name (you)". Strangers show as
  "Explorer" in muted text. Gaps in ranking show "…".
- Footnotes explain fading points and the point values.

**Challenges**
- _New challenge_ (green outline) then a card per challenge: title · status
  ("3 days left", "Not started", "Finished", "Invited ›") · dates or "Open it to
  join".
- **New challenge**: back link · Name (placeholder "Weekend loop") · Length
  **1 · 3 · 7 · 14 · 30 days** · Invite friends (checkbox rows, all ticked by
  default) · _Send invites_. Starts immediately.
- **Detail**: back link · title · dates · status · _Join challenge_ (if invited)
  · explainer panel **"Best top % wins"** · one row per member (position,
  name, "District · #6 of 500 · 42 pts", big "1.1%" "top") · rule footnote ·
  _Delete challenge_ / _Leave challenge_ / _Decline_ (red outline).
- The scoring idea: each person is ranked in their **own home district**, and
  the best percentile wins, so someone in a small district can't win just by
  being 1st of 2.

### 8.6 Check in

From the right-edge pin button (signed in). First checks whether you can:

| Blocker | Glyph | Title | Action |
| --- | --- | --- | --- |
| No GPS fix | ⌖ | Finding you… | Locate me |
| Hex not walked (not walking) | ? | Walk this hex first | Start walk |
| Hex not counted yet (walking) | ? | Not counted yet | OK |
| Inside a privacy zone | ◌ | You're in a privacy zone | Manage zones |
| All 4 kinds done today | ☕ | Already checked in today | OK |

Blocked screens share one pattern: grey hexagon glyph, title, explanation, one
primary button, and _Not now_.

**Form**: title "Check in here" / "Zamalek · a hex you walked 2 h ago" · 2×2
grid of kinds:

| Kind | Note on card | Points |
| --- | --- | --- |
| 📷 Photo | +3 · photo needed | 3 |
| ☕ Coffee | +2 pts | 2 |
| 🍽️ Food | +2 pts | 2 |
| 🤝 Meet a friend | +5 with a friend | 5 when a friend checks in at the same hex within 30 min |

Kinds already used today here show "Done today" and are disabled. Choosing
Photo shows a dashed **photo slot** ("Add a photo / Required for a photo
check-in"; opens the rear camera on phones). Note input (optional, 140 chars).
CTA "Check in" / "Check in for a meetup".

Photos are downscaled to 1280px and re-encoded, which strips location data.

### 8.7 Landmarks

One sheet, several modes.

**Leave a landmark** (flag button). Works on any hex you're standing in, walked
or not.
- Blockers: _Finding you…_; **Pinpointing you…** (needs ≤35 m accuracy and a fix
  under 2 minutes old; shows the current accuracy; _Try again_); privacy zone.
- Header "Leave a landmark" + ✕ · "Zamalek · on this hex · explorers who pass
  through get told" · "+3 pts now, +1 each time someone finds it, +1 for each 👍."
- **ALREADY ON THIS HEX · N**: rows for existing landmarks (secret ones read "?
  A landmark · tap to check it").
- Form: 2×3 kind grid · Title (placeholder 'Name it, e.g. "Rooftop view of the
  Nile"', 60 chars) · Note textarea ("What should people look for? (optional)",
  280 chars) · _Leave landmark_.
- Limits replace the form: "You have 25 landmarks out. Remove one below…" or
  "You have 3 landmarks on this hex. Leave the next one somewhere else."
- Android: "Notify me about landmarks with the screen off › Allow" if
  notifications are off.
- **YOUR LANDMARKS · N/25**: each with "found 4× · 👍 2", "not found yet" or
  "hidden".

**Several on one hex** (tap a pin with a count): "3 landmarks on this hex" ·
"Tap one to check it off" or "Walk through this hex to find out what the hidden
ones are" · list · _Done_.

**Secret** (not found, not in that hex): "A landmark" · grey **?** hexagon ·
"Something is here" · "Another explorer left a landmark on this hex. Walk
through it to find out what it is." · "Found by 3 explorers · 👍 2 · 👎 0" · _OK_.

**Found** (opening it while in the hex, or within 30 min of the alert, checks it
off automatically: toast "🌅 Landmark found · +2 pts · you're the 4th explorer to
find it"):
- "Landmark found" · big emoji · title · "Viewpoint · left by Name · 3 d ago" ·
  note · "Found by 4 explorers · 👍 3 · 👎 0".
- **Vote**: "Worth the stop? Your vote helps other explorers" · two tiles
  **👍 Yes** / **👎 Not really**. After voting: "Your vote · tap to change it".
- _Done_ (or _Back to this hex_ when opened from a list).

**Yours**: "Your landmark" · same card plus "earned you 7 pts" · if voted down
enough: a tinted note "Hidden: explorers who found it voted it down, so nobody
else sees it or gets told about it." · _Remove landmark_ (red outline, confirms).

Hiding rule: 3 or more 👎 and at least twice as many 👎 as 👍. Only you and your
friends see who left a landmark; others see "another explorer" / "an explorer".

### 8.8 Walk saved (summary)

Shown after _Stop walk_ when something was recorded.

```
Walk saved · 18:42
3.24 km                         [+27 pts]
───────────────────────────────────────
⬢ New hexes                          41
⬢ Warmed back up                     12
○ Time                            48:10
───────────────────────────────────────
⬢ New badge: On a roll
  Walk 7 days in a row
┌ Forget to tap Start? ── [Remind me] ┐   (Android, once ever)
[               Done                ]
```

The swatches use heat colours: ember for new, orange for warmed. Only the first
new badge is shown if several were earned at once.

---

## 9. Overlays: onboarding, dialog, banners, toasts

### Onboarding (first launch, empty map only)

A centred card pinned to the bottom over a gradient dim, with step dots above
the buttons (the active dot stretches to a 22px ember pill).

| # | Title | Body | Visual | Buttons |
| --- | --- | --- | --- | --- |
| 1 | Every walk warms your neighbourhood | Each street-sized hex you walk lights up. Your neighbours are warming theirs too, and together you warm up your district. | "scoop" wordmark in ember over the 5 heat-band hexes | Next |
| 2 | Private by default | Your map lives on this phone. Scoop never draws or uploads your routes. Neighbours only ever see "an explorer", and friends are up to you. | Lock in a blue-tinted hexagon | Next |
| 3 | Scoop needs your location while you walk | It lights up hexes and shows you what's nearby. Your location and routes stay on this phone; Scoop only looks up totals for your area. | Pin in a blue-tinted hexagon | Allow location · Not now |
| — | Location is off | Scoop can't light up hexes without it. Allow location for this site in your browser settings (app: Settings → Apps → Scoop → Location), then come back. | — | Try again · Look around the map |

"Location is off" also appears any time location permission is denied.

### Confirmation dialog

Centred card (max 420px), 50% dark scrim, red hexagon "!" badge, title, body,
stacked buttons: optional safer action (outline), destructive action (red),
_Cancel_ (ghost, focused by default).

| Trigger | Title | Confirm | Extra |
| --- | --- | --- | --- |
| Clear everything | Clear everything? | Clear everything | Export a backup first |
| Delete account | Delete your account? | Delete account | — |
| Remove friend | Remove Name? | Remove friend | — |
| Delete challenge (creator) | Delete this challenge? | Delete challenge | — |
| Remove landmark | Remove this landmark? | Remove | — |

Leaving a challenge (non-creator) does **not** confirm.

### "Looks like you're walking" banner

White pill card above the bottom row: **"Looks like you're walking"** /
"Start a walk and the last minute counts too." · _Start_ · ✕.

Appears with the map open, no walk running, after about a minute at walking pace
covering 60 m or more. Hides itself after 3 minutes. ✕ snoozes it for 30
minutes; it also stays quiet for 30 minutes after a walk ends. Hidden during
walks.

### Landmark alert banner

Same shape with a **2px green border**: kind emoji · title · "Landmark here ·
left by Name · 👍 2 · 👎 0 · +2 pts" (or "3 landmarks here" / "Check them off for
+2 pts each") · _Check it_ · ✕.

Fires once you're well inside a hex holding a landmark you haven't been told
about in the last 12 hours, with GPS accuracy ≤35 m. Stays up during walks.
Vibrates (80-60-80 ms) when allowed. Hides after 10 minutes. After the alert, you
can still check the landmark off from elsewhere for 30 minutes.

### Toasts

Dark pill (ink background, light text), centred under the stats card, 13px
semibold. Fades in and out over 300 ms; shown for 2.6 s by default (3.5–5 s for
longer messages). Position shifts down while walking or comparing. Toasts are
the app's only channel for success **and** error messages (see §15).

### Compare bar

Under the stats card while comparing maps: small blue avatar · "You & Name" · ✕ ·
legend with key swatches: **N shared** (ember fill + blue inset), **N only you**
(ember), **N only Name** (blue outline). Your privacy-zone hexes are left out of
the counts.

---

## 10. Key user flows

### First walk

1. Launch → onboarding 1–4 → _Allow location_ → system permission prompt.
2. Map centres on you (zoom 16). Card: "Your map is waiting".
3. _Start walk_ → card "Waiting for better GPS" (if needed) → "Warming up, 100 m"
   with a progress bar.
4. At 100 m: "Recording", and the first 100 m's hexes appear in mint.
5. _Stop walk_ → Walk saved sheet (first badge: _First steps_) → _Done_.
6. Card switches to the idle stats with a 100% warm bar.

### Forgot to start

- **Web/app, map open**: the banner appears after a minute of walking → _Start_
  → the walk begins and the last minute is credited.
- **Android, app closed**: activity recognition notices walking → after 3 min a
  notification "Out for a walk?" → _Start walk_ opens the app with a walk
  running. Max once per 3 hours, never 22:00–07:00, not within 30 min of a walk.

### Getting into a car mid-walk

Recording → three fast readings → amber **Paused** card with a 1:00 countdown
that only runs at walking speed → the hexes from the 30 s before speeding up are
dropped → after a minute of walking, back to Recording.

### Signing up and adding a friend

Me → _Sign in_ (or Friends button) → email → code → pick a name → toast
"Welcome, Name" → Friends tab → _Share invite_ → friend opens the link → after
they sign in the request is sent (or accepted, if mutual) → toast "You're now
friends with Name".

### Comparing maps

Friends tab → _Compare maps_ on a friend → toast "Loading Name's map…" → sheet
closes → blue inset outlines on the map + compare bar → ✕ to stop.

### Check-in with a meetup

Both friends in the same walked hex → each taps Check in → 🤝 _Meet a friend_ →
the first gets "Checked in · waiting for a friend to check in here" → the second
(within 30 min) gets "🤝 Meetup verified · +5 pts".

### Leaving and finding a landmark

- **Leaving**: standing on a hex with good GPS → flag → pick a kind → title →
  _Leave landmark_ → toast "🌅 Landmark left · +3 pts · explorers passing by
  will be told".
- **Finding**: another explorer walks into that hex → banner (or notification
  with the screen off) → _Check it_ → auto-checked, +2 → vote 👍/👎.
- **From afar**: zoomed in to 15+, a **?** pin with "👍4" → tap → secret view
  with ratings.

### Importing old walks

Settings → _Import GPX_ → choose one or more files → each track is replayed
through the same walking filter → map fits to the imported area → toast
"Imported 3 walks · 12.4 km · 210 new hexes". Files without timestamps are
skipped with a reason.

---

## 11. Scoring, heat and badges (what the numbers mean)

**Heat**: 1.0 right after a visit, halving every 30 days.

**Hex value** when fully warm: 1 point, plus a "regular" bonus for repeat
visits: +1 at 2 visits, +2 at 4, +3 at 8 (floor of log₂ visits).

**Score** = Σ (hex value × heat) + check-in points + landmark points, all fading
with the same 30-day half-life. So the score is "recent exploring", not a
lifetime total. Walking an old hex earns back the points it had cooled off.

| Action | Points |
| --- | --- |
| Hex, fully warm | 1 (+ regular bonus) |
| Photo check-in | 3 |
| Coffee / food check-in | 2 |
| Verified meetup | 5 |
| Leave a landmark | 3 |
| Find a landmark | 2 |
| Your landmark is found | +1 each |
| Your landmark gets a 👍 | +1 each |

**Streaks**: consecutive days with at least one walk (current and best).

**Badges (12)**

| Glyph | Name | How |
| --- | --- | --- |
| 1 | First steps | Record your first walk |
| 100 | Explorer | 100 street hexes |
| 1k | Cartographer | 1,000 street hexes |
| 10k | Pathfinder | 10,000 street hexes |
| 42 | Marathon | Walk 42.2 km in total |
| 500 | Long haul | Walk 500 km in total |
| 7d | On a roll | Walk 7 days in a row |
| 30d | Unstoppable | Walk 30 days in a row |
| ×10 | Regular | Walk through one hex 10 times |
| Meet | Meet-up | Check in with a friend |
| 10c | Coffee crawl | 10 coffee check-ins |
| 10p | Photographer | 10 photo check-ins |

Badges display as hexagons with short glyphs. Each also has an emoji (used in
the feed: 👟 ⬡ 🗺️ 🌍 🏅 🚶 🔥 🌋 🏠 🤝 ☕ 📷).

**Top %** (Ranks, challenges) = (rank − 0.5) ÷ total, so 1st of 1 is top 50%.

---

## 12. Social model: who sees what

| | You | Friends | Everyone else signed in |
| --- | --- | --- | --- |
| Your hexes on a map | ✓ | ✓ (Compare, Community map) | As heat and a count in the community map, no names, no dates |
| When you visited | ✓ | ✗ | ✗ |
| GPS route | On device only | ✗ | ✗ |
| Walks (distance, new hexes) | ✓ | ✓ (feed) | ✗ |
| Check-ins | ✓ | ✓ (feed, pins) | ✗ |
| Name on leaderboards | ✓ | ✓ | "Explorer" |
| District you walk most | ✓ | ✓ | ✗ |
| Who left a landmark | ✓ | ✓ | "another explorer" |
| A landmark's contents | ✓ | After finding it | After finding it |
| That you found their landmark | — | ✓ (the author, if you're friends) | ✗ |
| Your vote on a landmark | ✓ | ✗ | ✗ |
| Anything inside a privacy zone | ✓ (on device) | ✗ | ✗ |

**Circles** (members aren't friends unless they are anyway): members see your first name, whether you're
coming to its walks, your check-in at its meeting point, whether you walked at all that week (never when
or where), and during a circle walk your hexes and km live. A circle that welcomes guests is listed in its
district by size and schedule only; an approved guest sees its name, meeting point and first names.

**Before signing in**, the app looks up neighbourhood totals and "?" pin locations by district id and
~5 km² blocks (never from inside a privacy zone). Signed in, anyone sees a district's warmth and explorer
count, never who.

**Friendship lifecycle**: pending → active (30 days) → last 7 days: both tap
Renew (renews only once both have) → lapsed (renewable for 30 more days) → gone.
A personal invite code skips "pending" (one shared it, the other used it) but
starts the same 30 days. Using a code with a friend whose friendship lapsed says so and leaves the code open. Nothing renews a friendship automatically: not a code,
not a circle walk. A circle walk summary only shows the usual Renew chip for a
co-walker who is due.

**Areas**: each hex is tagged with country, city and district (from
OpenStreetMap, or Scoop's own outlines for Cairo/Giza). There is no "my district"
to choose (removed 2026-11-24, §23): the home panel shows the district you're in, and
ranks, the weekly matchup and "local" status follow the district you score most in,
with its city and country. Areas are never drawn on the map.

**Limits users can hit**: 3 privacy zones; 25 landmarks out at once, 3 of yours
per hex; one check-in of each kind per hex per day; circles of 2–8 people, up to
3 circles each, up to 3 open guest requests; one personal invite code open at a
time (7 days, one person).

---

## 13. Design system

Name: **2c, "warmth is the brand"** (was Ember & Nile until the belonging flow). Tokens live in `tokens.css`.

### Colour: interface

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F5F0E8` | `#14110E` | App background, theme colour |
| `--surface` | `#FFFFFF` | `#1F1B17` | Sheets, dialogs, banners |
| `--surface-2` | `#F3EDE3` | `#2A251F` | Panels, tiles, inputs, list cards |
| `--chrome` | `#FFFFFF` @ 92% | `#1F1B17` @ 92% | Floating cards and round buttons (with 8px backdrop blur) |
| `--ink` | `#1E1A16` | `#F3EDE4` | Text, stop button, selected chips, your own kudos |
| `--muted` | `#6E655B` | `#A89E92` | Secondary text, labels |
| `--line` | `#E6DDD0` | `#3A332B` | Borders, dividers, grab handle |
| `--accent` | `#D23F1C` | `#FF6F47` | Ember: primary actions, Start walk, recording |
| `--accent-strong` | `#C83B1B` | `#E0522C` | Filled ember cards (welcome) |
| `--accent-ink` | `#B5361A` | `#FF8E6B` | Ember text and links |
| `--on-accent` | `#FFFFFF` | `#1A0D08` | Text on ember |
| `--tint` | `#FCEDE6` | ember @ 15% | The highlighted next step, district cards |
| `--you` / `--on-you` / `--you-tint` | `#2B62E8` / `#FFFFFF` / `#E8EFFD` | `#7C9CFF` / `#0A1230` / 15% | You: dot, ring, rank row, selections, switches, points |
| `--friend` / `--friend-tint` | `#12805C` / `#E4F2EB` | `#4CC79A` / 15% | Pine: friends and circles |
| `--warning` / `--warning-bg` | `#9A6414` / `#FFF6E6` | `#F2B85A` / `#2E2516` | Paused, renew |
| `--danger` / `--danger-tint` | `#A8232B` / 10% | `#FF7A86` / 15% | Destructive |
| `--scrim` | `rgba(20,17,14,.32)` | same | Behind sheets |

### Colour: map

| Token | Value | Use |
| --- | --- | --- |
| `--heat-0…4` | see §7 | Explored hexes |
| `--walk` / `--walk-stroke` | `#DD4420` / `#2B62E8` (dark `#7C9CFF`), fill .85, stroke 2.4 | This walk: ember outlined as yours |
| `--friend-overlay` | `#12805C` (dark `#4CC79A`), fill .14, stroke 2.4 | Compare |
| `--community-0`…`-3` | `#6D28D9` `#8B5CF6` `#B39DF3` `#D9D0F0` (fill .60 / .50 / .40 / .30) | Community map by heat, violet so it never reads as yours (also switched by the home card's district tab) |
| `--privacy` / `--privacy-stroke` | `#5C6470` / `#3A4048`, fill .12, dash 6 5 | Privacy zones |
| `--grid` | `#1A1A1A` @ .28, 0.8px (white @ .35 on satellite) | Unexplored grid |
| `--location` | `#2B62E8` (dark `#7C9CFF`), accuracy fill .16 | Position dot |

Map colours are the same in light and dark mode (the basemap tiles don't change
with theme).

### Typography

| Role | Family | Examples |
| --- | --- | --- |
| Display (numbers, titles, buttons) | **Bricolage Grotesque** 500/700 | Stats 24px, big numbers 40px, summary km 44px, sheet titles 24px, detail titles 26px, primary buttons 17–19px |
| Body | **Instrument Sans** 400–700, with **IBM Plex Sans Arabic** for Arabic | Body 14px, notes 12–13px, fine print 11.5px, labels 11px uppercase +0.06em |

Numbers use tabular figures. Base: 500 weight, 14px / 1.45. Inputs use 16px to
avoid zoom on iOS.

### Radii

chip 999px · input 14px · tile 16px · card 20px · sheet 26px · dialog 26px.
Panels and zone cards use 18px. The **hexagon clip-path** is a recurring shape
(badges, legend, swatches, blocked-state glyphs, onboarding).

### Elevation

| Token | Value | Use |
| --- | --- | --- |
| `--shadow-float` | `0 6px 20px rgba(0,0,0,.14)` | Stats card, popups |
| `--shadow-button` | `0 4px 14px rgba(0,0,0,.16)` | Round map buttons |
| `--shadow-primary` | `0 8px 22px rgba(0,0,0,.22)` | Walk button |
| `--shadow-sheet` | `0 -10px 40px rgba(0,0,0,.2)` | Sheets |

### Motion

| What | Spec |
| --- | --- |
| Sheet in/out | 340 ms, `cubic-bezier(.2,.8,.2,1)`, translateY |
| Toast | 300 ms fade + 8px slide |
| Dialog, onboarding card | `pop`: scale .94 → 1, 250–350 ms |
| Compare bar, landmark banner | `rise`: 24px up + fade, 250–300 ms |
| Status dots | `pulse` opacity 1 → .35, 1 s (GPS) / 1.4 s (recording) |
| Progress bar | width, 250 ms linear |
| Switches | 200 ms |
| Hex burst (`celebrate.js`) | heat-colour hexagons on a full-screen canvas, ~1.5 s; 28 from your dot for a landmark or check-in, 40–90 on a walk summary, 140 + two side bursts for *You're a local* |
| Count-up | summary numbers ease out from 0, 900 ms (points 1100 ms), starting 300 ms after the sheet |
| New hexes glow | the walk's new hexes flash pale gold on the map, 1.8 s, then settle |
| Badge reveal | `pop` + spin in from -120°, then a shine across the hex |
| First step fills | the new hex step scales to 1.35 and turns ember, 700 ms |
| Celebration banner | under the stats card, drops 24px + fade, 5 s, tap to dismiss |
| *You're a local* | full screen; emblem scales and turns in, steps fill one by one 120 ms apart |
| Haptics | `navigator.vibrate`: 30-50-30 ms on a summary, 40-40-60 on a small win, a long pattern for *You're a local* |

`prefers-reduced-motion` turns all animation and transitions off.

### Spacing and layout

- Screen side gutters 14px; sheet padding 20px; sheet section gap 18px.
- Floating content max width 492px; sheets 520px; dialog 420px. On tablets
  and desktop everything stays a centred phone-width column over a full-width
  map.
- Safe-area insets are respected top and bottom (Capacitor injects them on
  Android).
- Touch targets: 44px minimum (icon buttons 36–44, round buttons 52–56, primary
  buttons 56, walk button 64).

---

## 14. Component catalogue

| Component | Class | Spec |
| --- | --- | --- |
| Primary button | `.btn` | 56px, pill, accent, display font 17px. Disabled: surface-2 / muted |
| Medium / small | `.btn.md` / `.btn.sm` | 48px / 44px, body font |
| Outline | `.btn.outline` | 48px, 1.5px line border, ink text. `.accent` variant: 52px, green border & text |
| Danger | `.btn.danger` / `.btn.outline.danger` | Red fill / red text on line border |
| Ghost | `.btn.ghost` | 44px, transparent, ink |
| Text link | `.link`, `.back` | Accent, 600 weight, min 32px tall |
| Icon button | `.icon-btn` (`.sm`) | 44 (36)px circle, surface-2 |
| Round map button | `.round` | 56px (52 on edge), chrome + blur, 22px stroke icon |
| Walk button | `.walk-btn` | 64px pill, accent → ink when pressed |
| Chip | `.chip` | 34px pill, 1.5px border. Pressed: ink fill. Status variants `.ok` (green tint), `.warn` (amber), `.quiet` (grey) |
| Segmented control | `.seg` (`.sm`, `.tall`, `.tabs`) | surface-2 track, 40px segments; selected is a white raised segment (inside panels: ink fill) |
| Toggle row | `.toggle-row` | 52px row, label + optional small text, 44×26 switch |
| List card / row | `.list-card` `.list-row` | surface-2 rounded group, 52px rows, value + chevron, `.danger` red |
| Input | `.input` | 52px, 1.5px border, surface-2, 16px text. `.code`: 64px centred 28px display font, letter-spaced. `textarea` min 76px |
| Choice tile | `.kind` | 2-column grid, emoji + bold label + small note, 2px border; selected green border + tint |
| Photo slot | `.photo-slot` | 96px dashed box; filled state green |
| Panel | `.panel` (`.tint`) | 18px radius surface-2 (or green tint) container |
| Stat tile | `.tile` | surface-2, number 24px display + 11.5px label |
| Avatar | `.avatar` (`.sm`, `.lg`, `.me`, `.accent-ring`) | Circle with initial; blue for friends, green for you |
| Hex badge | `.hex-badge` (`.danger`, `.quiet`, `.hot`) | Hexagon clip with glyph |
| Badge | `.badge` (`.earned`) | 40×46 hexagon + 9.5px name |
| Rank row | `.rank-row` (`.me`, `.friend`, `.stranger`) | 52px, position, coloured dot, name/sub, value |
| Person row | `.person` | Avatar, name/sub, score, actions indented 52px |
| Feed item | `.feed-item` | Avatar + text/meta/extras, divider |
| Challenge card / row | `.chal-card`, `.chal-row` | surface-2 card; row with big position and top % |
| Pick row | `.pick-row` | Checkbox row with 22px tick square |
| Progress steps | `.progress-steps` | 4px segments, filled green up to the current step |
| Banner | `.nudge` | 22px radius white pill, text + small button + ✕ |
| Toast | `.toast` | Ink pill, 13px |
| Sheet | `.sheet` | See §8 |
| Dialog | `.dialog` | See §9 |
| Map pins | `.checkin-pin`, `.checkin-bubble`, `.landmark-pin` | See §7 |

Icons are inline SVG strokes (2px, round caps). Emoji carry meaning for
check-in kinds, landmark kinds, kudos and votes.

---

## 15. Empty, loading, error and offline states

| Where | State | What shows |
| --- | --- | --- |
| Stats card | Nothing explored | "Your map is waiting" |
| Feed | Nothing | "Nothing here yet. Add friends in the Friends tab, then go for a walk!" |
| Friends list | None | "No friends yet. Share your invite code to walk together." |
| Ranks (Friends) | Alone | "Just you so far" + suggestion to add friends or tap Everyone |
| Ranks (area) | No points | "No points in X yet" |
| New challenge | No friends | "Add friends first to race them." |
| Your landmarks | Not found | "not found yet" |
| Any Friends tab | Loading | "Loading…" fine print |
| Any Friends tab | Failed | "Couldn't load: <error>" or offline: "You're offline. Your map still works." |
| Check in / Landmark | Loading | "Loading…" / "Checking it off…" |
| Basemap | 6 tiles fail, none load | Toast "Map not loading — try another map style in Settings" |
| GPS during walk | No fix for 15 s | Toast "Still looking for GPS…" |
| Locate | No fix yet | Toast "Finding you…" |
| Storage | Save fails | Toast "Could not save — storage full or blocked. Export a backup!" |
| Sync | Status in Settings | "Not synced yet" / "Synced 14:02" / "Offline · will sync when back online" / "Sync failed: …" |
| Landmark | Deleted meanwhile | Toast "That landmark isn't around any more" |

Offline, the map, walks, stats, trends and settings all work. Only social
features need a connection. Errors from the server show as toasts with the raw
message, except for a few translated cases (taken username, duplicate
check-in).

---

## 16. Notifications (Android)

| Channel | Title | Text | Action |
| --- | --- | --- | --- |
| Walk in progress (foreground service) | Scoop is recording your walk | Tap to return to the map | — |
| Walk reminders | Out for a walk? | Tap to start recording, so the hexes you pass count. | Start walk |
| Landmarks | 🌅 _Landmark title_ (or "N landmarks here") | A landmark here, left by Name. Tap to check it for +2 pts. | Check it |

The small notification icon is currently the colour launcher icon, which many
phones show as a grey square (listed in the production plan).

---

## 17. Accessibility and internationalisation

**In place**
- `aria-live` on the stats card, toasts and banners, so phase changes and
  messages are announced.
- Segmented controls are `radiogroup`/`radio`; toggles are `switch` with
  `aria-checked`; chips use `aria-pressed`; the walk button uses `aria-pressed`.
- The dialog is `alertdialog`, `aria-modal`, labelled, and focuses _Cancel_.
- Every icon-only button has an `aria-label`.
- Trend bars are buttons with spoken labels ("Week of 3 Nov: 22 new hexes").
- Visible focus ring (2px accent).
- Reduced motion respected.
- Text people typed (names, titles, notes) uses `dir="auto"` / `<bdi>`, so Arabic
  and mixed-direction text displays correctly; IBM Plex Sans Arabic is loaded.
- Numbers and dates use the device locale.

**Gaps to consider**
- The interface itself is English only, and the layout is not mirrored for RTL.
- Badge descriptions are only in a `title` tooltip (not reachable on touch).
- Map content (hexes, heat) is visual only; the stats card is the accessible
  summary.
- Sheets aren't announced as dialogs and don't trap focus.
- Several secondary texts are 9.5–11.5px (badge names, fine print).
- Heat bands differ by hue and lightness; band 3 vs 4 is low-contrast on light
  basemaps.

---

## 18. Microcopy reference

**Voice**: plain, friendly, second person, short sentences. Says why. Uses
middle dots ( · ) to join facts, and an em dash sparingly. Numbers are
localised. Points are written "pts".

**Recurring phrasing**
- Hexes are "explored", "walked", "lit up", "warm", "cool". Never "conquered" or
  "captured".
- People who aren't friends are "explorers" / "Explorer".
- Privacy reassurance: "stays on this phone", "never your route".

**Toasts (selection)**
- Walk started · you can lock your phone _(Android)_
- Nothing recorded · hexes count once you've walked 100 m
- Backup saved to Downloads
- Restored · N new hexes merged, nothing deleted
- Imported N walks · X km · N new hexes
- Skipped file.gpx: no timestamps, so walking can't be verified
- Stop your walk before importing
- All cleared
- Privacy zone added at the map centre / Zone removed
- Signed in as Name / Welcome, Name / Signed out · your map stays on this phone
- New code sent / Profile saved / Account deleted
- Request sent to Name / You're friends with Name / Renewed · friends with Name for 30 more days / Renewed on your side · waiting for Name
- That doesn't look like an invite code
- Loading Name's map…
- Invites sent to N friends
- 📷 Checked in · +3 pts / 🤝 Meetup verified · +5 pts / 🤝 Checked in · waiting for a friend to check in here
- You already checked in like that here today
- 🌅 Landmark left · +3 pts · explorers passing by will be told
- 🌅 Landmark found · +2 pts · you're the 4th explorer to find it
- 👍 Thanks · +1 pt for whoever left it / 👎 Thanks · that helps keep landmarks worth the stop
- Landmark removed
- We'll ask when you're out walking / Allow physical activity and notifications for Scoop in Android settings

**Relative time**: "just now", "5 min ago", "3 h ago", "2 d ago", then a date.

---

## 19. Known UX gaps and open questions

Observed in the current build, not yet decided. Useful starting points for
design work.

1. **Errors live only in toasts.** A failed save or sync disappears after a few
   seconds; raw server messages can leak through. Consider inline error states
   in sheets.
2. **Score jumps when Me opens** (local score, then server score). Decide which
   is "the" score and how to show the difference (e.g. a breakdown: hexes,
   check-ins, landmarks).
3. **Points are invisible during a walk.** The recording card shows new hexes and
   km, not points; points appear only on the summary.
4. **Badges have no detail view.** Descriptions are in tooltips only, and there's
   no progress ("62 of 100 hexes").
5. **Privacy zones are placed blind**: "at map centre", no drag, no preview
   before adding. Zones are only drawn after _Show on map_.
6. **No moderation UI.** Landmarks can be voted down but not reported, and
   people can't be blocked (production plan, workstream 7).
7. ~~**Feed is read-mostly**~~ Done in the belonging flow: kudos on check-ins,
   badges and landmark finds; friends' finds of your landmarks and your best
   landmark appear in the feed. Still missing: kudos on circle walks in the feed.
8. **Community map toggle** isn't remembered and is buried in Settings → Map.
9. **The share card** is always light-themed, square-ish (1080×1350) and uses
   whatever part of the map is on screen, with no preview or framing step.
10. **Walk summary** shows only the first new badge if several were earned.
11. ~~**Leaving a challenge** doesn't confirm~~ Friend challenges are gone from
    the app (their data is kept); open district challenges join and leave with
    one tap, which is cheap to undo.
12. **No walk history list.** Past walks exist only as feed items (signed in) and
    trend bars.
13. **No way to see landmarks zoomed out** (below 15) or to search for them.
14. **Walks don't survive an app restart** (production plan 10.2). There's no UI
    for "your walk was interrupted".
15. **Sign-in has no terms/privacy link** and no CAPTCHA yet (production plan 3
    and 13).
16. **Tablet/desktop**: everything is a phone-width column; there's no wider
    layout.
17. **Localisation**: English UI only, despite the Cairo/Giza focus.

---

## 20. Glossary

| Term | Meaning |
| --- | --- |
| Hex | A street-block-sized hexagon (H3 res 10, ~0.015 km²) |
| Explored | You've walked through it at least once |
| Heat / warm / cool | How recently you walked a hex; halves every 30 days |
| Warmth bar | Stats-card bar showing your hexes by heat band |
| Warming up | The first 100 m of a walk, before hexes count |
| Paused | Moving faster than walking speed; recording stops |
| Unexplored grid | Outline of hexes you haven't walked, in view |
| Check-in | A tagged moment at a walked hex (photo, coffee, food, meetup) |
| Landmark | A titled note on a hex; others are told when they pass |
| Secret landmark | One you haven't found: shown as **?** |
| Find | Checking off someone else's landmark in its hex |
| Privacy zone | A circle (200–800 m) whose hexes are never shared |
| Compare | Overlay a friend's hexes on your map |
| Community map | Every hex anyone walked, shaded by heat; only friends are named |
| Home district / city / country | The district you score most in (heat-weighted), and its city and country. Nothing to choose |
| Top % | Your rank as a percentile of an area's explorers |
| Explorer | How anyone who isn't your friend appears |
| Kudos | Emoji reactions (👏 🔥 ❤️ 👣) on walks, check-ins, badges and circle walks |
| Renew | Both friends confirm in the last week to extend a 30-day friendship |
| Neighbourhood pulse | Totals for your district and "?" pin locations near you, looked up anonymously |
| Firsts | The six things a newcomer does to "become a local" |
| Welcome landmark | A landmark its author points newcomers to |
| Circle | 2–8 people who walk at the same time each week |
| Circle walk / session | One booked walk of a circle |
| Meetup (circle) | Checking in at the meeting point; verified once two have |
| Free skip | One missed week per circle per month that doesn't break its streak |
| District warmth | Average heat of a district's walked hexes (1 right after a walk, halving every 30 days, as on the map); goal 50% by Sunday |
| Matchup | This week's district rival: the closest warmth in the same city |
| Open challenge | A district challenge anyone there can join, added by an admin |
| Personal code | An invite like `ZAM-7KQ2-XM4P`: made when you share it, one person, 7 days, carries your welcome landmark; 10 wrong tries an hour per account |

---

## 21. Belonging flow: what changed (November 2026)

Built from the Claude Design prototype **"Scoop Belonging Flow v2"** (direction 2c) in three stacked pull
requests. Each phase has its own Supabase migration; apply them in order.

| Phase | PR | Branch | Migration |
| --- | --- | --- | --- |
| 1. Arriving in a neighbourhood | #20 | `belonging-arrival` | `20261117000000_belonging_arrival.sql` |
| 2. Circles | #21 | `belonging-circles` | `20261118000000_circles.sql` |
| 3. Home, feed, ranks, challenges, bringing someone in | #22 | `belonging-home` | `20261119000000_belonging_home.sql`, `20261120000000_home_district.sql` |

As of 17 November 2026 every migration above is applied to the live project, including the fixed
`20261119000000_belonging_home.sql` (with the upgrade lines from #26) and `20261120000000_home_district.sql`.
Live function bodies were checked against the repo and match (live stores them with CRLF line endings).

### Decisions behind it

| Question | Decision |
| --- | --- |
| Colours | 2c across the whole app (see §2 and §13) |
| Delivery | Three phased PRs, stacked |
| Data before sign-in | A coarse anonymous lookup: district id and ~5 km² block ids only, never from inside a privacy zone |
| Walking together | Hex ids and km shared live over private Supabase Realtime channels; never tracks |
| Reminders | `@capacitor/local-notifications` on Android; an in-app banner on the web |
| Circle discovery | Listed in the district only if "Welcome guests" is on, which is **off by default**; the owner approves each guest |
| What circle members see | First names, RSVPs, meetup check-ins, live hexes and km during circle walks; otherwise only whether each walked that week |
| Circle rules | 2–8 members, up to 3 circles each; a week counts when 2+ check in together; one free skip a month |
| Friendship renewal | Kept exactly as it was. Circles never make people friends; nothing renews automatically |
| Home card | The district/circle panel replaces the idle stats card when signed in, in a known district; your stats move to Me |
| Landmark finders | Never named, not even friends: vote totals are public, so a name would give a vote away. The feed says "Someone found your landmark" |
| Circle ranks | Circles against circles by km together; never members' points |
| Challenges | Friend challenges replaced; weekly rival is the closest-warmth district in the same city; open challenges added by an admin |
| Home district | You choose it (suggest → confirm → it stays put), from districts you've walked. It used to be recomputed on every call as your warmest district, so a busy weekend elsewhere could quietly change your "local" identity, ranks and what friends see |

### Phase 1: arriving in a neighbourhood

- **Onboarding** in three cards (see §9).
- **Empty map**: "You're in Zamalek · 46 explorers keep it warm · 1 landmark within 5 min", **?** pins with 👍
  counts (signed out too), and the hint "Walk past a **?** to see what a neighbour left". Start walk reads
  "warms Zamalek".
- **First walk saved**: an ember card "Welcome to Zamalek · You're its 47th explorer", nearby landmarks, and
  **Meet your neighbourhood** instead of Done.
- **Your first week** sheet (also from Me until you're a local): six neighbourhood firsts (first walk, make
  it home, find a neighbour's landmark, walk with someone, coffee check-in, leave a welcome), the next one
  highlighted with "Go ›".
- **Welcome landmarks**: "Point newcomers here" when leaving a landmark (on by default). Newcomers are pointed
  to the nearest welcome within 2 km; finding one lands with a hex burst under "A welcome from a neighbour".
- **Server**: `landmarks.welcome`; `area_pulse(district, blocks)` (anonymous); `my_firsts()`.

### Phase 2: circles

- **Walk with people**: why circles, circles nearby that welcome guests (size and schedule only), a guest
  offer ("Ask to join Thursday's walk"), **Start a circle**.
- **Setup**: name, day and time (from your last walk), meeting point (never inside a privacy zone), weekly km
  goal, Welcome guests (off).
- **Invite** by link `?circle=CODE`; the invite screen notices when someone joins.
- **A circle's page**: streak and free skip, km against the goal, next walk with who's in, members'
  walked-this-week, guest requests (owner), invite, change, leave.
- **Can't make it**: who knows, the free skip, "Walk solo tomorrow instead" (one reminder), undo.
- **Meet up**: check in at the meeting point from 30 minutes before; two check-ins verify it (+5 each).
- **Walking together**: "+N hexes together · with Nour and Omar" in the recording card.
- **Circle walk saved**: everyone's hexes, kudos, **Book it** for next week, and the Renew chip for friends
  who are due.
- **Reminders** an hour before (Android notification with "I'm on my way" / "Can't make it") and a map banner.
- **Server**: `circles`, `circle_members`, `circle_sessions`, `session_people`, `circle_kudos`; Realtime
  policies on `circle-session:<id>`; streak with free skip; ownership hands over when an owner leaves or
  deletes their account.

### Phase 3: home, feed, ranks, challenges, bringing someone in

- **Home card** (replaces the idle stats card, see above): district tab (warm %, your share in blue, goal mark,
  your hexes this week, neighbours) and circle tab (km together, week status, streak, next walk), with one
  line to act on: cooling hexes near you (Show), the goal gap, the next circle walk (Open), or "Same time next
  week?" (Book). The district tab turns on everyone's warmth (the community layer) and outlines your circle's meeting point.
- **Me** gains a second row of tiles: hexes, km² explored, % of your map warm.
- **Feed**: your best landmark on top; "Someone found your landmark 🌅" (never who); kudos on check-ins and badges.
- **Ranks** (district): "Circles in Zamalek · Thursday Walkers is #2 of 14 this week" and "One more first from
  becoming a Zamalek local · 5/6"; new footnote on fading points.
- **Challenges**: "Zamalek vs Downtown" this week (warmest on Sunday night wins), your circle's km goal,
  "Become a Zamalek local", and **Open to everyone in Zamalek** with Join and progress.
- **Friends**: "Bring someone into Zamalek" with a personal code (made when you tap Share; one person, 7 days)
  that points the newcomer to your welcome landmark; a toast when someone uses it. Wrong codes all get the same
  answer, and an account gets 10 wrong tries an hour.
- **Server**: `district_warmth`, `district_matchup` (+ `district_matchups`), `circle_standing`,
  `area_challenges` / `add_area_challenge` (admin) / `area_challenges_for` / `join_area_challenge`,
  `reactions` / `react` / `reactions_for`, `landmark_finds_feed`, `invite_codes` / `new_invite(make)` /
  `my_invites` / `use_invite` (+ `invite_misses`).
- **Choosing your home district** (`20261120000000_home_district.sql`): "Make Zamalek home" in the firsts opens
  a chooser: your warmest district as the suggestion, plus up to 4 others you've walked. Me → Your areas → the
  district row opens the same chooser to change it. Until you choose, home is still your warmest district,
  and the "make it home" first stays open. After a later walk the app asks once per district: "Make Zamalek
  home?" (no home yet, and you just walked your warmest district) or "You've been warming Garden City most
  lately" (it beat your home in each of the last 3 weeks, and you've had that home for 3+ weeks). Server:
  `profiles.home_district` / `home_set_at`, `set_home_district`, `home_choices`, `warmest_area`; `home_area`
  returns your choice (and its city and country), and `my_firsts().home` is set only once you've chosen.

### New files and dependencies

- `circles.js` (circles) and `home.js` (home card), both built on `window.scoopKit` from `social.js`.
- `@capacitor/local-notifications` 8.3.1 (CI's `android:sync` wires it into Gradle).
- `privacy.html` describes the anonymous lookup, circles, finders, reactions and personal codes.
- Service worker shell cache bumped to v16.

### How it was tested

- `scripts/test-db.sh` against Postgres 16 in Docker (no local Postgres needed); the stub includes a minimal
  `realtime` schema. All tests pass, and each new migration re-applies cleanly.
- Unit tests: `node --test tests/social-core.test.mjs` (36 pass). `npm test` finds 0 tests on Windows because
  its quoted glob doesn't expand there.
- Headless Chrome against a local server with a mocked Supabase, light and dark, for every new screen,
  including real ~170 m simulated walks.

---

## 22. Next steps

### Before shipping (you)

1. ~~Merge in order~~: done 17 November 2026. #20, #23 (circles, replacing the stale #21), #22 via #23, then the
   review fixes and follow-ups in #24, #25 (home district) and #26.
2. ~~Apply the phase 3 migrations~~: done 17 November 2026 (the fixed `20261119000000_belonging_home.sql`, then
   `20261120000000_home_district.sql`).
3. **Realtime**: in the Supabase dashboard → Realtime → Settings, turn **off "Allow public access"**, or the
   private-channel policies for circle walks don't apply.
4. **Add open challenges** for the districts you're launching in, for example:
   ```sql
   select public.add_area_challenge('r900000000001', 'Warm the whole Corniche', 'Every hex along the river',
     'cells', null, array['8a3e…'], now(), now() + interval '14 days');
   select public.add_area_challenge('r900000000001', 'Find all the Zamalek landmarks', null, 'landmarks');
   ```
5. **Build the APK** (CI) and check on a real phone: circle reminders and their action buttons, the solo walk
   reminder, and that notifications are allowed when asked.

### Test for real

6. **Two phones walking together**: Realtime hex sharing between members, late joiners getting the hexes so
   far, and privacy-zone hexes never sent.
7. **A guest end to end**: list a circle, ask as a stranger, approve, see the meeting point.
8. **A personal code end to end**: share, use on a new account, land on the welcome landmark first.
9. **The weekly matchup** across a Monday: pairings reset, and both districts see each other.

### Product follow-ups

10. **Kudos on circle walks in the feed**: circle walks show only in the walk summary today.
11. **"Up N places since you joined"** (the design's Ranks line) needs a rank history; not built.
12. **Street names** in banners ("Shagaret El Dor St is cooling"): the app has no street data, so it says
    "N of your hexes near you are cooling" instead.
13. **The "3×" retention stat** from the design is left out until there's cohort data to back it.
14. **A "local" badge** for finishing all five firsts (today the title changes and the Me row disappears).
15. **An admin UI for open challenges**, instead of SQL.
16. **Last week's matchup result** ("Zamalek won the week") on the Challenges tab.
17. **Delete the old friend-challenge tables** once you're sure nobody needs that data.
18. **Fix `npm test` on Windows** (a quote-free glob or a small runner script).
19. Revisit §19's remaining gaps. Several (errors only in toasts, no badge detail, no moderation) matter more
    now that strangers meet in circles: **reporting and blocking** should come before circles welcome guests
    widely.

## 23. "My district" removed (2026-11-21)

The home district chooser is gone: the Me row, the "Make X home" first, the post-walk "Make X home?" card and
the 3-week switch prompt. Migration `20261125000000_derived_home.sql`:

- `home_area()` is always `warmest_area()` (heat-weighted score, so it moves slowly); `profiles.home_district`,
  `set_home_district` and `home_choices` stay only so older apps keep working, and are ignored.
- `my_firsts().home` is that derived district; the app has five firsts, not six.

The home panel's place tab is "You're in {district}", following where you stand (`scoop:hood`). It shows the
district's warmth, your share, neighbours, landmarks, cafés and how many circles welcome guests there (size and
schedule only, as before). While it's open the map shows everyone's warmth (the community layer) and outlines your
own circle's meeting point. Circles that welcome guests are **never pinned on the map**: their meeting point stays
private until a guest is approved. Ranks, the weekly rival and "local" status use the derived district, so a
commute doesn't flip them.

Where Scoop has no district (El Gouna, say) there is no "You're in …" panel: the card stays the stats it always was, and the saved "last district" is cleared so it never claims one you've left. It fills in once a walk there has been looked up.

Not done: the community layer still shows hexes only one person walked (with "First here: name" in the popup).
A district-wide view makes that more visible in quiet districts; a minimum of 2-3 explorers per hex would fix it.
