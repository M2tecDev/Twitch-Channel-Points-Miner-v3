// ============================================================
//  Twitch CPM v2 — script.js   (full rewrite)
//
//  Architecture:
//  ─ Hash-based SPA router  (#dashboard · #streamer/name · #compare)
//  ─ Centralised app state  (no scattered globals)
//  ─ Series cache (Map)     (avoids redundant API calls)
//  ─ Separate chart instances per slot (destroyed on view change)
//  ─ AbortController per active fetch  (no race conditions)
//  ─ Pure DOM / createElement         (XSS-safe throughout)
//  ─ Three colour themes via data-theme on <html>
//  ─ Streak calculator, weekly aggregator, annotation timeline
//  ─ Multi-streamer compare view
// ============================================================

'use strict';

// ── Constants ────────────────────────────────────────────────
const REFRESH_INTERVAL = Math.max(
    (typeof REFRESH_INTERVAL_SECONDS !== 'undefined' ? REFRESH_INTERVAL_SECONDS : 300),
    30
) * 1000;

const DAYS_BACK = (typeof daysAgo !== 'undefined' && daysAgo > 0) ? daysAgo : 7;

const VALID_SORTS = [
    'Name ascending', 'Name descending',
    'Points ascending', 'Points descending',
    'Last activity ascending', 'Last activity descending'
];

// ── App State ─────────────────────────────────────────────────
const state = {
    view:           'dashboard',
    streamer:       null,           // active streamer (string|null)
    streamersList:  [],             // [{name, points, last_activity}]
    sortBy:         'Name ascending',
    searchQuery:    '',
    compareSet:     new Set(),      // names selected for compare view
    seriesCache:    new Map(),      // name → {series, annotations, cachedAt}
    darkMode:       true,
    theme:          'gold',
    startDate:      null,           // Date
    endDate:        null,           // Date
};

// ── Per-slot chart instances ──────────────────────────────────
const charts = {
    main:            null,  // streamer area/line/bar chart
    weeklyGlobal:    null,  // dashboard weekly bar
    weeklyStreamer:  null,  // streamer weekly bar
    compare:         null,  // compare overlay chart
};

// ── Active fetch controllers ──────────────────────────────────
const ctrl = {
    streamer: null,   // AbortController for streamer data fetch
};

// ── Timers ────────────────────────────────────────────────────
let refreshTimer = null;

// ─────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────

/** Announce to screen readers via aria-live region */
function announce(msg) {
    const el = document.getElementById('status-announcer');
    if (!el) return;
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = msg; });
}

/** Debounce — fires fn after ms idle */
function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Format Date → 'YYYY-MM-DD' */
function fmtDate(d) {
    const p = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

/** Format timestamp (ms) → 'DD MMM HH:mm' */
function fmtTs(ts) {
    return new Date(ts).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
}

/** Readable number → '1,234,567' */
const fmt = n => Number(n).toLocaleString();

/** Compute accent colour string from current theme */
function accentColor() {
    return getComputedStyle(document.documentElement)
        .getPropertyValue('--accent').trim() || '#d4a017';
}
function accentAlt() {
    return getComputedStyle(document.documentElement)
        .getPropertyValue('--accent2').trim() || '#c0392b';
}

/**
 * Current streak: consecutive calendar days with net gain
 * going backwards from the most recent day in series.
 */
function calcStreak(series) {
    if (!series || series.length < 2) return 0;

    // Build day → {first, last} point map
    const dayMap = new Map();
    series.forEach(pt => {
        const key = new Date(pt.x).toISOString().slice(0, 10);
        if (!dayMap.has(key)) dayMap.set(key, { first: pt.y, last: pt.y });
        else dayMap.get(key).last = pt.y;
    });

    const days = [...dayMap.entries()]
        .map(([k, { first, last }]) => ({ key: k, gain: last - first }))
        .sort((a, b) => a.key.localeCompare(b.key));

    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].gain <= 0) break;
        if (i < days.length - 1) {
            const d1 = new Date(days[i].key);
            const d2 = new Date(days[i + 1].key);
            if ((d2 - d1) / 86_400_000 > 1.5) break; // gap > 1 day
        }
        streak++;
    }
    return streak;
}

/**
 * Aggregate average gain per weekday (0=Sun … 6=Sat)
 * Returns array [sun, mon, tue, wed, thu, fri, sat]
 */
function weeklyAgg(series) {
    const totals = new Array(7).fill(0);
    const counts = new Array(7).fill(0);

    // Build day map
    const dayMap = new Map();
    series.forEach(pt => {
        const key = new Date(pt.x).toISOString().slice(0, 10);
        if (!dayMap.has(key)) dayMap.set(key, { first: pt.y, last: pt.y });
        else dayMap.get(key).last = pt.y;
    });

    dayMap.forEach(({ first, last }, key) => {
        const gain = last - first;
        if (gain === 0) return;
        const dow = new Date(key).getDay();
        totals[dow] += gain;
        counts[dow]++;
    });

    return totals.map((t, i) => counts[i] > 0 ? Math.round(t / counts[i]) : 0);
}

/**
 * Extended stats from series data
 */
function calcStats(series) {
    if (!series || series.length < 2) return null;

    const current = series[series.length - 1].y;
    const first   = series[0].y;
    const gained  = current - first;

    // Per-day gains
    const dayMap = new Map();
    series.forEach(pt => {
        const key = new Date(pt.x).toISOString().slice(0, 10);
        if (!dayMap.has(key)) dayMap.set(key, { first: pt.y, last: pt.y });
        else dayMap.get(key).last = pt.y;
    });

    const dayGains = [...dayMap.values()].map(v => v.last - v.first);
    const activeDays = dayGains.filter(g => g !== 0);
    const avgDay  = activeDays.length > 0
        ? Math.round(activeDays.reduce((s, v) => s + v, 0) / activeDays.length) : 0;
    const bestDay = dayGains.length > 0 ? Math.max(...dayGains) : 0;

    // Rate: points / hour based on series timespan
    const spanHours = (series[series.length - 1].x - series[0].x) / 3_600_000;
    const rate      = spanHours > 0 ? Math.round(gained / spanHours) : 0;

    return { current, gained, avgDay, bestDay, rate };
}

// ─────────────────────────────────────────────────────────────
//  CHART FACTORIES
// ─────────────────────────────────────────────────────────────

function destroyChart(key) {
    if (charts[key]) { try { charts[key].destroy(); } catch {} charts[key] = null; }
}

/** Base ApexCharts options shared across all charts */
function baseChartOpts() {
    const dark = state.darkMode;
    return {
        chart: { background: 'transparent', foreColor: dark ? '#9a9080' : '#666', toolbar: { autoSelected: 'zoom' } },
        grid:  { borderColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)', strokeDashArray: 4 },
        tooltip: { theme: dark ? 'dark' : 'light' },
    };
}

/** Create/recreate the main streamer chart */
function initMainChart(type = 'area') {
    destroyChart('main');
    const accent  = accentColor();
    const accent2 = accentAlt();
    const dark    = state.darkMode;

    const opts = {
        ...baseChartOpts(),
        series: [],
        chart: {
            ...baseChartOpts().chart,
            type: type === 'area' ? 'area' : type,
            height: 420,
            zoom: { type: 'x', enabled: true, autoScaleYaxis: true },
        },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth', width: 2, colors: [accent] },
        markers: { size: 0 },
        colors: [accent],
        fill: {
            type: 'gradient',
            gradient: {
                shadeIntensity: 1, inverseColors: false,
                opacityFrom: 0.32, opacityTo: 0,
                // Single accent colour with decreasing opacity — no accent2 bleed
                colorStops: [
                    { offset: 0,   color: accent, opacity: 0.32 },
                    { offset: 70,  color: accent, opacity: 0.06 },
                    { offset: 100, color: accent, opacity: 0 }
                ]
            }
        },
        yaxis: {
            title: { text: 'Points', style: { fontFamily: "'Inter',sans-serif", color: '#5a5550' } },
            labels: { formatter: v => fmt(v), style: { colors: dark ? '#9a9080' : '#666' } }
        },
        xaxis: {
            type: 'datetime',
            labels: { datetimeUTC: false, style: { colors: dark ? '#9a9080' : '#666' } }
        },
        tooltip: {
            ...baseChartOpts().tooltip,
            shared: false,
            x: { show: true, format: 'HH:mm dd MMM' },
            custom: ({ series, seriesIndex, dataPointIndex, w }) => {
                const pts      = fmt(series[seriesIndex][dataPointIndex]);
                const reason   = (w.globals.seriesZ?.[seriesIndex]?.[dataPointIndex]) || '—';
                // Explicit inline styles — completely independent of CSS cascade
                // so tooltip is always readable in both dark and light mode
                const isDark   = state.darkMode;
                const outerBg  = isDark ? '#1a1a1a' : '#ffffff';
                const titleBg  = isDark ? '#222222' : '#f0f0f0';
                const textCol  = isDark ? '#f0ece4' : '#1a1814';
                const titleCol = accentColor();   // always use active theme accent
                const border   = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.10)';
                return `<div style="background:${outerBg};border:1px solid ${border};border-radius:10px;overflow:hidden;min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,0.5)">
                    <div style="background:${titleBg};padding:7px 12px;font-family:'Inter',sans-serif;font-weight:700;font-size:12px;color:${titleCol};border-bottom:1px solid ${border}">${w.globals.seriesNames[seriesIndex]}</div>
                    <div style="padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;color:${textCol};line-height:1.7">
                        <div><b>Points:</b> ${pts}</div>
                        <div><b>Reason:</b> ${reason}</div>
                    </div>
                </div>`;
            }
        },
        noData: { text: 'Loading…', style: { color: dark ? '#9a9080' : '#666' } },
        title: {
            text: 'Channel points (UTC)',
            align: 'left',
            style: { fontFamily: "'Inter',sans-serif", fontWeight: '700', fontSize: '12px', color: dark ? '#f0ece4' : '#333' }
        }
    };

    charts.main = new ApexCharts(document.querySelector('#chart'), opts);
    charts.main.render();
}

