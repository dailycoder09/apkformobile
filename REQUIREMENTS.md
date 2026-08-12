# Plan: 3D Glass UI Redesign + Namaz & Workout Tracker (new branch)

## Context
The app looks like a WhatsApp clone. Goal: complete overhaul to a **premium** app with animated backgrounds, card effects, and two new lifestyle modules (Namaz + Workout tracker) — so it genuinely looks like a top-tier productivity app, not a monitoring tool. All existing monitoring features remain intact and invisible.

> **UPDATE (pivot):** the original direction below was dark 3D-glassmorphism (blur, translucency, mouse/device tilt, animated particle canvas). After reviewing real references, the direction pivoted to a **light, flat, soft-drop-shadow** style instead — white/lavender backgrounds, opaque cards with soft ambient shadows (no blur), no 3D tilt, no animated particles. The "3D Card Effects" and "Background — Canvas Particle System" sections below are superseded; the "Glass Design Tokens" section has been replaced with the current light token set. Login and BottomNav have already been rebuilt against the new direction — future slices (Dashboard, Namaz, Workout) should follow it too.

## Branch Strategy
All work done on `feature/glass-ui` branch — `main` stays safe.

```bash
git checkout -b feature/glass-ui
```

---

## Visual Design: 3D + Glassmorphism + Animation

### Background — Canvas Particle System (`ParticleCanvas.jsx`) — SUPERSEDED
~~Full-screen `<canvas>` fixed behind everything, 60 floating orbs/stars with slow drift, aurora blobs.~~ Dropped — references showed plain, static, flat backgrounds. `ParticleCanvas.jsx` was built, used on Login, then deleted once the pivot landed. Screens now use a plain `linear-gradient(160deg, var(--page-bg-from), var(--page-bg-to))` page background.

### 3D Card Effects (pure CSS + JS) — SUPERSEDED
~~Cards respond to device tilt / mousemove tilt (`rotateX`/`rotateY` ±8°), `preserve-3d`, `translateZ(20px)` depth, dynamic shadow shift.~~ Dropped — references are flat with no rotation. Cards now use a plain soft ambient shadow (`--shadow-soft`) with no tilt/perspective.

### Light Soft-Shadow Design Tokens (current)
```css
--accent:       #818cf8   /* indigo — primary/chat */
--accent-dark:  #6366f1
--gold:         #f59e0b   /* Namaz amber */
--radius-xl:    24px
--page-bg-from: #f6f4ff
--page-bg-to:   #ece7fb
--card-bg:      #ffffff
--ink:          #1f1b2e
--ink-muted:    #8b87a3
--shadow-soft:  0 8px 24px rgba(124,109,242,0.14)
```
Pastel tint tokens for Workout (emerald/mint) and Finance (rose/coral) module cards are deferred until the Dashboard slice actually needs them — add then, not speculatively now.

Bottom nav is a **dark floating pill** (near-black `#17152b`, `border-radius: 999px`) with circular icon-only buttons (active tab filled `var(--accent)`) — an intentional contrast accent against the light pages, not part of the light token set itself.

### Animations (@keyframes — no library)
> Note: `shimmer` and `spin-glow` were built for the superseded glass Login (button sweep, spinning logo) and were deleted with it. The list below is aspirational for future flat-style slices — re-evaluate fit against the light/flat direction when actually building each screen, don't assume all of these belong in a flat design.
- `float` — cards gently bob up/down (y: 0→-6px, 3s ease-in-out infinite)
- `pulse-ring` — expanding ring on active prayer / streak badge
- `count-up` — number increments via CSS counter animation
- `slide-up` — bottom sheet and screen transitions (translateY + opacity)

---

## New Navigation Structure

Replace 2-tile HomeScreen with **bottom tab bar** (persistent, user only):
```
[ 🏠 Home ] [ 🕌 Namaz ] [ 💪 Workout ] [ 💬 Chat ] [ 💰 Finance ]
```

Extend `App.jsx` `module` state: `null`→Dashboard | `'namaz'` | `'workout'` | `'messages'` | `'transactions'`

---

## Files

### ~~New: `client/src/components/ParticleCanvas.jsx`~~ — REMOVED
Built, used on Login, then deleted as part of the light-theme pivot (see "Background — Canvas Particle System" note above). Screens use a plain gradient background now.

### `client/src/components/BottomNav.jsx` — BUILT (as a dark floating pill, not a glass bar)
- 5 circular icon-only buttons (inline SVG, no icon library) inside a dark floating pill (`#17152b`, `border-radius:999px`)
- Active tab: filled `var(--accent)` circle, white icon (no separate glow-dot)
- Labels kept as `aria-label`/`title` for accessibility, not rendered visually
- Hidden when `session.role === 'admin'`

### New: `client/src/components/Dashboard.jsx`
> Not yet built. Description below is the original 3D-glass vision — re-evaluate the "3D tilt"/"spinning ring" specifics against the current flat/light direction when this slice is actually built (e.g. static progress rings and flat float-animated cards, no tilt).
- Greeting: animated typewriter `"Assalamu Alaikum, {name} ✨"`
- Date + Hijri date (calculated inline)
- **Next prayer card** (3D tilt): countdown timer, prayer name, SVG arc progress ring (conic-gradient spinning to completion)
- **3 stat cards row** (3D tilt, `float` animation staggered): Namaz x/5, Workout x min, Finance net ₹
- **Activity feed**: last 5 events merged from namaz + workout + transactions, with icons

