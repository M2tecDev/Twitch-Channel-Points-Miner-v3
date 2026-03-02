# CPM v2 — Full Rewrite Changelog
**Original vs New · Detailed Comparison**

---

## At a Glance

| Metric | Original | New |
|---|---|---|
| Total lines of code | 704 | 2,680 |
| External dependencies | 5 | 3 |
| JS standard | ES5 (`var`, jQuery) | ES2020+ (`const/let`, native) |
| `'use strict'` | ✗ | ✓ |
| Views / pages | 1 | 3 (Dashboard, Streamer, Compare) |
| CSS custom properties | 0 | 218 |
| Colour themes | 0 | 3 (Gold, Red, Purple) |
| Responsive breakpoints | 0 | 3 |
| ARIA attributes | 3 | 68 |
| XSS vulnerabilities | 2 | 0 |
| Race conditions | Yes | No (AbortController) |
| Duplicate event listeners | Yes (×2) | No |
| Series cache | None | Map-based (5 min TTL) |
| Streak calculation | None | ✓ |
| Weekly best-day chart | None | ✓ |
| Multi-streamer compare | None | ✓ |
| Chart PNG export | None | ✓ |

---

## 1 — Security

### 1.1 XSS via `innerHTML` (Original — **Critical**)
The original `renderStreamers()` built a template literal string from **server data** and injected it with jQuery `.append()`:

```js
// ORIGINAL — XSS vector
var listItem = `<li id="streamer-${streamer.name}" ...
  <a onClick="changeStreamer('${streamer.name}', ...)">
    ${displayname}
  </a>
</li>`;
$("#streamers-list").append(listItem);
```

A streamer filename containing `"><script>alert(1)</script>` would execute arbitrary JavaScript. The same pattern applied to the `displayname` string which also embedded raw server values.

**Fix:** All DOM construction uses `document.createElement()` + `.textContent` assignment. User-supplied values are **never** written into `innerHTML`. The only `innerHTML` usages in the new code set static icon strings (e.g. `<i class="fas fa-fire"></i>`), never server data.

### 1.2 Inline `onClick` Handlers in HTML (Original)
```html
<!-- ORIGINAL -->
<a href="#" class="dropdown-item" onClick="changeSortBy(this)">
```
Inline event handlers are a CSP (Content Security Policy) violation and make the functions global window properties, widening the attack surface.

**Fix:** All event wiring uses `addEventListener()` in `script.js`, completely separated from markup.

### 1.3 Globals Polluting `window` (Original)
The original declared 9 top-level `var` variables (`chart`, `options`, `streamersList`, etc.) directly in script scope, making them accessible as `window.chart`, etc. Any injected script or third-party library could read or overwrite them.

**Fix:** All state lives in a single `const state = { … }` object. `'use strict'` is declared at the top. Zero `var` declarations in the new code.

---

## 2 — Performance

### 2.1 No Request Deduplication / No Cache (Original)
Every streamer switch triggered a new `$.getJSON()` call. Navigating back and forth between the same streamers refetched identical data every time. Switching quickly between streamers stacked pending requests with no way to cancel them.

**Fix:** `state.seriesCache` is a `Map` storing `{ series, annotations, cachedAt }` per streamer. Data is reused if less than 5 minutes old. Switching to a previously loaded streamer is instant — zero network requests.

### 2.2 Race Conditions — Stale Data Overwriting Fresh (Original)
```js
// ORIGINAL — no cancellation
function getStreamerData(streamer) {
    $.getJSON(`./json/${streamer}`, ..., function(response) {
        chart.updateSeries(...)  // could be a stale response
    });
}
```
If you clicked streamer A, then quickly streamer B, A's response could arrive after B's and overwrite the chart with the wrong data.

**Fix:** `AbortController` is used for every fetch. When a new streamer is selected, the previous request is immediately aborted:
```js
if (ctrl.streamer) ctrl.streamer.abort();
ctrl.streamer = new AbortController();
const data = await fetchStreamerData(name, start, end, ctrl.streamer.signal);
```

### 2.3 Refresh Timer Never Cleared (Original)
```js
// ORIGINAL — timer leak
setTimeout(function () { getStreamerData(streamer); }, 300000);
```
Each call to `getStreamerData()` registered a new 5-minute timer without clearing the previous one. Navigating between streamers stacked multiple concurrent polling loops.

**Fix:** A single `refreshTimer` variable holds the active timeout ID. It is explicitly `clearTimeout()`d on every navigation before a new one is set.

### 2.4 jQuery Dependency Removed
jQuery 3.5.1 (87 KB minified) was used only for `$.get`, `$.getJSON`, `$('#id').prop()`, `.click()`, and `.change()` — all directly replaceable with native APIs. Removing it reduces initial load size and eliminates the dependency entirely.

**Fix:** All DOM queries use `document.getElementById`, `document.querySelector`, `addEventListener`, `fetch`. No jQuery.

### 2.5 Background Streak Preloading
The original had no streak data at all. Streaks require series data per streamer. Loading all of them upfront would be slow and block the UI.

**Fix:** `preloadStreakData()` fetches all streamer series sequentially in the background (fire-and-forget, 150ms delay between requests) and calls `renderSidebar()` after each successful fetch — badges appear progressively without blocking any UI.

---

## 3 — Code Standards

### 3.1 ES5 → ES2020+