/** Create weekly bar chart in a container element */
function initWeeklyChart(containerId, data, title) {
    const key = containerId === 'chart-weekly-global' ? 'weeklyGlobal' : 'weeklyStreamer';
    destroyChart(key);

    const el = document.getElementById(containerId);
    if (!el) return;

    const accent = accentColor();
    const dark   = state.darkMode;

    // Reorder Sun→Sat to Mon→Sun for display
    const reordered = [1,2,3,4,5,6,0].map(i => data[i]);
    const labels    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    const opts = {
        ...baseChartOpts(),
        series: [{ name: 'Avg. Gain', data: reordered }],
        chart: {
            ...baseChartOpts().chart,
            type: 'bar', height: 200,
            toolbar: { show: false },
            sparkline: { enabled: false }
        },
        plotOptions: {
            bar: { borderRadius: 4, columnWidth: '55%', distributed: true }
        },
        dataLabels: { enabled: false },
        colors: reordered.map(v => v === Math.max(...reordered) || Math.max(...reordered) === 0 ? accent : accentAlt()),
        xaxis: { categories: labels, labels: { style: { colors: dark ? '#9a9080' : '#666', fontSize: '11px' } } },
        yaxis: { labels: { formatter: v => fmt(v), style: { colors: dark ? '#9a9080' : '#666', fontSize: '10px' } } },
        tooltip: {
            theme: dark ? 'dark' : 'light',
            shared: false,
            fillSeriesColor: false,      // prevents bar colour leaking into tooltip bg
            style: {
                fontSize: '12px',
                fontFamily: "'JetBrains Mono', monospace",
            },
            y: { formatter: v => v > 0 ? `+${fmt(v)} pts` : `${fmt(v)} pts` }
        },
        title: { text: title || '', style: { fontSize: '11px', fontFamily: "'Inter',sans-serif", color: dark ? '#7a7470' : '#999' } },
        legend: { show: false }
    };

    charts[key] = new ApexCharts(el, opts);
    charts[key].render();
}

/** Create multi-streamer compare chart */
function initCompareChart(seriesArr) {
    destroyChart('compare');
    const el = document.getElementById('chart-compare');
    if (!el) return;

    const dark   = state.darkMode;
    const colors = [accentColor(), accentAlt(), '#3498db', '#2ecc71', '#e67e22', '#1abc9c'];

    const opts = {
        ...baseChartOpts(),
        series: seriesArr,
        chart: {
            ...baseChartOpts().chart,
            type: 'line', height: 400,
            zoom: { type: 'x', enabled: true },
        },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth', width: 2 },
        colors: colors.slice(0, seriesArr.length),
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, style: { colors: dark ? '#9a9080' : '#666' } } },
        yaxis: { labels: { formatter: v => fmt(v), style: { colors: dark ? '#9a9080' : '#666' } } },
        legend: { show: true, position: 'top', labels: { colors: dark ? '#f0ece4' : '#333' } },
        tooltip: {
            theme: dark ? 'dark' : 'light',
            shared: false,
            fillSeriesColor: false,
            style: { fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" },
            x: { format: 'dd MMM HH:mm' }
        },
        noData: { text: 'No data', style: { color: dark ? '#9a9080' : '#666' } },
    };

    charts.compare = new ApexCharts(el, opts);
    charts.compare.render();
}

// ─────────────────────────────────────────────────────────────
//  API HELPERS
// ─────────────────────────────────────────────────────────────