### New: `client/src/components/NamazTracker.jsx`
> Not yet built. "3D glass card"/"gold glow" specifics below are aspirational — re-evaluate against the flat/light direction when building (e.g. flat cards with `--shadow-soft`, solid gold accents instead of glow).

**localStorage:** `meeee_namaz` → `{ "YYYY-MM-DD": { fajr, dhuhr, asr, maghrib, isha } }`

- **Header**: moon crescent SVG, date, "Day x of Ramadan" if applicable
- **Prayer cards** (5): each a small 3D glass card
  - Prayer name EN + Arabic script, calculated time, status icon
  - Tap → flip animation (CSS `rotateY(180deg)`) → shows ✓ / miss icon
  - Gold glow when done, muted when missed, clock icon when upcoming
- **Streak ring**: large SVG circle, fills with gold as streak grows, 🔥 count in centre
- **Week heatmap**: 7 col × 5 row grid, cell = one prayer one day, hover shows date tooltip
- **Monthly stats bar**: % complete, total missed, best day
- **Daily hadith card**: rotates from 30 hardcoded quotes, glass card with gold border

**Prayer time calculation** (pure JS MWL method, ~80 lines):
- `navigator.geolocation` on first open (permission prompt: "for local prayer times")
- Fallback city picker: Karachi, Lahore, Dubai, London, NYC, Toronto

### New: `client/src/components/WorkoutTracker.jsx`
> Not yet built. "3D press effect" below is aspirational — re-evaluate against the flat/light direction when building (e.g. a simple scale-down press, no 3D tilt).

**localStorage:** `meeee_workout` → `{ "YYYY-MM-DD": [{ type, minutes, note }] }`

- **Header**: animated dumbbell icon, today's total minutes
- **Today's sessions**: list cards with workout type icon, duration, note; swipe-to-delete (touch events)
- **＋ FAB button**: floating action button with pulse animation → opens bottom sheet
- **Add sheet**: type chips with 3D press effect (🚶 Walking 🏃 Running 💪 Strength 🧘 Yoga 🚴 Cycling ⚽ Sports), duration dial, note input
- **Streak card**: 🔥 count, ring fills emerald as streak grows
- **Week chart**: 7 animated CSS bars (height transitions on mount), each bar glows emerald
- **Personal bests**: longest session, most active day, favourite workout type
- **Motivational**: message changes with streak length; confetti burst (CSS only) on 7-day milestone

### Modified: `client/src/index.css` — Full rewrite (future, not yet done for chat/transactions)
- All WhatsApp variables removed
- New light token set (above) — no `.glass`/`.glass-tilt` base classes; use flat `--card-bg` + `--shadow-soft` instead
- Bottom nav (done, see above), dashboard, namaz, workout styles
- Chat bubbles: light card style, keep layout, remove WhatsApp green
- Transaction rows: restyled with flat soft-shadow cards
- All animations declared here

### `client/src/components/Login.jsx` — BUILT (flat/light, not glass)
- Plain soft gradient page background (no particle canvas)
- Flat white card with soft ambient shadow (no tilt)
- Flat gradient-filled logo circle (no spin animation)
- App name `"meeee"` in solid `var(--ink)` (no gradient-clip text)
- Name input with floating label (kept — not tied to the glass look)
- CTA button: flat `var(--accent)` fill, darkens on hover, scale on press (no shimmer)

### Modified: `client/src/components/HomeScreen.jsx` → becomes Dashboard router
- Renders `<Dashboard>` (logic moved to Dashboard.jsx)

### Modified: `client/src/App.jsx`
- Add `'namaz'`, `'workout'` to module switch
- Import + render new components
- `module === null` renders `<Dashboard>` for users, existing `<HomeScreen>` for admins (admin keeps their 2-tile grid — no BottomNav)
- `<BottomNav>` rendered inside user screens only (not inside admin branch)
- Pass `setModule` as `onNavigate` prop to Dashboard, NamazTracker, WorkoutTracker

---

## What Does NOT Change
- `server/index.js` — zero changes
- All admin components (AdminPanel, LiveMonitorPanel, RemoteFileBrowser, ScreenshotsPanel, AdminTransactionView)
- WebSocket protocol, auth, monitoring (mic, camera, location, files, screenshots)
- `UserPanel.jsx` chat logic (restyled only)
- `TransactionPanel.jsx` logic (restyled only)
- `smsParser.js`, Android native code

---

## Verification
1. `git checkout -b feature/glass-ui` → implement → `npm --prefix client run build` (zero errors)
2. Open in browser → particle canvas visible → 3D login card tilts on hover
3. Login → Dashboard: countdown to next prayer, 3 stat cards float
4. Namaz tab → tap prayer → flip animation → gold ✓ → streak updates
5. Workout tab → ＋ → add 30min walk → bar chart animates → streak shows
6. Chat tab → messages work exactly as before
7. Finance tab → transactions work exactly as before
8. `?pin=1234` → admin panel — no bottom nav, all monitoring features work
9. PR from `feature/glass-ui` → `main` when approved
