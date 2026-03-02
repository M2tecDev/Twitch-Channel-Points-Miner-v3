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