async function fetchStreamers() {
    const r = await fetch('./streamers');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

async function fetchStreamerData(name, start, end, signal) {
    const p = new URLSearchParams({ startDate: fmtDate(start), endDate: fmtDate(end) });
    const r = await fetch(`./json/${encodeURIComponent(name)}?${p}`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

// ─────────────────────────────────────────────────────────────
//  SIDEBAR RENDERING
// ─────────────────────────────────────────────────────────────

function getSortField(label) {
    if (label.includes('Points'))        return 'points';
    if (label.includes('Last activity')) return 'last_activity';
    return 'name';
}

function getFilteredSorted() {
    const q = state.searchQuery.toLowerCase();
    let list = q
        ? state.streamersList.filter(s => s.name.toLowerCase().includes(q))
        : [...state.streamersList];

    const field = getSortField(state.sortBy);
    const dir   = state.sortBy.includes('ascending') ? 1 : -1;
    list.sort((a, b) => (a[field] > b[field] ? 1 : -1) * dir);
    return list;
}

function renderSidebar() {
    const ul   = document.getElementById('streamers-list');
    const list = getFilteredSorted();
    const field = getSortField(state.sortBy);
    const frag = document.createDocumentFragment();
    const isCompare = state.view === 'compare';

    list.forEach(s => {
        const streak     = (state.seriesCache.get(s.name)?.series)
            ? calcStreak(state.seriesCache.get(s.name).series)
            : 0;
        const isActive   = s.name === state.streamer && !isCompare;
        const inCompare  = state.compareSet.has(s.name);

        const li = document.createElement('li');
        li.dataset.name = s.name;
        if (isActive)   li.classList.add('is-active');
        if (inCompare)  li.classList.add('in-compare');

        const a = document.createElement('a');
        a.href = '#';
        a.setAttribute('aria-current', isActive ? 'page' : 'false');
        a.setAttribute('aria-label', s.name.replace('.json', ''));

        // Comparison check icon
        const check = document.createElement('i');
        check.className = 'fas fa-check compare-check';
        check.setAttribute('aria-hidden', 'true');
        a.appendChild(check);

        // Sort meta badge (points or date)
        if (field === 'points') {
            const sm = document.createElement('span');
            sm.className = 'sort-meta';
            sm.textContent = fmt(s.points);
            a.appendChild(sm);
        } else if (field === 'last_activity') {
            const sm = document.createElement('span');
            sm.className = 'sort-meta';
            sm.textContent = fmtDate(new Date(s.last_activity)).slice(5);
            a.appendChild(sm);
        }

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'streamer-li-name';
        nameSpan.textContent = s.name.replace('.json', '');
        a.appendChild(nameSpan);

        // Streak badge
        if (streak > 0) {
            const badge = document.createElement('span');
            badge.className = 'streak-badge';
            badge.setAttribute('title', `${streak}-day streak`);
            badge.setAttribute('aria-label', `${streak} day streak`);
            badge.textContent = `🔥${streak}`;
            a.appendChild(badge);
        }

        li.appendChild(a);
        frag.appendChild(li);
    });

    ul.innerHTML = '';
    ul.appendChild(frag);

    // Scroll active item into view
    ul.querySelector('.is-active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─────────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────────

function parseRoute() {
    const h = location.hash || '#dashboard';
    if (h.startsWith('#streamer/')) {
        return { view: 'streamer', param: decodeURIComponent(h.slice(10)) };
    }
    if (h === '#compare') return { view: 'compare' };
    return { view: 'dashboard' };
}

function navigate(path) {
    location.hash = path;
}

function showView(id) {
    ['view-dashboard','view-streamer','view-compare'].forEach(v => {
        const el = document.getElementById(v);
        if (el) el.hidden = (v !== id);
    });
}

async function router() {
    const route   = parseRoute();
    const prevView = state.view;
    state.view    = route.view;

    // Clear compare selection when leaving compare view so tick icons
    // don't bleed into dashboard or streamer sidebar
    if (prevView === 'compare' && route.view !== 'compare') {
        state.compareSet.clear();
    }

    // Update nav active state
    document.querySelectorAll('.nav-link').forEach(a => {
        a.classList.toggle('is-active', a.dataset.view === route.view);
    });

    // Show/hide compare hint in sidebar
    const hint = document.getElementById('compare-hint');
    if (hint) hint.hidden = (route.view !== 'compare');

    clearTimeout(refreshTimer);

    switch (route.view) {
        case 'dashboard': await renderDashboard(); break;
        case 'streamer':  await renderStreamer(route.param); break;
        case 'compare':   await renderCompare(); break;
    }
    // renderSidebar() is called at the end of each view renderer — no double-call here
}

// ─────────────────────────────────────────────────────────────
//  DASHBOARD VIEW
// ─────────────────────────────────────────────────────────────

async function renderDashboard() {
    showView('view-dashboard');

    const ts = new Date().toLocaleTimeString('en-GB');
    const lup = document.getElementById('dash-last-updated');
    if (lup) lup.textContent = `Updated ${ts}`;

    // Basic stats from list
    const total = state.streamersList.reduce((s, v) => s + (v.points || 0), 0);
    const count = state.streamersList.length;

    setText('ds-total', fmt(total));
    setText('ds-count', String(count));

    // Tracking since: earliest last_activity (rough proxy)
    if (state.streamersList.length > 0) {
        const earliest = state.streamersList.reduce((m, s) =>
            s.last_activity < m ? s.last_activity : m, state.streamersList[0].last_activity);
        setText('ds-since', fmtDate(new Date(earliest)));
    }

    // Count cached annotations as "events"
    let eventCount = 0;
    state.seriesCache.forEach(d => { eventCount += (d.annotations?.length || 0); });
    setText('ds-events', String(eventCount));

    // Top 3
    renderTop3();

    // Fetch top 3 streamers data if not cached (for weekly chart)
    const top3 = [...state.streamersList]
        .sort((a, b) => b.points - a.points)
        .slice(0, 3);

    await Promise.allSettled(top3.map(s => ensureSeriesCache(s.name)));

    // Weekly global chart (aggregate all cached series)
    let combined = [];
    state.seriesCache.forEach(d => { combined = combined.concat(d.series || []); });

    if (combined.length > 0) {
        const agg = weeklyAgg(combined);
        initWeeklyChart('chart-weekly-global', agg, 'Avg. gain per weekday');
    }

    // Activity feed from cached annotations
    renderActivityFeed();

    renderSidebar();

    // Auto-refresh
    refreshTimer = setTimeout(renderDashboard, REFRESH_INTERVAL);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function renderTop3() {
    const grid = document.getElementById('top3-grid');
    if (!grid) return;

    const top3 = [...state.streamersList]
        .sort((a, b) => b.points - a.points)
        .slice(0, 3);

    const frag = document.createDocumentFragment();
    ['rank-1','rank-2','rank-3'].forEach((cls, i) => {
        const s = top3[i];
        if (!s) return;
        const streak = (state.seriesCache.get(s.name)?.series)
            ? calcStreak(state.seriesCache.get(s.name).series) : 0;

        const card = document.createElement('div');
        card.className = `top3-card ${cls}`;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Go to ${s.name.replace('.json','')}`);
        card.addEventListener('click', () => navigate(`#streamer/${encodeURIComponent(s.name)}`));
        card.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(`#streamer/${encodeURIComponent(s.name)}`); });

        const rank  = document.createElement('div');
        rank.className = 'top3-rank';
        rank.setAttribute('aria-hidden', 'true');
        rank.textContent = `#${i+1}`;

        const name = document.createElement('div');
        name.className = 'top3-name';
        name.textContent = s.name.replace('.json', '');

        const pts = document.createElement('div');
        pts.className = 'top3-points';
        pts.textContent = fmt(s.points);

        const pLabel = document.createElement('div');
        pLabel.className = 'top3-pts-label';
        pLabel.textContent = 'Points';

        card.appendChild(rank);
        card.appendChild(name);
        card.appendChild(pts);
        card.appendChild(pLabel);

        if (streak > 0) {
            const strk = document.createElement('div');
            strk.className = 'top3-streak';
            strk.innerHTML = `<i class="fas fa-fire" aria-hidden="true"></i> ${streak}-day streak`;
            card.appendChild(strk);
        }

        frag.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(frag);
}

function renderActivityFeed() {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    // Collect all annotations with streamer name
    const items = [];
    state.seriesCache.forEach((data, name) => {
        (data.annotations || []).forEach(a => {
            items.push({ streamer: name.replace('.json',''), ts: a.x, label: a.label?.text || '—', y: a.y });
        });
    });

    if (items.length === 0) {
        feed.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'feed-empty';
        empty.innerHTML = '<i class="fas fa-satellite-dish"></i><span>No events cached yet</span>';
        feed.appendChild(empty);
        return;
    }

    // Sort newest first, take last 30
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const shown = items.slice(0, 30);

    const frag = document.createDocumentFragment();
    shown.forEach(item => {
        const div = document.createElement('div');
        div.className = 'feed-item';

        const icon = document.createElement('div');
        icon.className = 'feed-icon';
        icon.innerHTML = '<i class="fas fa-bolt" aria-hidden="true"></i>';

        const content = document.createElement('div');
        content.className = 'feed-content';

        const streamer = document.createElement('div');
        streamer.className = 'feed-streamer';
        streamer.textContent = item.streamer;

        const reason = document.createElement('div');
        reason.className = 'feed-reason';
        reason.textContent = item.label;

        const time = document.createElement('div');
        time.className = 'feed-time';
        time.textContent = item.ts ? fmtTs(item.ts) : '—';

        content.appendChild(streamer);
        content.appendChild(reason);
        content.appendChild(time);
        div.appendChild(icon);
        div.appendChild(content);
        frag.appendChild(div);
    });

    feed.innerHTML = '';
    feed.appendChild(frag);
}

// ─────────────────────────────────────────────────────────────
//  STREAMER VIEW
// ─────────────────────────────────────────────────────────────

async function renderStreamer(name) {
    if (!name) { navigate('#dashboard'); return; }
    state.streamer = name;
    showView('view-streamer');

    const label = name.replace('.json', '');
    setText('streamer-name-heading', label);
    document.title = `${label} — CPM v2`;
    announce(`Loaded streamer: ${label}`);

    // Set dates if not set
    if (!state.startDate) {
        state.startDate = new Date();
        state.startDate.setDate(state.startDate.getDate() - DAYS_BACK);
    }
    if (!state.endDate) state.endDate = new Date();

    const sd = document.getElementById('startDate');
    const ed = document.getElementById('endDate');
    if (sd) sd.value = fmtDate(state.startDate);
    if (ed) ed.value = fmtDate(state.endDate);

    // Init chart (area default)
    const typeBtn = document.querySelector('.chart-type-btn.is-active');
    const chartType = typeBtn?.dataset.type || 'area';
    initMainChart(chartType);

    const card = document.getElementById('streamer-chart-card');

    // Abort any running fetch
    if (ctrl.streamer) ctrl.streamer.abort();
    ctrl.streamer = new AbortController();

    if (card) card.classList.add('is-loading');

    try {
        const data = await fetchStreamerData(name, state.startDate, state.endDate, ctrl.streamer.signal);
        ctrl.streamer = null;

        // Cache
        state.seriesCache.set(name, {
            series:      data.series || [],
            annotations: (data.annotations || []).map((a,i) => ({ ...a, id: `a${i}` })),
            cachedAt:    Date.now(),
        });

        updateMainChart(name, data);
        updateStreamerStats(name, data);
        renderAnnotationTimeline(data.annotations || []);

        // Weekly chart
        if (data.series && data.series.length > 0) {
            const agg = weeklyAgg(data.series);
            initWeeklyChart('chart-weekly-streamer', agg);
        }

        // Meta badges (streak etc.)
        renderStreamerBadges(name, data.series || []);

        if (card) card.classList.remove('is-loading');

        // Auto-refresh
        refreshTimer = setTimeout(() => renderStreamer(name), REFRESH_INTERVAL);

    } catch (err) {
        if (err.name === 'AbortError') return;
        ctrl.streamer = null;
        if (card) card.classList.remove('is-loading');
        if (charts.main) charts.main.updateOptions({ noData: { text: 'Failed to load — retrying in 15s' } });
        announce('Failed to load streamer data. Retrying in 15 seconds.');
        refreshTimer = setTimeout(() => renderStreamer(name), 15_000);
    }

    renderSidebar(); // update streak badges
}

function updateMainChart(name, data) {
    if (!charts.main) return;
    const label = name.replace('.json', '');

    charts.main.updateSeries([{
        name: label,
        data: data.series || []
    }], true);

    charts.main.updateOptions({
        title: { text: `${label}'s channel points (UTC)` }
    });

    updateAnnotations(data.annotations || []);
}

function updateAnnotations(annotations) {
    if (!charts.main) return;
    charts.main.clearAnnotations();

    const show = document.getElementById('annotations')?.checked ?? true;
    if (!show) return;

    annotations.forEach(a => charts.main.addXaxisAnnotation(a, true));
}

function updateStreamerStats(name, data) {
    const stats = calcStats(data.series || []);
    if (!stats) return;

    setText('s-current',  fmt(stats.current));
    setText('s-avg-day',  fmt(stats.avgDay));
    setText('s-best-day', fmt(stats.bestDay));
    setText('s-rate',     fmt(stats.rate) + '/h');

    const gainEl = document.getElementById('s-gained');
    if (gainEl) {
        gainEl.textContent = (stats.gained >= 0 ? '+' : '') + fmt(stats.gained);
        gainEl.classList.toggle('is-negative', stats.gained < 0);
    }
}

function renderStreamerBadges(name, series) {
    const container = document.getElementById('streamer-meta-badges');
    if (!container) return;

    const streak = calcStreak(series);
    const cached = state.seriesCache.get(name);

    const badges = [];

    if (streak > 0) {
        badges.push({ icon: '🔥', label: `${streak}-day streak`, cls: 'is-streak' });
    }
    if (cached?.annotations?.length > 0) {
        badges.push({ icon: '⚡', label: `${cached.annotations.length} events` });
    }

    const frag = document.createDocumentFragment();
    badges.forEach(b => {
        const span = document.createElement('span');
        span.className = `meta-badge ${b.cls || ''}`;
        span.textContent = `${b.icon} ${b.label}`;
        frag.appendChild(span);
    });

    container.innerHTML = '';
    container.appendChild(frag);
}

function renderAnnotationTimeline(annotations) {
    const tl = document.getElementById('annotation-timeline');
    if (!tl) return;

    if (annotations.length === 0) {
        tl.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'timeline-empty';
        empty.innerHTML = '<i class="fas fa-calendar-xmark"></i><span>No events in selected range</span>';
        tl.appendChild(empty);
        return;
    }

    const sorted = [...annotations].sort((a, b) => (b.x || 0) - (a.x || 0));
    const frag = document.createDocumentFragment();

    sorted.forEach(a => {
        const item = document.createElement('div');
        item.className = 'timeline-item';

        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        dot.setAttribute('aria-hidden', 'true');

        const body = document.createElement('div');
        body.className = 'timeline-body';

        const time = document.createElement('div');
        time.className = 'timeline-time';
        time.textContent = a.x ? fmtTs(a.x) : '—';

        const label = document.createElement('div');
        label.className = 'timeline-label';
        label.textContent = a.label?.text || a.borderColor || '—';

        body.appendChild(time);
        body.appendChild(label);
        item.appendChild(dot);
        item.appendChild(body);
        frag.appendChild(item);
    });

    tl.innerHTML = '';
    tl.appendChild(frag);
}

// ─────────────────────────────────────────────────────────────
//  COMPARE VIEW
// ─────────────────────────────────────────────────────────────

async function renderCompare() {
    showView('view-compare');
    document.title = 'Compare — CPM v2';

    const names  = [...state.compareSet];
    const empty  = document.getElementById('compare-empty');
    const statsG = document.getElementById('compare-stats-grid');

    if (names.length < 2) {
        if (empty) empty.hidden = false;
        destroyChart('compare');
        if (statsG) statsG.innerHTML = '';
        return;
    }
    if (empty) empty.hidden = true;

    // Ensure cache for all selected
    await Promise.allSettled(names.map(n => ensureSeriesCache(n)));

    // Build series array
    const seriesArr = names
        .map(n => ({
            name: n.replace('.json',''),
            data: state.seriesCache.get(n)?.series || []
        }))
        .filter(s => s.data.length > 0);

    if (seriesArr.length < 2) {
        if (empty) { empty.hidden = false; }
        return;
    }

    initCompareChart(seriesArr);

    // Stats per streamer
    if (statsG) {
        const frag = document.createDocumentFragment();
        names.forEach((n, i) => {
            const s = state.seriesCache.get(n);
            const stats = s ? calcStats(s.series) : null;

            const card = document.createElement('div');
            card.className = 'stat-card s-dim';
            card.style.setProperty('--accent', COMPARE_COLORS[i] || accentColor());

            const label = document.createElement('div');
            label.className = 'stat-label';
            label.textContent = n.replace('.json','');

            const val = document.createElement('div');
            val.className = 'stat-val';
            val.textContent = stats ? fmt(stats.current) : '--';

            card.appendChild(label);
            card.appendChild(val);
            frag.appendChild(card);
        });
        statsG.innerHTML = '';
        statsG.appendChild(frag);
    }

    renderSidebar();
}

const COMPARE_COLORS = ['#d4a017','#e74c3c','#3498db','#2ecc71','#e67e22','#9b59b6'];

/** Fetch and cache series if not already cached (or stale > 5min) */
async function ensureSeriesCache(name) {
    const cached = state.seriesCache.get(name);
    if (cached && (Date.now() - cached.cachedAt) < 300_000) return;

    const start = state.startDate || (() => {
        const d = new Date(); d.setDate(d.getDate() - DAYS_BACK); return d;
    })();
    const end = state.endDate || new Date();

    try {
        const data = await fetchStreamerData(name, start, end, new AbortController().signal);
        state.seriesCache.set(name, {
            series:      data.series || [],
            annotations: (data.annotations || []).map((a,i) => ({ ...a, id: `a${i}` })),
            cachedAt:    Date.now(),
        });
    } catch {}
}

// ─────────────────────────────────────────────────────────────
//  THEME / DARK MODE
// ─────────────────────────────────────────────────────────────

function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cpm-theme', theme);

    document.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.theme === theme);
    });

    // Full chart re-init is necessary because gradient colorStops are baked at
    // creation time — updateOptions() cannot patch them after the fact.
    if (state.view === 'streamer' && state.streamer) {
        const typeBtn   = document.querySelector('.chart-type-btn.is-active');
        const chartType = typeBtn?.dataset.type || 'area';
        const cached    = state.seriesCache.get(state.streamer);
        initMainChart(chartType);
        if (cached) updateMainChart(state.streamer, cached);

        if (cached?.series?.length > 0) {
            const agg = weeklyAgg(cached.series);
            initWeeklyChart('chart-weekly-streamer', agg);
        }
    }

    if (state.view === 'dashboard') {
        let combined = [];
        state.seriesCache.forEach(d => { combined = combined.concat(d.series || []); });
        if (combined.length > 0) {
            const agg = weeklyAgg(combined);
            initWeeklyChart('chart-weekly-global', agg, 'Avg. gain per weekday');
        }
    }

    if (state.view === 'compare' && state.compareSet.size >= 2) {
        renderCompare();
    }
}

function applyDarkMode(dark) {
    state.darkMode = dark;
    // FIX: must toggle on documentElement (<html>) so "html:not(.dark)" CSS selector works.
    // Toggling on body was the root cause of broken CSS vars and invisible tooltips.
    document.documentElement.classList.toggle('dark', dark);
    const link = document.getElementById('dark-theme-link');
    if (link) link.disabled = !dark;
    localStorage.setItem('cpm-dark', dark ? '1' : '0');

    const fg      = dark ? '#9a9080' : '#666666';
    const gridCol = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';

    // Update ALL active chart instances with full colour set — not just tooltip.theme
    Object.values(charts).forEach(c => {
        if (!c) return;
        try {
            c.updateOptions({
                chart:   { foreColor: fg },
                grid:    { borderColor: gridCol },
                tooltip: { theme: dark ? 'dark' : 'light' },
                xaxis:   { labels: { style: { colors: fg } } },
                yaxis:   { labels: { style: { colors: fg } } },
                legend:  { labels: { colors: dark ? '#f0ece4' : '#333333' } },
            });
        } catch { /* chart may be mid-render */ }
    });
}

// ─────────────────────────────────────────────────────────────
//  STREAMERS LIST LOAD
// ─────────────────────────────────────────────────────────────

async function loadStreamers() {
    try {
        state.streamersList = await fetchStreamers();
        renderSidebar();

        const saved = localStorage.getItem('cpm-streamer');
        const valid = state.streamersList.find(s => s.name === saved);
        if (valid) state.streamer = valid.name;

    } catch (err) {
        console.error('Failed to load streamers list:', err);
        announce('Could not load streamers list.');
    }
}

/**
 * Fetches series for every streamer in the background so streak badges
 * are populated immediately in the sidebar without needing to click each one.
 * Sequential with 150ms gaps to avoid flooding the server.
 */
async function preloadStreakData() {
    const start = state.startDate || (() => {
        const d = new Date(); d.setDate(d.getDate() - DAYS_BACK); return d;
    })();
    const end = state.endDate || new Date();

    for (const s of state.streamersList) {
        if (state.seriesCache.has(s.name)) continue;
        try {
            const ac   = new AbortController();
            const data = await fetchStreamerData(s.name, start, end, ac.signal);
            state.seriesCache.set(s.name, {
                series:      data.series || [],
                annotations: (data.annotations || []).map((a, i) => ({ ...a, id: `a${i}` })),
                cachedAt:    Date.now(),
            });
            // Re-render sidebar after each batch so badges appear progressively
            renderSidebar();
        } catch { /* ignore per-streamer errors — server may not have data yet */ }
        // Small delay between requests — avoids flooding the server
        await new Promise(r => setTimeout(r, 150));
    }
}

// ─────────────────────────────────────────────────────────────
//  LOG
// ─────────────────────────────────────────────────────────────

function initLog() {
    let active     = false;
    let autoUpdate = true;
    let lastIdx    = 0;

    async function poll() {
        if (!active) return;
        try {
            const r = await fetch(`/log?lastIndex=${lastIdx}`);
            if (r.ok) {
                const txt = await r.text();
                if (txt) {
                    const pre = document.getElementById('log-content');
                    if (pre) { pre.append(txt); pre.scrollTop = pre.scrollHeight; }
                    lastIdx += txt.length;
                }
            }
        } catch {}
        if (autoUpdate && active) setTimeout(poll, 1000);
    }

    document.getElementById('log')?.addEventListener('change', function () {
        active = this.checked;
        const box = document.getElementById('log-box');
        if (box) box.hidden = !active;
        if (active) poll();
        localStorage.setItem('cpm-log', active ? '1' : '0');
    });

    document.getElementById('auto-update-log')?.addEventListener('click', function () {
        autoUpdate = !autoUpdate;
        this.textContent = autoUpdate ? '⏸️' : '▶️';
        if (autoUpdate) poll();
    });

    // Restore state
    const saved = localStorage.getItem('cpm-log') === '1';
    const logChk = document.getElementById('log');
    if (saved && logChk) {
        logChk.checked = true;
        active = true;
        const box = document.getElementById('log-box');
        if (box) box.hidden = false;
        poll();
    }
}

// ─────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

    // ── Restore preferences ──────────────────
    const savedTheme = localStorage.getItem('cpm-theme') || 'gold';
    const savedDark  = localStorage.getItem('cpm-dark') !== '0';
    const savedSort  = (() => {
        const s = localStorage.getItem('cpm-sort');
        return VALID_SORTS.includes(s) ? s : 'Name ascending';
    })();

    state.sortBy  = savedSort;
    applyTheme(savedTheme);
    applyDarkMode(savedDark);

    // Sync dark mode toggle
    const dmChk = document.getElementById('dark-mode');
    if (dmChk) dmChk.checked = savedDark;

    // ── Init date range ──────────────────────
    state.endDate   = new Date();
    state.startDate = new Date();
    state.startDate.setDate(state.startDate.getDate() - DAYS_BACK);

    // ── Footer refresh info ──────────────────
    const fri = document.getElementById('footer-refresh-info');
    if (fri) fri.textContent = `Refresh every ${REFRESH_INTERVAL_SECONDS}s`;

    // ── Load streamers ───────────────────────
    await loadStreamers();

    // ── Kick off router ──────────────────────
    await router();
    window.addEventListener('hashchange', () => router());

    // Background-fetch series for all streamers so streak badges
    // are visible immediately — fire-and-forget (no await)
    preloadStreakData();

    // ── Dark mode toggle ─────────────────────
    dmChk?.addEventListener('change', function () { applyDarkMode(this.checked); });

    // ── Theme buttons ────────────────────────
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });

    // ── Sidebar toggle ───────────────────────
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        const sb = document.getElementById('app-sidebar');
        if (!sb) return;
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            sb.classList.toggle('is-open');
        } else {
            sb.classList.toggle('is-collapsed');
        }
    });

    // ── Sidebar search ───────────────────────
    document.getElementById('sidebar-search')?.addEventListener('input', debounce(e => {
        state.searchQuery = e.target.value;
        renderSidebar();
    }, 200));

    // ── Sort dropdown ────────────────────────
    const sortBtn = document.getElementById('sort-btn');
    const sortDd  = document.getElementById('sort-dropdown');
    sortBtn?.addEventListener('click', e => {
        e.stopPropagation();
        const open = !sortDd.hidden;
        sortDd.hidden = open;
    });
    document.addEventListener('click', () => { if (sortDd) sortDd.hidden = true; });
    sortDd?.addEventListener('click', e => {
        const opt = e.target.closest('.sort-opt');
        if (!opt) return;
        const val = opt.dataset.sort;
        if (!VALID_SORTS.includes(val)) return;
        state.sortBy = val;
        localStorage.setItem('cpm-sort', val);
        sortDd.querySelectorAll('.sort-opt').forEach(b => b.classList.toggle('is-active', b.dataset.sort === val));
        sortDd.hidden = true;

        // Update short label
        const short = document.getElementById('sort-label-short');
        if (short) {
            const map = {
                'Name ascending': 'A–Z', 'Name descending': 'Z–A',
                'Points ascending': 'Pts↑', 'Points descending': 'Pts↓',
                'Last activity ascending': 'Old', 'Last activity descending': 'New'
            };
            short.textContent = map[val] || '...';
        }
        renderSidebar();
    });

    // ── Sidebar streamer click (event delegation) ──
    document.getElementById('streamers-list')?.addEventListener('click', e => {
        e.preventDefault();
        const li = e.target.closest('li');
        if (!li?.dataset.name) return;
        const name = li.dataset.name;

        if (state.view === 'compare') {
            // Toggle in compare set
            if (state.compareSet.has(name)) state.compareSet.delete(name);
            else state.compareSet.add(name);
            renderSidebar();
            renderCompare();
        } else {
            state.streamer = name;
            localStorage.setItem('cpm-streamer', name);
            navigate(`#streamer/${encodeURIComponent(name)}`);
        }
    });

    // ── Chart type buttons ───────────────────
    document.querySelectorAll('.chart-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            if (state.view === 'streamer' && state.streamer) {
                const cached = state.seriesCache.get(state.streamer);
                initMainChart(btn.dataset.type);
                if (cached) updateMainChart(state.streamer, cached);
            }
        });
    });

    // ── Export PNG ───────────────────────────
    document.getElementById('btn-export-png')?.addEventListener('click', async () => {
        if (!charts.main) return;
        try {
            const { imgURI } = await charts.main.dataURI();
            const a = document.createElement('a');
            a.href = imgURI;
            a.download = `${(state.streamer || 'chart').replace('.json','')}-chart.png`;
            a.click();
        } catch (err) { console.error('PNG export failed:', err); }
    });

    // ── Annotations toggle ───────────────────
    document.getElementById('annotations')?.addEventListener('change', function () {
        const cached = state.seriesCache.get(state.streamer);
        if (cached) updateAnnotations(cached.annotations || []);
    });

    // ── Date inputs with debounce ─────────────
    const onDateChange = debounce(() => {
        const sv = document.getElementById('startDate')?.value;
        const ev = document.getElementById('endDate')?.value;
        if (sv) state.startDate = new Date(sv);
        if (ev) state.endDate   = new Date(ev);
        if (state.view === 'streamer' && state.streamer) {
            clearTimeout(refreshTimer);
            // Invalidate cache for current streamer so fresh data loads
            state.seriesCache.delete(state.streamer);
            renderStreamer(state.streamer);
        }
    }, 500);
    document.getElementById('startDate')?.addEventListener('change', onDateChange);
    document.getElementById('endDate')?.addEventListener('change', onDateChange);

    // Same for compare date inputs
    const onCompareDateChange = debounce(() => {
        const sv = document.getElementById('startDateCompare')?.value;
        const ev = document.getElementById('endDateCompare')?.value;
        if (sv) state.startDate = new Date(sv);
        if (ev) state.endDate   = new Date(ev);
        // Clear compare cache and re-render
        state.compareSet.forEach(n => state.seriesCache.delete(n));
        renderCompare();
    }, 500);
    document.getElementById('startDateCompare')?.addEventListener('change', onCompareDateChange);
    document.getElementById('endDateCompare')?.addEventListener('change', onCompareDateChange);

    // ── Back button ───────────────────────────
    document.getElementById('back-btn')?.addEventListener('click', () => navigate('#dashboard'));

    // ── Init log ──────────────────────────────
    initLog();
});
/* ─── Safari-safe scroll ─────────────────────────────────────────────────── */
function safeSmoothScroll(el, opts) {
    if (!el) return;
    try { el.scrollIntoView(opts); }
    catch (_) { try { el.scrollIntoView(true); } catch (__) {} }
}