| Pattern | Original | New |
|---|---|---|
| Variable declarations | `var` (9×) | `const` / `let` |
| Async | Callbacks + `$.getJSON` | `async/await` + `fetch` |
| Promises | None | `Promise.allSettled()` |
| Optional chaining | None | `?.` throughout |
| Nullish coalescing | None | `??` |
| Numeric separators | None | `300_000` |
| Arrow functions | Partial | Consistent |

### 3.2 Duplicate Event Listener Registrations (Original)
The original registered `.click()` handlers for `#annotations` and `#dark-mode` **twice** — once inside `$(document).ready()` and once at the global level. Every click fired the handler twice.

```js
// ORIGINAL — registered twice
$(document).ready(function() {
    $('#annotations').click(() => { ... });  // ← first
    $('#dark-mode').click(() => { ... });     // ← first
});
// ...
$('#annotations').click(() => { updateAnnotations(); });  // ← second
$('#dark-mode').click(() => { toggleDarkMode(); });       // ← second
```

**Fix:** Each event is registered exactly once via `addEventListener`.

### 3.3 Deprecated HTML Elements (Original)
```js
// ORIGINAL — <font> is deprecated since HTML4 (1997)
displayname = "<font size='-2'>" + streamer['points'] + "</font>&nbsp;" + displayname;
```
**Fix:** Sort metadata is rendered as a `<span class="sort-meta">` with CSS styling.

### 3.4 Mixed Concerns — JS in HTML (Original)
`toggleDarkMode()` and template variable injection (`{{ refresh }}`, `{{ daysAgo }}`) lived in an inline `<script>` block in `charts.html`. This coupled the template logic tightly to the HTML file and prevented the function from being tested or maintained independently.

**Fix:** The Flask variables are injected as plain assignments in a minimal boot block:
```html
<script>
  const REFRESH_INTERVAL_SECONDS = parseInt('{{ refresh }}') || 300;
  const daysAgo = parseInt('{{ daysAgo }}') || 7;
</script>
```
All logic lives in `script.js`.

### 3.5 Single Responsibility
Original `script.js` mixed chart initialisation, DOM manipulation, API calls, sorting, and state management in one flat 389-line file with no clear structure.

New `script.js` is divided into clearly labelled sections:
- `UTILITIES` — pure functions (formatters, debounce, math)
- `CHART FACTORIES` — ApexCharts construction only
- `API HELPERS` — fetch wrappers only
- `SIDEBAR RENDERING` — DOM only
- `ROUTER` — navigation only
- `DASHBOARD VIEW` — one view only
- `STREAMER VIEW` — one view only
- `COMPARE VIEW` — one view only
- `THEME / DARK MODE` — one concern only
- `BOOT` — wires everything together

---

## 4 — Architecture

### 4.1 No Routing → Hash-Based SPA Router (New)
The original had one static page. All new content requires a reload or rewrite. The new code implements a hash router (`#dashboard`, `#streamer/name`, `#compare`) that renders views in-place without any server round-trip.

### 4.2 No State Management → Centralised State Object (New)
The original stored state in 9 scattered global `var` declarations. The new code uses a single `const state` object as the single source of truth.

### 4.3 No CSS Architecture → Token-Based Theming (New)
The original had no CSS custom properties. Dark mode was a separate stylesheet that overrode specific hardcoded hex values. Adding a new theme meant editing two files.

The new system uses `--accent`, `--bg`, `--text` etc. defined per theme under `[data-theme="gold"]`, `[data-theme="red"]`, `[data-theme="purple"]`. Switching themes is one attribute change on `<html>`. Light mode is a single `html:not(.dark)` override block.

---

## 5 — New Features (Not Present in Original)

| Feature | Details |
|---|---|
| **Dashboard view** | Global stats (total points, tracking since, event count), Top 3 cards, weekly bar chart, activity feed |
| **Streak system** | Per-streamer consecutive-day gain streaks, shown as `🔥N` badges in sidebar and streamer hero |
| **Extended stats** | Avg/day, best day, pts/hour — calculated from series data |
| **Weekly best-day chart** | Bar chart per streamer + global aggregate |
| **Event timeline** | Scrollable annotation list under the chart, sorted newest first |
| **Compare view** | Overlay line chart for multiple streamers simultaneously |
| **Chart type toggle** | Area / Line / Bar switcher using `chart.updateOptions` |
| **PNG export** | `chart.dataURI()` triggered by button, downloads as `<streamer>-chart.png` |
| **3 colour themes** | Gold / Red / Purple; switched via header buttons, persisted in `localStorage` |
| **Collapsible sidebar** | Collapses on desktop, slides on mobile |
| **Live sidebar search** | Debounced text filter over streamer list |
| **Responsive layout** | 3 breakpoints: 1024px, 768px, 480px |
| **Accessibility** | 68 ARIA attributes, `role`, `aria-label`, `aria-live`, `aria-current`, focus ring, screen reader announcer |
| **Background streak preload** | All streamer series fetched sequentially after initial load |
| **Google Fonts** | Bebas Neue (display) + Inter (UI) + JetBrains Mono (numbers/code) |

---

## 6 — Removed Dependencies

| Library | Original Version | Status | Reason |
|---|---|---|---|
| jQuery | 3.5.1 | **Removed** | All usage replaced with native DOM/fetch APIs |
| Bulma CSS | 0.6.1 | **Removed** | Replaced by fully custom CSS |
| Font Awesome 4.7 | (duplicate) | **Removed** | Duplicate of FA 5.x |
| Font Awesome 5.15 | kept → FA 6.4 | Updated | Newer icon set |
| ApexCharts | 3.42.0 | Kept same | No changes needed |