/* ─── weeklyAgg: clamp negatives to 0 ───────────────────────────────────── */
if (typeof weeklyAgg === 'function') {
    var _wkOrig = weeklyAgg;
    weeklyAgg = function(series) {
        var r = _wkOrig(series);
        return r.map(function(v) { return Math.max(0, v || 0); });
    };
}

/* ─── Cache cap (max 30 entries) ─────────────────────────────────────────── */
var _CACHE_MAX = 30;
function _cacheSet(name, value) {
    state.seriesCache.set(name, value);
    if (state.seriesCache.size > _CACHE_MAX) {
        state.seriesCache.delete(state.seriesCache.keys().next().value);
    }
}

/* ─── preloadStreakData: run once, update events count after ─────────────── */
state.preloadDone = false;
if (typeof preloadStreakData === 'function') {
    var _preloadOrig = preloadStreakData;
    preloadStreakData = async function() {
        if (state.preloadDone) return;
        state.preloadDone = true;
        await _preloadOrig();
        if (state.view === 'dashboard') {
            var eventCount = 0;
            state.seriesCache.forEach(function(d) { eventCount += (d.annotations ? d.annotations.length : 0); });
            var el = document.getElementById('ds-events');
            if (el) el.textContent = String(eventCount);
            if (typeof renderActivityFeed === 'function') renderActivityFeed();
            renderSidebar();
        }
    };
}

/* ─── Improved renderAnnotationTimeline ─────────────────────────────────── */
if (typeof renderAnnotationTimeline === 'function') {
    renderAnnotationTimeline = function(annotations) {
        var tl = document.getElementById('annotation-timeline');
        if (!tl) return;
        var COLOR_META = {
            '#36b535': {icon: '🏆', label: 'WIN',    cls: 'tl-win'},
            '#ff4545': {icon: '❌', label: 'LOSE',   cls: 'tl-lose'},
            '#ffe045': {icon: '🎯', label: 'BET',    cls: 'tl-bet'},
            '#45c1ff': {icon: '🔥', label: 'STREAK', cls: 'tl-streak'},
        };
        var valid = (annotations || []).filter(function(a) {
            return a && a.x && (a.borderColor || (a.label && a.label.text));
        });
        if (!valid.length) {
            tl.innerHTML = '<div class="timeline-empty"><i class="fas fa-calendar-xmark"></i><span>No events in selected range</span></div>';
            return;
        }
        var sorted = valid.slice().sort(function(a, b) { return (b.x || 0) - (a.x || 0); });
        var frag   = document.createDocumentFragment();
        sorted.forEach(function(a) {
            var meta = COLOR_META[a.borderColor] || {icon: '⚡', label: 'EVENT', cls: ''};
            var item = document.createElement('div');
            item.className = 'timeline-item ' + meta.cls;
            var dot = document.createElement('div');
            dot.className = 'timeline-dot';
            dot.style.background = a.borderColor || 'var(--accent-b)';
            var body = document.createElement('div');
            body.className = 'timeline-body';
            var timeEl = document.createElement('div');
            timeEl.className = 'timeline-time';
            timeEl.textContent = a.x ? fmtTs(a.x) : '—';
            var labelEl = document.createElement('div');
            labelEl.className = 'timeline-label';
            labelEl.textContent = (a.label && a.label.text) ? a.label.text : meta.label;
            var badge = document.createElement('span');
            badge.className = 'timeline-badge';
            badge.textContent = meta.icon + ' ' + meta.label;
            body.appendChild(timeEl);
            body.appendChild(labelEl);
            body.appendChild(badge);
            item.appendChild(dot);
            item.appendChild(body);
            frag.appendChild(item);
        });
        tl.innerHTML = '';
        tl.appendChild(frag);
    };
}

/* ─── [1+3] parseRoute / showView / router overrides ────────────────────── */
var _pRouteOrig = parseRoute;
parseRoute = function() {
    var h = location.hash || '#dashboard';
    if (h === '#bets')     return {view: 'bets'};
    if (h === '#settings') return {view: 'settings'};
    return _pRouteOrig();
};

var _showViewOrig = showView;
showView = function(id) {
    ['view-dashboard','view-streamer','view-compare','view-bets','view-settings'].forEach(function(v) {
        var el = document.getElementById(v);
        if (el) el.hidden = (v !== id);
    });
};

router = async function() {
    var route    = parseRoute();
    var prevView = state.view;
    state.view   = route.view;

    var shell = document.querySelector('.app-shell');
    if (shell) shell.dataset.currentView = route.view;

    if (prevView === 'compare' && route.view !== 'compare') state.compareSet.clear();

    document.querySelectorAll('.nav-link').forEach(function(a) {
        a.classList.toggle('is-active', a.dataset.view === route.view);
    });
    var hint = document.getElementById('compare-hint');
    if (hint) hint.hidden = (route.view !== 'compare');

    clearTimeout(refreshTimer);

    /* [5] Set page title per view */
    var TITLES = {dashboard: 'Overview', streamer: '', compare: 'Compare', bets: 'Bet History', settings: 'Settings'};

    switch (route.view) {
        case 'dashboard':
            document.title = 'Overview — CPM v2';
            await renderDashboard();
            break;
        case 'streamer':
            await renderStreamer(route.param);
            break;
        case 'compare':
            document.title = 'Compare — CPM v2';
            await renderCompare();
            break;
        case 'bets':
            document.title = 'Bet History — CPM v2';
            await renderBets();
            break;
        case 'settings':
            document.title = 'Settings — CPM v2';
            await renderSettings();
            break;
    }
};

/* ─── [3] Status polling — no false-green dots ───────────────────────────── */
// /status now returns {} when no live miner is running (fixed in AnalyticsServer.py)
// so the sidebar never adds dots when there's no real data.
state.statusMap = {};

async function fetchStatus() {
    try {
        var r = await fetch('./status');
        if (r.ok) {
            state.statusMap = await r.json();
            renderSidebar();
        }
    } catch(e) {}
}
setInterval(fetchStatus, 30000);
fetchStatus();

/* ─── [3] Sidebar dot injection (only when data exists) ─────────────────── */
var _sbOrig = renderSidebar;
renderSidebar = function() {
    _sbOrig();
    var ul = document.getElementById('streamers-list');
    if (!ul) return;
    ul.querySelectorAll('li[data-name]').forEach(function(li) {
        var name  = li.dataset.name;
        var clean = name ? name.replace('.json', '') : '';
        var info  = state.statusMap[clean] || state.statusMap[name];
        // [3] Only add dot if the server actually reported this streamer
        if (!info) return;
        var old = li.querySelector('.status-dot');
        if (old) old.parentNode.removeChild(old);
        var dot = document.createElement('span');
        dot.className = 'status-dot ' + (info.is_online ? 'online' : 'offline');
        dot.title = info.is_online ? 'Online' : 'Offline';
        var a = li.querySelector('a');
        if (a && a.firstChild) a.insertBefore(dot, a.firstChild);
        else if (a) a.appendChild(dot);
    });
};

/* ─── Mobile: sidebar closes after streamer click ────────────────────────── */
document.addEventListener('click', function(e) {
    var li = e.target && e.target.closest ? e.target.closest('#streamers-list li[data-name]') : null;
    if (!li || state.view === 'compare') return;
    if (window.innerWidth < 900) {
        var sb = document.getElementById('app-sidebar');
        if (sb) sb.classList.remove('is-open');
    }
}, true);

/* ─── Gear button in streamer hero ──────────────────────────────────────── */
if (typeof renderStreamer === 'function') {
    var _rsOrig = renderStreamer;
    renderStreamer = async function(name) {
        await _rsOrig(name);
        /* [5] Title already set inside original renderStreamer, keep it */
        var old = document.getElementById('btn-streamer-settings');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var actions = document.querySelector('.streamer-hero-actions');
        if (!actions || !name) return;
        var btn = document.createElement('button');
        btn.id        = 'btn-streamer-settings';
        btn.className = 'btn btn-sm';
        btn.title     = 'Settings for this streamer';
        btn.innerHTML = '<i class="fas fa-sliders"></i>';
        btn.onclick   = function() {
            var clean = name.replace('.json','');
            navigate('#settings');
            setTimeout(function() {
                document.querySelectorAll('.stab').forEach(function(b) {
                    var on = b.dataset.stab === 'streamers';
                    b.classList.toggle('is-active', on);
                    b.setAttribute('aria-selected', String(on));
                });
                document.querySelectorAll('.stab-panel').forEach(function(p) { p.hidden = (p.id !== 'stab-streamers'); });
                var card = document.querySelector('.streamer-setting-card[data-name="' + clean + '"]');
                if (card) {
                    safeSmoothScroll(card, {behavior: 'smooth', block: 'center'});
                    card.classList.add('is-highlighted');
                    setTimeout(function() { card.classList.remove('is-highlighted'); }, 2500);
                }
            }, 350);
        };
        if (actions.firstChild) actions.insertBefore(btn, actions.firstChild);
        else actions.appendChild(btn);
    };
}

/* ─── API helpers ────────────────────────────────────────────────────────── */
async function fetchConfig() {
    var r = await fetch('./config');
    if (!r.ok) throw new Error('GET /config: ' + r.status);
    return r.json();
}
async function saveConfig(data) {
    var r = await fetch('./config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    return r.json();
}
async function apiAddStreamer(username) {
    var r = await fetch('./config/streamer', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:username})});
    return r.json();
}
async function apiRemoveStreamer(username) {
    var r = await fetch('./config/streamer/'+encodeURIComponent(username), {method:'DELETE'});
    return r.json();
}
async function apiPatchStreamer(username, patch) {
    var r = await fetch('./config/streamer/'+encodeURIComponent(username), {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)});
    return r.json();
}

/* ─── Toast + restart banner ─────────────────────────────────────────────── */
function showSettingsToast(msg, isError) {
    var t = document.getElementById('settings-toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = 'settings-toast ' + (isError ? 'is-error' : 'is-ok');
    t.hidden      = false;
    clearTimeout(t._tmr);
    t._tmr = setTimeout(function() { t.hidden = true; }, 4000);
}
function showRestartBanner() {
    var b = document.getElementById('settings-restart-banner');
    if (!b) return;
    b.hidden = false;
    clearTimeout(b._tmr);
    b._tmr = setTimeout(function() { b.hidden = true; }, 15000);
}

/* ─── [4] Password protection for Settings ───────────────────────────────── */
var _settingsUnlocked = false;

function _checkSettingsPassword(config, onSuccess) {
    var pw = (config && config.settings_password) ? config.settings_password.trim() : '';
    if (!pw || _settingsUnlocked) { onSuccess(); return; }

    // Build lock screen overlay if not present
    var overlay = document.getElementById('settings-lock-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id        = 'settings-lock-overlay';
        overlay.className = 'settings-lock-overlay';
        overlay.innerHTML =
            '<div class="settings-lock-box">' +
              '<i class="fas fa-lock settings-lock-icon"></i>' +
              '<h2 class="settings-lock-title">Settings locked</h2>' +
              '<p class="settings-lock-hint">Enter the password to continue</p>' +
              '<input class="input settings-lock-input" id="settings-lock-input" type="password" placeholder="Password…" autocomplete="current-password">' +
              '<button class="btn btn-primary settings-lock-btn" id="settings-lock-btn"><i class="fas fa-unlock"></i> Unlock</button>' +
              '<div class="settings-lock-error" id="settings-lock-error" hidden>Wrong password</div>' +
            '</div>';
        var settingsView = document.getElementById('view-settings');
        if (settingsView) settingsView.insertBefore(overlay, settingsView.firstChild);
    }

    overlay.hidden = false;
    // Hide actual content while locked
    var form = document.getElementById('settings-form-wrap');
    if (form) form.hidden = true;

    var doCheck = function() {
        var inp = document.getElementById('settings-lock-input');
        var val = inp ? inp.value : '';
        if (val === pw) {
            _settingsUnlocked = true;
            overlay.hidden = true;
            if (form) form.hidden = false;
            onSuccess();
        } else {
            var errEl = document.getElementById('settings-lock-error');
            if (errEl) { errEl.hidden = false; setTimeout(function(){ errEl.hidden = true; }, 2000); }
            if (inp) { inp.value = ''; inp.focus(); }
        }
    };

    var btn = document.getElementById('settings-lock-btn');
    if (btn) btn.onclick = doCheck;
    var inp = document.getElementById('settings-lock-input');
    if (inp) {
        inp.onkeydown = function(e) { if (e.key === 'Enter') doCheck(); };
        setTimeout(function(){ inp.focus(); }, 50);
    }
}

/* ─── VIEW: BETS ─────────────────────────────────────────────────────────── */
var _betsData = null;

async function renderBets() {
    showView('view-bets');
    document.title = 'Bet History — CPM v2';
    var tbody = document.getElementById('bets-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="bets-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>';

    try {
        var r = await fetch('./bets');
        if (!r.ok) throw new Error(r.status);
        var bets = await r.json();
        _betsData = bets;

        var wins   = bets.filter(function(b){ return b.result==='WIN'; }).length;
        var losses = bets.filter(function(b){ return b.result==='LOSE'; }).length;
        var rate   = (wins+losses)>0 ? Math.round(wins/(wins+losses)*100) : 0;

        function s_(id, v) { var el=document.getElementById(id); if(el) el.textContent=v; }
        s_('bets-total', String(bets.length));
        s_('bets-wins',  String(wins));
        s_('bets-losses',String(losses));
        s_('bets-winrate', rate+'%');

        var sf = document.getElementById('bets-filter-streamer');
        if (sf) {
            var names = [];
            bets.forEach(function(b){ if(names.indexOf(b.streamer)===-1) names.push(b.streamer); });
            names.sort();
            sf.innerHTML = '<option value="">All streamers</option>' +
                names.map(function(n){ return '<option value="'+n+'">'+n+'</option>'; }).join('');
        }

        function renderTable() {
            var sf2 = (document.getElementById('bets-filter-streamer')||{}).value||'';
            var rf  = (document.getElementById('bets-filter-result')||{}).value||'';
            var filtered = (_betsData||[]).filter(function(b){
                return (!sf2||b.streamer===sf2) && (!rf||b.result===rf);
            });
            if (!filtered.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="bets-loading">No bets match the filter.</td></tr>';
                return;
            }
            var BADGES = {
                WIN:    '<span class="bet-badge bet-win"><i class="fas fa-trophy"></i> WIN</span>',
                LOSE:   '<span class="bet-badge bet-lose"><i class="fas fa-times"></i> LOSE</span>',
                PLACED: '<span class="bet-badge bet-placed"><i class="fas fa-hourglass-half"></i> PLACED</span>',
            };
            tbody.innerHTML = filtered.map(function(b){
                return '<tr>'+
                    '<td class="bets-ts">'+new Date(b.timestamp).toLocaleString('de-DE')+'</td>'+
                    '<td class="bets-streamer"><a href="#streamer/'+encodeURIComponent(b.streamer)+'">'+b.streamer+'</a></td>'+
                    '<td class="bets-title" title="'+(b.title||'')+'">'+( b.title||'—')+'</td>'+
                    '<td>'+(BADGES[b.result]||b.result)+'</td>'+
                    '<td class="bets-pts">'+fmt(b.points_at)+'</td>'+
                '</tr>';
            }).join('');
        }

        renderTable();
        var sfEl=document.getElementById('bets-filter-streamer');
        var rfEl=document.getElementById('bets-filter-result');
        if(sfEl) sfEl.onchange=renderTable;
        if(rfEl) rfEl.onchange=renderTable;

    } catch(err) {
        if(tbody) tbody.innerHTML='<tr><td colspan="5" class="bets-loading is-error"><i class="fas fa-triangle-exclamation"></i> '+err.message+'</td></tr>';
    }
    renderSidebar();
}

/* ─── VIEW: SETTINGS ─────────────────────────────────────────────────────── */
var _settingsCfg = null;

async function renderSettings() {
    showView('view-settings');
    document.title = 'Settings — CPM v2';

    // Tab switching (idempotent)
    document.querySelectorAll('.stab').forEach(function(btn) {
        btn.onclick = function() {
            document.querySelectorAll('.stab').forEach(function(b){
                b.classList.remove('is-active'); b.setAttribute('aria-selected','false');
            });
            document.querySelectorAll('.stab-panel').forEach(function(p){ p.hidden=true; });
            btn.classList.add('is-active'); btn.setAttribute('aria-selected','true');
            var panel=document.getElementById('stab-'+btn.dataset.stab);
            if(panel) panel.hidden=false;
        };
    });

    var saveBtn=document.getElementById('btn-save-global');
    if(saveBtn) saveBtn.onclick=saveGlobalSettings;
    var addBtn=document.getElementById('btn-add-streamer');
    if(addBtn) addBtn.onclick=handleAddStreamer;
    var addInp=document.getElementById('new-streamer-input');
    if(addInp) addInp.onkeydown=function(e){ if(e.key==='Enter') handleAddStreamer(); };

    try {
        _settingsCfg = await fetchConfig();
    } catch(err) {
        showSettingsToast('Cannot reach server: '+err.message, true);
        _settingsCfg = {global_settings:{}, streamers:[], settings_password:''};
    }

    // [4] Password gate — only proceed if unlocked
    _checkSettingsPassword(_settingsCfg, function() {
        populateGlobalForm(_settingsCfg);
        renderStreamersSettings(_settingsCfg);
    });

    renderSidebar();
}

async function handleAddStreamer() {
    var inp=document.getElementById('new-streamer-input');
    var val=inp ? inp.value.trim().toLowerCase() : '';
    if(!val){ showSettingsToast('Enter a streamer username', true); return; }
    var res=await apiAddStreamer(val);
    if(res.status==='ok'){
        showSettingsToast(res.message);
        showRestartBanner();
        if(inp) inp.value='';
        _settingsCfg=await fetchConfig();
        renderStreamersSettings(_settingsCfg);
        // [1] Reload sidebar so new streamer appears
        state.streamersList = await (async function(){ var r=await fetch('./streamers'); return r.json(); }());
        renderSidebar();
    } else {
        showSettingsToast(res.error||'Failed', true);
    }
}

/* [2] Form population — inputs have display:none via CSS, tracks animate properly */
function populateGlobalForm(config) {
    var gs  = (config && config.global_settings) ? config.global_settings : {};
    var bet = (gs && gs.bet) ? gs.bet : {};

    function sc(id, val, def) {
        var el=document.getElementById(id);
        if(!el) return;
        el.checked = (val!==undefined && val!==null) ? Boolean(val) : def;
        el.disabled=false; el.removeAttribute('disabled');
    }
    function sv(id, val, def) {
        var el=document.getElementById(id);
        if(!el) return;
        el.value = (val!==undefined && val!==null) ? val : def;
        el.disabled=false; el.removeAttribute('disabled');
    }

    sc('g-make_predictions', gs.make_predictions, true);
    sc('g-follow_raid',      gs.follow_raid,      true);
    sc('g-claim_drops',      gs.claim_drops,      true);
    sc('g-claim_moments',    gs.claim_moments,    true);
    sc('g-watch_streak',     gs.watch_streak,     true);
    sc('g-community_goals',  gs.community_goals,  false);
    sc('g-stealth_mode',     bet.stealth_mode,    true);

    sv('g-strategy',       bet.strategy,       'SMART');
    sv('g-percentage',     bet.percentage,     5);
    sv('g-percentage_gap', bet.percentage_gap, 20);
    sv('g-max_points',     bet.max_points,     50000);
    sv('g-minimum_points', bet.minimum_points, 0);
    sv('g-delay_mode',     bet.delay_mode,     'FROM_END');
    sv('g-delay',          bet.delay,          6);
    sv('g-chat',           gs.chat,            'ONLINE');
}

async function saveGlobalSettings() {
    if(!_settingsCfg) _settingsCfg={};
    function gc(id){ var el=document.getElementById(id); return el?el.checked:false; }
    function gn(id,d){ var el=document.getElementById(id); return el?(parseFloat(el.value)||d):d; }
    function gs(id,d){ var el=document.getElementById(id); return (el&&el.value)?el.value:d; }

    _settingsCfg.global_settings={
        make_predictions: gc('g-make_predictions'),
        follow_raid:      gc('g-follow_raid'),
        claim_drops:      gc('g-claim_drops'),
        claim_moments:    gc('g-claim_moments'),
        watch_streak:     gc('g-watch_streak'),
        community_goals:  gc('g-community_goals'),
        chat:             gs('g-chat','ONLINE'),
        bet:{
            strategy:       gs('g-strategy','SMART'),
            percentage:     gn('g-percentage',5),
            percentage_gap: gn('g-percentage_gap',20),
            max_points:     gn('g-max_points',50000),
            minimum_points: gn('g-minimum_points',0),
            stealth_mode:   gc('g-stealth_mode'),
            delay_mode:     gs('g-delay_mode','FROM_END'),
            delay:          gn('g-delay',6),
            filter_condition: null,
        },
    };
    try {
        var res=await saveConfig(_settingsCfg);
        showSettingsToast(res.message||'✓ Saved');
    } catch(err) {
        showSettingsToast('Save failed: '+err.message, true);
    }
}

/* [2] Streamer cards use proper .toggle-switch labels */
function renderStreamersSettings(config) {
    var container=document.getElementById('streamers-settings-list');
    if(!container) return;
    var streamers=(config&&config.streamers)?config.streamers:[];
    if(!streamers.length){
        container.innerHTML='<div class="settings-loading">No streamers found. Add one above or check config.json.</div>';
        return;
    }
    container.innerHTML='';
    var STRATEGIES=['SMART','MOST_VOTED','HIGH_ODDS','PERCENTAGE','SMART_MONEY','NUMBER_1','NUMBER_2'];

    streamers.forEach(function(s) {
        var sc  = s.settings||{};
        var bet = sc.bet||{};
        var enabled = s.enabled!==false;

        var card=document.createElement('div');
        card.className='streamer-setting-card';
        card.dataset.name=s.username;

        var stratOpts=STRATEGIES.map(function(v){
            return '<option value="'+v+'"'+(bet.strategy===v?' selected':'')+'>'+v+'</option>';
        }).join('');

        // [2] Use .toggle-switch class (same as rest of site) instead of .stg-toggle
        card.innerHTML=
          '<div class="stc-header">'+
            '<div class="stc-title">'+
              '<strong class="stc-name">'+s.username+'</strong>'+
            '</div>'+
            '<div class="stc-actions">'+
              // enabled toggle uses .toggle-switch
              '<label class="toggle-switch compact" title="Enable/Disable streamer">'+
                '<input type="checkbox" class="stc-enabled"'+(enabled?' checked':'')+'>'+
                '<span class="toggle-track"></span>'+
                '<span class="toggle-label">Enabled</span>'+
              '</label>'+
              '<button class="btn btn-sm stc-chart-btn" title="View chart"><i class="fas fa-chart-line"></i></button>'+
              '<button class="btn btn-sm btn-danger stc-remove" title="Remove"><i class="fas fa-trash"></i></button>'+
            '</div>'+
          '</div>'+
          '<div class="stc-body">'+
            // use-global uses .toggle-switch
            '<label class="toggle-switch" title="Use global defaults">'+
              '<input type="checkbox" class="stc-use-global"'+(!s.settings?' checked':'')+'>'+
              '<span class="toggle-track"></span>'+
              '<span class="toggle-label">Use global defaults (no individual override)</span>'+
            '</label>'+
            '<div class="stc-individual'+(s.settings?'':' is-hidden')+'">'+
              '<div class="settings-fields compact">'+
                '<label class="toggle-switch compact"><input type="checkbox" class="stc-make_predictions"'+(sc.make_predictions!==false?' checked':'')+'><span class="toggle-track"></span><span class="toggle-label">Make Predictions</span></label>'+
                '<label class="toggle-switch compact"><input type="checkbox" class="stc-follow_raid"'+(sc.follow_raid!==false?' checked':'')+'><span class="toggle-track"></span><span class="toggle-label">Follow Raids</span></label>'+
                '<label class="toggle-switch compact"><input type="checkbox" class="stc-claim_drops"'+(sc.claim_drops!==false?' checked':'')+'><span class="toggle-track"></span><span class="toggle-label">Claim Drops</span></label>'+
                '<label class="toggle-switch compact"><input type="checkbox" class="stc-watch_streak"'+(sc.watch_streak!==false?' checked':'')+'><span class="toggle-track"></span><span class="toggle-label">Watch Streak</span></label>'+
              '</div>'+
              '<div class="settings-fields compact">'+
                '<div class="stg-field"><label class="stg-field-label">Strategy</label><select class="input stg-select stc-strategy">'+stratOpts+'</select></div>'+
                '<div class="stg-field"><label class="stg-field-label">Max Points</label><input class="input stc-max_points" type="number" min="0" value="'+(bet.max_points!==undefined?bet.max_points:50000)+'"></div>'+
                '<div class="stg-field"><label class="stg-field-label">Min to Bet</label><input class="input stc-minimum_points" type="number" min="0" value="'+(bet.minimum_points!==undefined?bet.minimum_points:0)+'"></div>'+
              '</div>'+
              '<div class="stc-save-row"><button class="btn btn-primary btn-sm stc-save"><i class="fas fa-floppy-disk"></i> Save</button></div>'+
            '</div>'+
          '</div>';

        card.querySelector('.stc-chart-btn').onclick=function(){ navigate('#streamer/'+encodeURIComponent(s.username)); };

        card.querySelector('.stc-use-global').onchange=function(){
            card.querySelector('.stc-individual').classList.toggle('is-hidden', this.checked);
        };

        card.querySelector('.stc-enabled').onchange=async function(){
            var res=await apiPatchStreamer(s.username, {enabled:this.checked});
            if(res.status==='ok'){
                showSettingsToast(s.username+': '+(this.checked?'enabled':'disabled'));
                showRestartBanner();
                // [1] Reload sidebar immediately
                state.streamersList=await (async function(){ var r=await fetch('./streamers'); return r.json(); }());
                renderSidebar();
            } else {
                showSettingsToast(res.error||'Failed', true);
                this.checked=!this.checked;
            }
        };

        card.querySelector('.stc-remove').onclick=async function(){
            if(!confirm('Remove "'+s.username+'"? This triggers a ~10s restart.')) return;
            var res=await apiRemoveStreamer(s.username);
            if(res.status==='ok'){
                showSettingsToast(res.message);
                showRestartBanner();
                card.parentNode&&card.parentNode.removeChild(card);
                // [1] Reload sidebar so removed streamer disappears
                state.streamersList=await (async function(){ var r=await fetch('./streamers'); return r.json(); }());
                renderSidebar();
            } else {
                showSettingsToast(res.error||'Failed', true);
            }
        };

        card.querySelector('.stc-save').onclick=async function(){
            var useGlobal=card.querySelector('.stc-use-global').checked;
            var patch=useGlobal?{settings:null}:{settings:{
                make_predictions: card.querySelector('.stc-make_predictions').checked,
                follow_raid:      card.querySelector('.stc-follow_raid').checked,
                claim_drops:      card.querySelector('.stc-claim_drops').checked,
                watch_streak:     card.querySelector('.stc-watch_streak').checked,
                bet:{
                    strategy:       card.querySelector('.stc-strategy').value,
                    max_points:     parseFloat(card.querySelector('.stc-max_points').value)||50000,
                    minimum_points: parseFloat(card.querySelector('.stc-minimum_points').value)||0,
                },
            }};
            var res=await apiPatchStreamer(s.username, patch);
            if(res.status==='ok') showSettingsToast(s.username+': saved ✓');
            else showSettingsToast(res.error||'Save failed', true);
        };

        container.appendChild(card);
    });
}

/* ─── [6] Performant Log — virtual buffer, max 500 lines, rAF scroll ─────── */
(function patchLog() {
    var LOG_MAX_LINES = 500;
    var _logLines     = [];  // in-memory buffer
    var _rafPending   = false;

    function _flushLog() {
        _rafPending = false;
        var pre = document.getElementById('log-content');
        if (!pre) return;
        // Trim buffer
        if (_logLines.length > LOG_MAX_LINES) {
            _logLines = _logLines.slice(_logLines.length - LOG_MAX_LINES);
        }
        var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
        pre.textContent = _logLines.join('\n');
        if (atBottom) pre.scrollTop = pre.scrollHeight;
    }

    function _appendLog(text) {
        if (!text) return;
        var newLines = text.split('\n');
        // don't add empty trailing line
        if (newLines[newLines.length - 1] === '') newLines.pop();
        _logLines = _logLines.concat(newLines);
        if (!_rafPending) {
            _rafPending = true;
            requestAnimationFrame(_flushLog);
        }
    }

    // Patch initLog to use our buffer
    var _logActive = false;
    var _logAuto   = true;
    var _logIdx    = 0;

    async function _poll() {
        if (!_logActive) return;
        try {
            var r = await fetch('/log?lastIndex=' + _logIdx);
            if (r.ok) {
                var txt = await r.text();
                if (txt) { _appendLog(txt); _logIdx += txt.length; }
            }
        } catch (e) {}
        if (_logAuto && _logActive) setTimeout(_poll, 2000);  // 2s instead of 1s
    }

    // Lazy open — only start polling when log is first opened
    var logChk = document.getElementById('log');
    if (logChk) {
        // Remove original listener by cloning
        var clone = logChk.cloneNode(true);
        logChk.parentNode.replaceChild(clone, logChk);
        clone.addEventListener('change', function() {
            _logActive = this.checked;
            var box = document.getElementById('log-box');
            if (box) box.hidden = !_logActive;
            if (_logActive) _poll();
            localStorage.setItem('cpm-log', _logActive ? '1' : '0');
        });
        // Restore saved state
        if (localStorage.getItem('cpm-log') === '1') {
            clone.checked  = true;
            _logActive     = true;
            var box        = document.getElementById('log-box');
            if (box) box.hidden = false;
            _poll();
        }
    }

    // Pause/resume button
    var pauseBtn = document.getElementById('auto-update-log');
    if (pauseBtn) {
        var pbClone = pauseBtn.cloneNode(true);
        pauseBtn.parentNode.replaceChild(pbClone, pauseBtn);
        pbClone.addEventListener('click', function() {
            _logAuto = !_logAuto;
            this.textContent = _logAuto ? '⏸️' : '▶️';
            if (_logAuto) _poll();
        });
    }

    // Level filter dropdown
    var logHeader = document.querySelector('.log-header');
    if (logHeader && !logHeader.querySelector('.log-level-filter')) {
        var select = document.createElement('select');
        select.className = 'log-level-filter';
        select.title     = 'Log level filter';
        select.innerHTML =
            '<option value="1">INFO+</option>' +
            '<option value="0">ALL</option>' +
            '<option value="2">WARNING+</option>' +
            '<option value="3">ERROR only</option>';
        select.onchange = function() {
            var min   = parseInt(this.value, 10);
            var RANKS = {DEBUG:0, INFO:1, WARNING:2, WARN:2, ERROR:3};
            var LEVEL_RE = /\b(DEBUG|INFO|WARNING|WARN|ERROR)\b/;
            var filtered = _logLines.filter(function(line) {
                var m = line.match(LEVEL_RE);
                var lv = m ? m[1] : 'INFO';
                return (RANKS[lv] !== undefined ? RANKS[lv] : 1) >= min;
            });
            var pre = document.getElementById('log-content');
            if (pre) pre.textContent = filtered.join('\n');
        };
        logHeader.appendChild(select);
    }
}());