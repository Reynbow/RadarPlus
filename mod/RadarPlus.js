/* RadarPlus for CONTROL Resonant: radar (sonar) size, shape, range, a map overlay and world markers.
 * Runs inside the game's HUD. Reads options from CRModMenu (window.CMM) and talks to radarplus.dll
 * through coui://base/__radarplus_*__.json. Nothing here changes game state except the sonar range,
 * which the DLL applies. */
(function () {
    'use strict';
    if (window.__RadarPlusInstalled) return;
    window.__RadarPlusInstalled = true;

    var C = window.__RadarPlusConfig || {};
    var NATIVE = C.native || {};
    var SOURCE = NATIVE.source === 'mapfusion' ? 'mapfusion' : 'radarplus';
    var NATIVE_URL = 'coui://base/__' + SOURCE + '_';
    var OWN_URL = 'coui://base/__radarplus_';
    var MOD_ID = 'radarplus';
    var DIAG = !!C.diagnostics;

    // The sonar's inner ring sits at 90% of .sonar; POIs inside it are placed linearly, so the
    // terrain must use the same metres per pixel. Map units are 1080p UI pixels; the map is the
    // world rotated with a slightly foreshortened vertical axis, hence two scales.
    var RING_FRACTION = 0.9;
    var UNIT_METRES_X = 0.53241, UNIT_METRES_Y = 0.55704;
    var MAX_TILES = 16;
    var TILE_ROOT = 'coui://base/textures/uiresources/UI/streamed/map/';
    var CORNER = 0.28;  // rounded shape: corner radius / half size (border-radius 14% of the box)
    // Range is the inner ring's distance in metres (the game's is 40); the hotkeys step through these.
    var RANGE_LEVELS = [20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300];
    var RANGE_MIN = 20, RANGE_MAX = 300, RANGE_STEP = 10, GAME_RING = 40;
    var SIZE_MIN = 50, SIZE_MAX = 250, SIZE_STEP = 10;
    // Round parts of the game's radar, hidden while the radar is square or rounded.
    var ROUND_PARTS = ['.sonar__bg', '.sonar__ring--1', '.sonar__ring--2', '.sonar__axis__shape'];
    // Measured from the game's art, as fractions of the radar's half size: the north "ear" on the
    // outline (sonar_shape.svg), the objective ring just outside the edge (sonar_distance_ring.svg,
    // 0.885x for POIs in the outer band) and the objective arrow sitting on that ring.
    var NOTCH_HALF_WIDTH = 0.1, NOTCH_HEIGHT = 0.11;
    var OBJECTIVE_RING = 1.0625, OBJECTIVE_RING_BETWEEN = 0.94, OBJECTIVE_ARROW = 1.05;
    var ARC_SLOTS = 6;  // objective markers drawn at once

    // ------------------------------------------------------------------ helpers
    function finite(v) { return typeof v === 'number' && isFinite(v); }
    function unbox(v) { return v && typeof v === 'object' && v.value !== undefined ? v.value : v; }
    function model(k, d) { var m = window[k]; return m && m.value !== undefined ? m.value : d; }
    function setStyle(n, k, v) { if (n && n.style[k] !== v) n.style[k] = v; }
    function show(n, on) { setStyle(n, 'display', on ? '' : 'none'); }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function now() { return Date.now(); }
    function hex(s) { var o = ''; for (var i = 0; i < s.length; i++) o += ('0' + s.charCodeAt(i).toString(16)).slice(-2); return o; }
    var raf = typeof window.requestAnimationFrame === 'function'
        ? function (f) { return window.requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); };

    // Diagnostics only: time spent in each loop and native requests per second, logged every 5 s.
    var clock = window.performance && typeof window.performance.now === 'function'
        ? function () { return window.performance.now(); } : now;
    var perf = { frame: [0, 0, 0], edges: [0, 0, 0], world: [0, 0, 0], requests: 0, since: 0, native: null };
    function note(k, ms) { var p = perf[k]; p[0] += ms; if (ms > p[1]) p[1] = ms; p[2]++; }
    function perfLine(k) { var p = perf[k]; return k + ' ' + (p[2] ? (p[0] / p[2]).toFixed(2) : '-') + ' ms avg, ' + p[1].toFixed(2) + ' max (' + p[2] + ')'; }

    var logCount = 0;
    function log(msg, force) {
        if (!DIAG && !force) return;
        if (++logCount > 400) return;
        try {
            var x = new XMLHttpRequest();
            x.open('GET', OWN_URL + 'log__.json?m=' + encodeURIComponent(String(msg).slice(0, 1400)), true);
            x.send();
        } catch (e) { /* logging must never throw */ }
    }

    function getJson(url, done, timeoutMs) {
        perf.requests++;
        var x;
        try { x = new XMLHttpRequest(); } catch (e) { done(null, String(e)); return; }
        var finished = false, timer = setTimeout(function () {
            if (finished) return; finished = true;
            try { x.abort(); } catch (e) { }
            done(null, 'timeout');
        }, timeoutMs || 1000);
        x.onload = function () {
            if (finished) return; finished = true; clearTimeout(timer);
            var r = null;
            try { if (x.status === 200 || x.status === 0) r = JSON.parse(x.responseText); } catch (e) { r = null; }
            done(r, r ? '' : 'bad response');
        };
        x.onerror = function () {
            if (finished) return; finished = true; clearTimeout(timer);
            done(null, 'request failed');
        };
        try { x.open('GET', url, true); x.send(); } catch (e) { if (!finished) { finished = true; clearTimeout(timer); done(null, String(e)); } }
    }

    function parseAngle(v) {
        if (finite(v)) return v * Math.PI / 180;
        var m = /rotate(?:Z)?\(\s*(-?[\d.]+(?:e-?\d+)?)(deg|rad|turn)?\s*\)/i.exec(v || '');
        if (!m) return null;
        var n = Number(m[1]), unit = (m[2] || 'deg').toLowerCase();
        return unit === 'rad' ? n : unit === 'turn' ? n * 2 * Math.PI : n * Math.PI / 180;
    }

    // Translation part of a transform model value: "a,b,c,d,e,f", "matrix(...)", "translate(x,y)..."
    function parseTranslation(raw) {
        if (raw && typeof raw === 'object') {
            if (raw.length >= 6) return { x: Number(raw[4]), y: Number(raw[5]) };
            if (finite(raw.e) && finite(raw.f)) return { x: raw.e, y: raw.f };
            if (finite(raw.m41) && finite(raw.m42)) return { x: raw.m41, y: raw.m42 };
            return null;
        }
        if (typeof raw !== 'string') return null;
        var nums = raw.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
        if (!nums) return null;
        var p = null;
        if (/translate/i.test(raw) && nums.length >= 2) p = { x: Number(nums[0]), y: Number(nums[1]) };
        else if (nums.length === 6) p = { x: Number(nums[4]), y: Number(nums[5]) };
        else if (nums.length === 16) p = { x: Number(nums[12]), y: Number(nums[13]) };
        return p && finite(p.x) && finite(p.y) ? p : null;
    }

    // Distance from the centre to a (rounded) square of half size h and corner radius rho, along the
    // unit vector (ux, uy).
    function boundary(ux, uy, h, rho) {
        var ax = Math.abs(ux), ay = Math.abs(uy), m = Math.max(ax, ay);
        if (m < 1e-6) return h;
        var t = h / m;
        if (rho > 0) {
            var c = h - rho;
            if (ax * t > c && ay * t > c) {
                var b = (ax + ay) * c, disc = b * b - (2 * c * c - rho * rho);
                if (disc >= 0) t = b + Math.sqrt(disc);
            }
        }
        return t;
    }

    function readList(listModel) {
        // Cohtml exposes native arrays as facades; the game itself uses .size, not Array.isArray.
        var out = [];
        if (!listModel) return out;
        var items = unbox(listModel.m_list);
        if (!items || (typeof items !== 'object' && typeof items !== 'function')) return out;
        var n = unbox(listModel.size);
        if (!finite(n)) n = unbox(items.length);
        if (!finite(n)) n = unbox(items.size);
        if (!finite(n) || n < 0) return out;
        n = Math.min(2048, Math.floor(n));
        for (var i = 0; i < n; i++) {
            var m = unbox(items[i]);
            if (!m) continue;
            var p = unbox(m.position);
            if (!p || !finite(p.x) || !finite(p.y)) continue;
            out.push({ x: p.x, y: p.y, player: !!unbox(m.is_player) });
        }
        return out;
    }

    // ------------------------------------------------------------------ options (CRModMenu)
    var DEFAULTS = {
        radar_size: 100, radar_shape: 0, radar_north_up: 0, radar_icons: 3, radar_range: GAME_RING, radar_icon_range: 900, terrain_enabled: 1, terrain_opacity: 65,
        radar_backdrop: 0, world_markers: 2, world_marker_size: 100, world_marker_range: 300, world_marker_labels: 1,
        world_marker_combat: 0, map_icons: 3, reveal_mode: 0, reveal_seconds: 5, reveal_pad: 268, reveal_key: 0
    };
    // Hotkey changes CRModMenu did not take (or no CRModMenu): kept until the menu value changes.
    var overrides = {};
    function menuValue(key) {
        var v;
        try { if (window.CMM && typeof window.CMM.value === 'function') v = window.CMM.value(MOD_ID, key); } catch (e) { v = undefined; }
        if (typeof v === 'boolean') v = v ? 1 : 0;
        else if (typeof v === 'string' && v.trim() !== '' && isFinite(v)) v = Number(v);  // a value handed over as text
        return finite(v) ? v : undefined;
    }
    function option(key) {
        var v = menuValue(key), o = overrides[key];
        if (o) {
            if (v === o.base) return o.value;
            delete overrides[key];  // changed in the menu since: the menu wins
        }
        if (!finite(v) && C.menu && finite(C.menu[key])) v = C.menu[key];
        return finite(v) ? v : DEFAULTS[key];
    }
    // Changes a menu value the way the MODS page does, so CRModMenu shows and saves it.
    function setOption(key, value) {
        var base = menuValue(key), accepted = false;
        try {
            if (window.CMM && window.engine && typeof engine.trigger === 'function')
                accepted = engine.trigger('on_option_set', 'cmm_' + hex(MOD_ID) + '_' + hex(key), value) === true;
        } catch (e) { accepted = false; }
        if (accepted && menuValue(key) === value) { delete overrides[key]; return true; }
        overrides[key] = { value: value, base: base };
        return false;
    }

    // ------------------------------------------------------------------ native position feed
    var feed = (function () {
        var pending = false, next = 0, latest = null, receivedAt = 0, lastSeq = 0, error = '';
        function valid(p) {
            return p && p.installed === true && p.valid === true && finite(p.seq) && finite(p.epoch) &&
                finite(p.ageMs) && p.ageMs >= 0 && p.ageMs <= 500 && finite(p.uiHeight) && p.uiHeight >= 64 &&
                p.uiHeight <= 16384 && finite(p.district) && finite(p.x) && finite(p.y) && finite(p.clipX) &&
                finite(p.clipY) && Math.abs(p.x) < 1e8 && Math.abs(p.y) < 1e8;
        }
        return {
            info: null,
            tick: function (t, interval) {
                if (pending || t < next) return;
                next = t + interval;
                var sent = t, self = this;
                pending = true;  // set before the call: the callback may run synchronously
                getJson(NATIVE_URL + 'position__.json?n=' + t, function (p, err) {
                    pending = false;
                    if (!p) { latest = null; error = err; next = now() + 250; return; }
                    self.info = p;
                    if (!valid(p)) { latest = null; error = 'no valid sample'; return; }
                    if (p.seq <= lastSeq) return;
                    lastSeq = p.seq;
                    p.ageMs += Math.max(0, now() - sent);
                    latest = p; receivedAt = now(); error = '';
                }, 600);
            },
            get: function (t) { return latest && latest.ageMs + Math.max(0, t - receivedAt) <= 500 ? latest : null; },
            error: function () { return error; }
        };
    })();
    // With MapFusion's DLL serving positions, our own DLL still counts the hotkeys.
    var keyFeed = { pending: false, next: 0, counts: null, reveal: null };
    function tickKeyFeed(t) {
        if (SOURCE !== 'mapfusion' || keyFeed.pending || t < keyFeed.next) return;
        keyFeed.next = t + 100;
        keyFeed.pending = true;
        getJson(OWN_URL + 'keys__.json?n=' + t, function (r) { keyFeed.pending = false; if (r && r.keys) { keyFeed.counts = r.keys; keyFeed.reveal = r.reveal; } }, 600);
    }

    // ------------------------------------------------------------------ sonar range (zoom)
    var zoom = { menuSent: null, pending: false, retryAt: 0, rings: [40, 120, 40, 80], percent: 100, serial: -1, available: !!NATIVE.zoom };
    function applyZoomReply(r) {
        if (!r) return;
        var serial = finite(r.zoomSerial) ? r.zoomSerial : finite(r.serial) ? r.serial : null;
        if (serial !== null && serial < zoom.serial) return;  // older than what we already know
        if (finite(r.zoom) && r.zoom > 0) zoom.percent = r.zoom;
        if (r.rings && r.rings.length === 4 && r.rings.every(finite)) zoom.rings = r.rings.slice();
        else {
            if (finite(r.explore) && r.explore > 0) zoom.rings[0] = r.explore;
            if (finite(r.combat) && r.combat > 0) zoom.rings[2] = r.combat;
        }
        if (serial !== null) zoom.serial = serial;
    }
    // The game's own inner ring in metres (40), from what the DLL reports.
    function gameRing() {
        var base = zoom.rings[0] * 100 / (zoom.percent || 100);
        return base > 1 && base < 1000 ? base : GAME_RING;
    }
    function rangeOption() { return clamp(Math.round(option('radar_range') / RANGE_STEP) * RANGE_STEP, RANGE_MIN, RANGE_MAX); }
    function syncZoom(t) {
        if (!zoom.available) return;
        var want = Math.round(rangeOption() / gameRing() * 100);
        if (!(want >= 25 && want <= 1000)) want = 100;
        if (zoom.pending || t < zoom.retryAt || want === zoom.menuSent) return;
        zoom.pending = true;
        getJson(NATIVE_URL + 'zoom__.json?p=' + want, function (r) {
            zoom.pending = false;
            if (!r) { zoom.retryAt = now() + 2000; return; }
            applyZoomReply(r);
            zoom.menuSent = want;
            if (r.ok === false) log('zoom ' + want + '% refused', true);
        }, 1500);
    }
    // Pre-release builds stored the range as a percentage choice (radar_zoom); carry it over once.
    var migrated = false;
    function migrateRange() {
        if (migrated || !window.CMM) return;
        migrated = true;
        var legacy = C.menu && C.menu.radar_zoom, saved = C.menu && C.menu.radar_range;
        if (finite(saved) || !finite(legacy) || legacy <= 0) return;
        var metres = clamp(Math.round(legacy * GAME_RING / 100 / RANGE_STEP) * RANGE_STEP, RANGE_MIN, RANGE_MAX);
        if (metres !== option('radar_range')) setOption('radar_range', metres);
        log('range setting carried over: ' + legacy + '% -> ' + metres + ' m');
    }

    // ------------------------------------------------------------------ hotkeys
    var hotkeys = { last: null };
    function nearestIndex(list, v) {
        var best = 0;
        for (var i = 1; i < list.length; i++) if (Math.abs(list[i] - v) < Math.abs(list[best] - v)) best = i;
        return best;
    }
    function handleKeys(counts, t) {
        if (!counts || counts.length !== 4 || !counts.every(finite)) return;
        if (!hotkeys.last) { hotkeys.last = counts.slice(); return; }
        var d = [];
        for (var i = 0; i < 4; i++) { var n = counts[i] - hotkeys.last[i]; d.push(n > 0 && n < 100 ? n : 0); }
        hotkeys.last = counts.slice();
        var zoomSteps = d[1] - d[0];  // zoom out minus zoom in: positive shows more area
        var sizeSteps = d[2] - d[3];
        if (zoomSteps) {
            var cur = rangeOption(), idx = nearestIndex(RANGE_LEVELS, cur);
            // From a value between two levels, the first step lands on the neighbouring level.
            if (zoomSteps > 0 && RANGE_LEVELS[idx] > cur) zoomSteps--;
            if (zoomSteps < 0 && RANGE_LEVELS[idx] < cur) zoomSteps++;
            var next = RANGE_LEVELS[clamp(idx + zoomSteps, 0, RANGE_LEVELS.length - 1)];
            if (next !== cur) setOption('radar_range', next);
            flash('RANGE ' + next + ' m', t);
        }
        if (sizeSteps) {
            var s = option('radar_size');
            var ns = clamp(Math.round(s / SIZE_STEP) * SIZE_STEP + sizeSteps * SIZE_STEP, SIZE_MIN, SIZE_MAX);
            if (ns !== s) setOption('radar_size', ns);
            flash('SIZE ' + ns + '%', t);
        }
    }

    // ------------------------------------------------------------------ tile streaming
    // Map tiles are streamed textures: ask the engine to load the .tex, wait for OnResourceLoaded,
    // then use the .png URL in an <img>. We only release what we loaded.
    var streaming = (function () {
        var entries = {}, handles = {}, hooked = false, early = [], loadingDepth = 0;
        function keyOf(h) { return typeof h === 'number' || typeof h === 'string' ? String(h) : h; }
        function onLoaded(h) {
            var k = keyOf(h), list = handles[k];
            if (list) list.forEach(function (e) { markReady(e); });
            else if (loadingDepth && early.length < 64) early.push(k);
        }
        function markReady(e) {
            if (e.state !== 'loading') return;
            e.state = 'ready';
            clearTimeout(e.timer);
            e.waiters.slice().forEach(function (w) { setTimeout(function () { if (w.active) w.cb(w); }, 0); });
        }
        function ensureHook() {
            if (hooked) return true;
            if (!window.page || typeof page.loadResource !== 'function' || typeof page.unloadResource !== 'function' ||
                !window.engine || typeof engine.on !== 'function') return false;
            engine.on('OnResourceLoaded', onLoaded);
            hooked = true;
            return true;
        }
        function drop(e) {
            var k = keyOf(e.handle), list = handles[k];
            if (list) { list.splice(list.indexOf(e), 1); if (!list.length) delete handles[k]; }
            if (e.owned) { e.owned = false; try { page.unloadResource(e.handle); } catch (err) { } }
            delete entries[e.url];
        }
        return {
            acquire: function (url, cb) {
                if (!ensureHook()) throw new Error('streaming API unavailable');
                if (url.indexOf(TILE_ROOT) !== 0 || !/\.png$/.test(url) || url.indexOf('..') !== -1) throw new Error('bad tile path');
                var e = entries[url];
                if (!e) {
                    e = entries[url] = { url: url, state: 'loading', owned: false, handle: undefined, waiters: [], timer: null };
                    loadingDepth++;
                    try {
                        e.handle = page.loadResource(url.replace(/\.png$/, '.tex'));
                        if (e.handle === undefined || e.handle === null) throw new Error('no handle');
                        e.owned = true;
                        var k = keyOf(e.handle);
                        (handles[k] = handles[k] || []).push(e);
                        if (early.indexOf(k) !== -1) e.state = 'ready';
                    } catch (err) { delete entries[url]; loadingDepth--; if (!loadingDepth) early = []; throw err; }
                    loadingDepth--; if (!loadingDepth) early = [];
                    if (e.state === 'loading') e.timer = setTimeout(function () {
                        if (e.state !== 'loading') return;
                        e.state = 'failed';
                        e.waiters.slice().forEach(function (w) { if (w.active) w.cb(w); });
                    }, 20000);
                }
                var w = { entry: e, active: true, cb: cb };
                e.waiters.push(w);
                if (e.state !== 'loading') setTimeout(function () { if (w.active) cb(w); }, 0);
                return w;
            },
            release: function (w) {
                if (!w || !w.active) return;
                w.active = false;
                var e = w.entry, i = e.waiters.indexOf(w);
                if (i !== -1) e.waiters.splice(i, 1);
                if (!e.waiters.length) { clearTimeout(e.timer); drop(e); }
            },
            ready: function (w) { return !!w && w.active && w.entry.state === 'ready'; }
        };
    })();

    // ------------------------------------------------------------------ atlas (map tiles per district)
    var atlasCache = {};
    function normaliseAtlas(a) {
        if (!a || !a.tiles || !a.tiles.length) return null;
        var tiles = [];
        a.tiles.forEach(function (t) {
            if (t && typeof t.p === 'string' && t.p && t.p.indexOf('..') === -1 && t.b && t.b.length === 4 &&
                t.b.every(finite) && t.b[2] > 0 && t.b[3] > 0) tiles.push({ path: t.p, x: t.b[0], y: t.b[1], w: t.b[2], h: t.b[3] });
        });
        return tiles.length ? { tiles: tiles } : null;
    }
    (function () {
        var saved = C.atlas || {};
        Object.keys(saved).forEach(function (d) { var a = normaliseAtlas(saved[d]); if (a) atlasCache[d] = a; });
    })();
    var subscribed = false, lastSaved = {}, lastAtlasCheck = 0;
    function round2(v) { return Math.round(v * 100) / 100; }
    // Diagnostics: what the map learning sees while the full map is open, every 2 s.
    var lastAtlasLog = 0;
    function atlasDiag(p, t, markers, player) {
        lastAtlasLog = t;
        var images = 0, first = '';
        for (var i = 0; i < MAX_TILES; i++) {
            var path = model('ui_map_district_images_' + i + '_path', ''), b = model('ui_map_district_images_' + i + '_map_bounds', null);
            if (typeof path !== 'string' || !path) continue;
            images++;
            if (!first) first = path + ' [' + (b ? [b.x, b.y, b.z, b.w].join(',') : 'no bounds') + ']';
        }
        log('atlas check: district ' + p.district + (atlasCache[String(p.district)] ? ' (cached)' : '') + ', ' + markers + ' map markers, player ' +
            (player ? player.x.toFixed(1) + ',' + player.y.toFixed(1) : 'none') + ' vs native ' + p.clipX.toFixed(1) + ',' +
            p.clipY.toFixed(1) + ', ' + images + ' district images' + (first ? ', first ' + first : ''));
    }
    function learnAtlas(p) {
        // Only while the full map is open does the UI publish the district images. Accept them only
        // when the map's own player marker agrees with our native sample, i.e. same coordinate space.
        // (The DLL's own "map open" flag went with the game's 1 October update; the UI says it instead.)
        if (!model('ui_stacks_game_states_map_active', false)) return;
        var t = now();
        if (t - lastAtlasCheck < 500) return;  // the images don't change while the map is open
        lastAtlasCheck = t;
        if (!subscribed && window.DataAPI && typeof DataAPI.listSubscribe === 'function') {
            try { DataAPI.listSubscribe('ui_map_markers'); subscribed = true; } catch (e) { }
        }
        var player = null, markers = readList(window.ui_map_markers);
        markers.forEach(function (m) { if (m.player && !player) player = m; });
        if (DIAG && t - lastAtlasLog > 2000) atlasDiag(p, t, markers.length, player);
        if (!player || Math.abs(player.x - p.clipX) >= 2 || Math.abs(player.y - p.clipY) >= 2) return;
        var factor = p.uiHeight / 1080, tiles = [];
        for (var i = 0; i < MAX_TILES; i++) {
            var pre = 'ui_map_district_images_' + i + '_', path = model(pre + 'path', ''), b = model(pre + 'map_bounds', null);
            if (typeof path === 'string' && path && b && finite(b.x) && finite(b.y) && finite(b.z) && finite(b.w) && b.z > 0 && b.w > 0)
                tiles.push({ p: path, b: [round2(b.x / factor), round2(b.y / factor), round2(b.z / factor), round2(b.w / factor)] });
        }
        if (!tiles.length) return;
        var json = JSON.stringify({ tiles: tiles }), d = String(p.district);
        atlasCache[d] = normaliseAtlas({ tiles: tiles });
        if (lastSaved[d] !== json) {
            lastSaved[d] = json;
            getJson(OWN_URL + 'atlas__.json?d=' + d + '&j=' + encodeURIComponent(json), function (r) {
                if (!r || r.ok !== true) log('atlas for district ' + d + ' was not saved', true);
            }, 2000);
            log('atlas learned for district ' + d + ' (' + tiles.length + ' tiles)');
        }
    }

    // ------------------------------------------------------------------ DOM
    var STYLE_ID = 'radarplus-style';
    // Square and rounded copy the game's round radar: a frosted glass body with a 10% dark tint,
    // the map inset to 90% so a blurred band shows around it, a faint inner line (which turns red in
    // combat and yellow in objective areas, like the game's inner ring), a light outer outline and a
    // north notch.
    var CSS =
        '.rp-glass{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;' +
        'backdrop-filter:blur(0.462962963vh);background-color:rgba(23,23,23,.1)}' +
        '.rp-layer{position:absolute;left:5%;top:5%;width:90%;height:90%;overflow:hidden;border-radius:50%;pointer-events:none}' +
        '.rp-layer--square{border-radius:0}' +
        '.rp-layer--rounded{border-radius:10%}' +
        '.rp-backdrop{position:absolute;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,1)}' +
        '.rp-origin{position:absolute;left:50%;top:50%;width:0;height:0;transform-origin:0 0}' +
        '.rp-tile{position:absolute;left:0;top:0;max-width:none;max-height:none;pointer-events:none}' +
        '.rp-inner{position:absolute;left:5%;top:5%;width:90%;height:90%;box-sizing:border-box;pointer-events:none;' +
        'border:.0925925926vh solid rgba(232,232,232,.1);transition:border-color 200ms ease-out,background-color 200ms ease-out}' +
        '.rp-inner--objective{border:.1851851852vh solid #fbe732;background-color:rgba(251,231,50,.2)}' +
        '.rp-inner--combat{border:.1851851852vh solid #ea5630}' +
        // Outline + objective arcs are static SVG paths animated through stroke dashes; the north
        // notch's two legs and the objective arrows are positioned elements. Everything is placed
        // with transforms from the top-left corner: cohtml ignored "left" on an absolutely
        // positioned <svg>, so each SVG sits in a plain wrapper div.
        // Square/rounded: the game's own objective arc and arrow only fit a circle; ours replace them.
        '.rp-square .poi__distance,.rp-square .poi__distance__arrow,.rp-square .poi__distance__indicator' +
        '{opacity:0 !important;visibility:hidden !important}' +
        // Lock rotation: the game's icons and objective rings give way to our copies and arcs.
        '.rp-locked .poi-container{visibility:hidden !important}' +
        // Radar icons: None also hides the game's objective ring.
        '.rp-no-arcs .poi__distance,.rp-no-arcs .poi__distance__arrow,.rp-no-arcs .poi__distance__indicator' +
        '{opacity:0 !important;visibility:hidden !important}' +
        '.rp-locked .poi__distance,.rp-locked .poi__distance__arrow,.rp-locked .poi__distance__indicator' +
        '{opacity:0 !important;visibility:hidden !important}' +
        '.rp-lk,.rp-lk-wrap{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}' +
        '.rp-lk-poi{position:absolute;left:0;top:0;transform:translate(-50%, -50%);z-index:1;pointer-events:none}' +
        '.rp-chrome{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}' +
        // Pieces that touch are drawn opaque and faded together: cohtml otherwise applies opacity per
        // element, so overlaps (arrow on arc, leg on leg) would show brighter. The game does the same.
        '.rp-outline-group,.rp-objective{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;' +
        'overflow:visible;coh-simple-opacity:off}' +
        '.rp-outline-group{opacity:.35}' +
        '.rp-svgbox{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}' +
        '.rp-leg{position:absolute;left:0;top:0;width:0;transform-origin:0 50%;pointer-events:none;background-color:#e8e8e8}' +
        '.rp-ear{position:absolute;left:0;top:0;pointer-events:none;background-color:rgba(23,23,23,.1)}' +
        '.rp-arrow{position:absolute;left:0;top:0;width:1.4814814815vh;height:.7407407407vh;transform-origin:50% 100%;' +
        'pointer-events:none;background-color:#fbe732;' +
        'mask-image:url("coui://base/uiresources/game/symbols/sonar/sonar_quest_direction.svg");' +
        'mask-position:center;mask-repeat:no-repeat;mask-size:100%}' +
        // CRModMenu's "Saving... / Saved" line under the MODS descriptions (only that block has two).
        '.options-description__text+.options-description__text{display:none !important}' +
        // Our copy of a RadarPlus description (updateMenuDescription), in the look of the game's own.
        '.rp-desc{padding:0;margin:0;white-space:pre-wrap;text-align:left;font-weight:500}.rp-desc b{font-weight:bold}' +
        // The icon picker (Custom): a tile per icon, dimmed and struck through when hidden.
        '.rp-filter{pointer-events:auto;margin-top:2.2222222222vh;display:flex;flex-direction:column}' +
        '.rp-filter__grid{display:flex;flex-direction:row;flex-wrap:wrap}' +
        '.rp-filter__tile{position:relative;width:5.1851851852vh;height:5.1851851852vh;margin:0 .7407407407vh .7407407407vh 0;' +
        'display:flex;align-items:center;justify-content:center;pointer-events:auto;background-color:rgba(232,232,232,.08);' +
        'border:.1851851852vh solid rgba(232,232,232,.3)}' +
        '.rp-filter__tile:hover{border-color:rgba(232,232,232,.9)}' +
        '.rp-filter__tile--off .rp-filter__icon,.rp-filter__tile--off .rp-filter__pin,.rp-filter__tile--off .rp-filter__dot{opacity:.3}' +
        '.rp-filter__strike{display:none;position:absolute;left:10%;top:48%;width:80%;height:.2777777778vh;' +
        'background-color:#ea5630;transform:rotate(-45deg)}' +
        '.rp-filter__tile--off .rp-filter__strike{display:flex}' +
        '.rp-filter__icon{width:3.3333333333vh;height:3.3333333333vh}' +
        '.rp-filter__pin{width:2.2222222222vh;height:2.2222222222vh;background-color:#fbe732;transform:rotate(45deg);' +
        'display:flex;align-items:center;justify-content:center}' +
        '.rp-filter__pin-n{transform:rotate(-45deg);color:#0d0d0d;font-weight:700;font-size:1.4814814815vh}' +
        '.rp-filter__dot{width:2.5925925926vh;height:2.5925925926vh;border-radius:50%}' +
        '.rp-filter__dot--friend{background-color:rgb(0,166,166)}.rp-filter__dot--enemy{background-color:rgb(234,86,48)}' +
        '.rp-filter__dot--other{width:1.2962962963vh;height:1.2962962963vh;background-color:#e8e8e8}' +
        '.rp-filter__caption{margin:.7407407407vh 0 0 0;padding:0;min-height:2.7777777778vh;font-weight:500}' +
        '.rp-label{position:absolute;left:0;width:100%;top:100%;margin-top:.9259259259vh;text-align:center;' +
        'font-size:1.4814814815vh;font-weight:700;line-height:2.2222222222vh;color:rgba(232,232,232,.9);' +
        'text-shadow:.0925925926vh .0925925926vh rgba(23,23,23,.6);pointer-events:none;white-space:nowrap}' +
        // World markers: copies of the sonar icons over their objects, under the game's own prompts.
        '.rp-world{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;' +
        'transition:opacity .3s ease-out}' +
        '.rp-wm{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;coh-simple-opacity:off}' +
        '.rp-wm__icon{position:absolute;left:0;top:0;pointer-events:none}' +
        '.rp-wm .poi__elevation{display:none !important}' +  // the marker sits at the real height
        '.rp-wm__arrow{position:absolute;left:0;top:0;width:1.4814814815vh;height:.7407407407vh;pointer-events:none;' +
        'background-color:#fbe732;mask-image:url("coui://base/uiresources/game/symbols/sonar/sonar_quest_direction.svg");' +
        'mask-position:center;mask-repeat:no-repeat;mask-size:100%}' +
        '.rp-wm__dist{position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;font-size:1.2962962963vh;' +
        'font-weight:700;line-height:1.6666666667vh;color:rgba(232,232,232,.95);' +
        'text-shadow:.0925925926vh .0925925926vh rgba(23,23,23,.8)}' +
        '.rp-wm--tracked .rp-wm__dist{color:#fbe732}';

    var dom = null;
    function emptyDom() {
        return { container: null, sonar: null, glass: null, layer: null, backdrop: null, origin: null, inner: null,
            chrome: null, svgKey: '', outlineGroup: null, outline: null, objectives: [], legs: [], ear: null, label: null, north: null,
            tiles: [], pois: null, poisStale: false, round: [], bg: null, axis: null, cone: null, player: null, lk: { on: false, cone: '', shapeKey: '' } };
    }
    dom = emptyDom();

    function connected(n) { for (var i = 0; n && i < 128; i++, n = n.parentNode) if (n === document.body) return true; return false; }
    function staged(n) {
        for (; n; n = n.parentNode) {
            if (n.tagName && n.tagName.toLowerCase() === 'template') return true;
            if (n.classList && n.classList.contains('coh-layout-staging')) return true;
        }
        return false;
    }
    function findSonar() {
        var all = document.querySelectorAll('.sonar-container');
        for (var i = 0; i < all.length; i++) {
            var c = all[i];
            if (!connected(c) || staged(c)) continue;
            var s = c.querySelector('.sonar');
            if (s) return { container: c, sonar: s };
        }
        return null;
    }
    function releaseTile(t) {
        if (t.token) streaming.release(t.token);
        t.token = null;
        if (t.preload) { t.preload.onload = t.preload.onerror = null; t.preload = null; }
        if (t.src) t.node.src = '';
        t.src = ''; t.loaded = false; t.failedUrl = '';
    }
    function releaseTiles() { dom.tiles.forEach(releaseTile); }
    function restoreNative(root) {
        // Undo everything we set on the game's own elements.
        if (!root) return;
        ROUND_PARTS.forEach(function (sel) { var n = root.querySelector(sel); if (n) { setStyle(n, 'opacity', ''); setStyle(n, 'visibility', ''); } });
        var label = root.querySelector('.sonar__axis__north-label');
        if (label) setStyle(label, 'transform', '');
        var pois = root.querySelectorAll('.poi-container');
        for (var i = 0; i < pois.length; i++) { setStyle(pois[i], 'transform', ''); setStyle(pois[i], 'visibility', ''); }
        // Lock rotation: the parts we hid or turned.
        ['.sonar__bg', '.sonar__axis', '.sonar__center-player'].forEach(function (sel) { var n = root.querySelector(sel); if (n) setStyle(n, 'visibility', ''); });
        var cone = root.querySelector('.sonar__cone');
        if (cone) { setStyle(cone, 'transform', ''); setStyle(cone, 'transformOrigin', ''); }
        if (root.classList && root.classList.contains('rp-locked')) root.classList.toggle('rp-locked', false);
        if (root.classList && root.classList.contains('rp-no-arcs')) root.classList.toggle('rp-no-arcs', false);
        if (root.classList && root.classList.contains('rp-square')) root.classList.toggle('rp-square', false);
    }
    function removeOurs(root) {
        // The game can clone the HUD (including our nodes) when a level loads; clear strays too.
        if (!root) return;
        var stale = root.querySelectorAll('.rp-glass,.rp-layer,.rp-inner,.rp-chrome,.rp-label,.rp-lk,.rp-lk-wrap');
        for (var i = 0; i < stale.length; i++) if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
    }
    function unmount() {
        releaseTiles();
        resetWorldFeed();
        clearWorld();
        removeOurs(dom.sonar);
        restoreNative(dom.sonar);
        if (dom.container) {
            setStyle(dom.container, 'transform', ''); setStyle(dom.container, 'transformOrigin', '');
            setStyle(dom.container, 'opacity', ''); setStyle(dom.container, 'transition', '');
        }
        applyNeighbours(0);
        dom = emptyDom();
        lastLayoutKey = '';
        resetMeasure();
    }
    function mapPois(sonar) {
        var list = sonar.querySelectorAll('.poi-container'), out = [];
        out.bound = 0;  // slots whose index came from their bindings; the rest go by DOM order
        for (var j = 0; j < list.length; j++) {
            var c = list[j], p = c.querySelector('.poi'), idx = j;
            var attr = p ? (p.getAttribute('data-bind-style-transform2d') || p.getAttribute('data-bind-class-toggle') || '') : '';
            var m = /hud_sonar_poi_(\d+)_/.exec(attr);
            if (m) { idx = Number(m[1]); out.bound++; }
            out.push({ el: c, poi: p, index: idx, applied: '', dx: 0, dy: 0, lk: null });
        }
        return out;
    }
    // A late world reply is applied outside the RAF, so the game may have replaced POI elements since
    // updateEdges last mapped them. The icon a marker copies must still sit in the sonar (.poi, its
    // container, the sonar: a couple of steps), or it would be a stale copy.
    function poiAttached(poi) {
        for (var n = poi, i = 0; n && i < 4; i++, n = n.parentNode) if (n === dom.sonar) return true;
        return false;
    }
    function attrList(n) {
        var out = [];
        for (var i = 0; n.attributes && i < n.attributes.length && out.length < 6; i++) out.push(n.attributes[i].name + '="' + String(n.attributes[i].value).slice(0, 70) + '"');
        return out.join(' ');
    }
    function mount() {
        unmount();
        var f = findSonar();
        if (!f) return false;
        if (!document.getElementById(STYLE_ID)) {
            var st = document.createElement('style');
            st.id = STYLE_ID; st.textContent = CSS + mapIconsCss();
            document.head.appendChild(st);
        }
        removeOurs(f.sonar);
        restoreNative(f.sonar);
        dom.container = f.container; dom.sonar = f.sonar;
        dom.glass = document.createElement('div'); dom.glass.className = 'rp-glass'; show(dom.glass, false);
        dom.layer = document.createElement('div'); dom.layer.className = 'rp-layer';
        dom.backdrop = document.createElement('div'); dom.backdrop.className = 'rp-backdrop'; dom.layer.appendChild(dom.backdrop);
        dom.origin = document.createElement('div'); dom.origin.className = 'rp-origin'; dom.layer.appendChild(dom.origin);
        for (var i = 0; i < MAX_TILES; i++) {
            var img = document.createElement('img'); img.className = 'rp-tile'; show(img, false);
            dom.origin.appendChild(img);
            dom.tiles.push({ node: img, src: '', loaded: false, token: null, preload: null, failedUrl: '' });
        }
        show(dom.layer, false);
        // Under the icons and view cone, right above the sonar background.
        var bg = dom.sonar.querySelector('.sonar__bg');
        var anchor = bg && bg.parentNode === dom.sonar ? bg.nextSibling : dom.sonar.firstChild;
        dom.sonar.insertBefore(dom.glass, anchor);
        dom.sonar.insertBefore(dom.layer, anchor);
        dom.inner = document.createElement('div'); dom.inner.className = 'rp-inner'; show(dom.inner, false);
        dom.sonar.insertBefore(dom.inner, anchor);
        // Outline, notch and objective markers sit above the map but below the POIs (z-index 1).
        dom.chrome = document.createElement('div'); dom.chrome.className = 'rp-chrome'; show(dom.chrome, false);
        dom.ear = document.createElement('div'); dom.ear.className = 'rp-ear'; dom.chrome.appendChild(dom.ear);
        dom.outlineGroup = document.createElement('div'); dom.outlineGroup.className = 'rp-outline-group'; dom.chrome.appendChild(dom.outlineGroup);
        for (var l = 0; l < 2; l++) { var leg = document.createElement('div'); leg.className = 'rp-leg'; dom.outlineGroup.appendChild(leg); dom.legs.push(leg); }
        // One group per objective marker so its arc and arrow fade as a single shape.
        for (var a = 0; a < ARC_SLOTS; a++) {
            var group = document.createElement('div'); group.className = 'rp-objective'; show(group, false);
            var arrow = document.createElement('div'); arrow.className = 'rp-arrow'; show(arrow, false); group.appendChild(arrow);
            dom.chrome.appendChild(group);
            dom.objectives.push({ group: group, arrow: arrow, out: null, inner: null, shown: false });
        }
        dom.sonar.appendChild(dom.chrome);
        dom.label = document.createElement('div'); dom.label.className = 'rp-label'; show(dom.label, false);
        dom.sonar.appendChild(dom.label);
        dom.round = ROUND_PARTS.map(function (sel) { return dom.sonar.querySelector(sel); });
        dom.north = dom.sonar.querySelector('.sonar__axis__north-label');
        // What the game turns with the camera (Lock rotation hides these and shows our copies).
        dom.bg = dom.sonar.querySelector('.sonar__bg');
        dom.axis = dom.sonar.querySelector('.sonar__axis');
        dom.cone = dom.sonar.querySelector('.sonar__cone');
        dom.player = dom.sonar.querySelector('.sonar__center-player');
        dom.pois = mapPois(dom.sonar);
        if (DIAG) {
            var r = dom.container.getBoundingClientRect();
            log('sonar mounted: rect ' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') + ' view ' +
                window.innerWidth + 'x' + window.innerHeight + ', ' + dom.pois.length + ' poi slots (' + dom.pois.bound + ' indexed by their bindings)' +
                (dom.pois[0] && dom.pois[0].poi ? ', first poi: class "' + dom.pois[0].poi.className + '" attrs ' + attrList(dom.pois[0].poi) : ''));
        }
        return true;
    }
    function alive() {
        return dom.container && connected(dom.container) && dom.sonar && connected(dom.sonar) && dom.layer && connected(dom.layer);
    }

    // ------------------------------------------------------------------ layout: size and shape
    var lastLayoutKey = '', currentScale = 1;
    // Reading a size makes the engine lay the whole HUD out on the spot (about 4 ms in game), so the
    // radar's own size and its screen corner are measured when the window size changes, with a slow
    // refresh as a safety net, rather than every frame. Our scale is a transform, which changes neither.
    var measured = { t: -1e9, iw: 0, ih: 0, sonar: null, containerW: 0, corner: null };
    function resetMeasure() { measured.t = -1e9; measured.sonar = null; measured.corner = null; measured.containerW = 0; }
    function measure() {
        var t = now(), iw = window.innerWidth, ih = window.innerHeight, ok = measured.sonar && measured.corner;
        if (ok && iw === measured.iw && ih === measured.ih && t - measured.t < 30000) return measured;
        if (!ok && t - measured.t < 1000) return measured;  // hidden: retry once a second, not every frame
        measured.t = t; measured.iw = iw; measured.ih = ih;
        var s = dom.sonar, w = s.offsetWidth, h = s.offsetHeight;
        if (!(w > 0 && h > 0)) {
            var r = s.getBoundingClientRect(), k = currentScale || 1;
            w = (r.right - r.left) / k; h = (r.bottom - r.top) / k;
        }
        measured.sonar = w > 0 && h > 0 ? { w: w, h: h } : null;
        var cw = dom.container.offsetWidth;
        measured.containerW = cw > 0 ? cw : 0;
        // The view cone is a box in the radar's top-left; it has to turn about the radar's centre.
        var cone = dom.cone, cl = cone ? cone.offsetLeft : NaN, ct = cone ? cone.offsetTop : NaN;
        measured.coneOrigin = finite(cl) && finite(ct) && measured.sonar
            ? (measured.sonar.w / 2 - cl).toFixed(2) + 'px ' + (measured.sonar.h / 2 - ct).toFixed(2) + 'px' : '83.3333% 83.3333%';
        // Grow away from the nearest screen corner so the radar keeps its margin to the edges.
        var cr = dom.container.getBoundingClientRect();
        measured.corner = cr.width > 0 ? { ox: (cr.left + cr.right) / 2 < iw / 2 ? '0%' : '100%', oy: (cr.top + cr.bottom) / 2 < ih / 2 ? '0%' : '100%' } : null;
        return measured;
    }
    function layoutSize() { return measure().sonar || { w: 0, h: 0 }; }
    function applySize() {
        var scale = clamp(option('radar_size'), 30, 300) / 100;
        var c = dom.container, corner = measure().corner;
        var ox = corner ? corner.ox : '100%', oy = corner ? corner.oy : '0%';  // hidden: keep the game's top-right anchor
        var key = scale + '|' + ox + '|' + oy;
        if (key !== lastLayoutKey) {
            lastLayoutKey = key;
            setStyle(c, 'transformOrigin', ox + ' ' + oy);
            setStyle(c, 'transform', scale === 1 ? '' : 'scale(' + scale + ')');
            log('size ' + Math.round(scale * 100) + '% origin ' + ox + ' ' + oy);
        }
        currentScale = scale;
    }
    function applyShape(shape) {
        var square = shape !== 0;
        var cls = 'rp-layer' + (shape === 1 ? ' rp-layer--square' : shape === 2 ? ' rp-layer--rounded' : '');
        if (dom.layer.className !== cls) dom.layer.className = cls;
        // Outer radius 14% of the box; the inset parts use 10% of theirs so the band stays even.
        var outer = shape === 2 ? '14%' : '0', inset = shape === 2 ? '10%' : '0';
        setStyle(dom.glass, 'borderRadius', outer);
        setStyle(dom.inner, 'borderRadius', inset);
        show(dom.glass, square);
        show(dom.inner, square);
        if (dom.sonar.classList && dom.sonar.classList.contains('rp-square') !== square) dom.sonar.classList.toggle('rp-square', square);
        // Hidden, not only transparent: .sonar__bg holds the game's blurred glass, which could otherwise
        // still be blurred every frame underneath ours.
        for (var i = 0; i < dom.round.length; i++) {
            if (!dom.round[i]) continue;
            setStyle(dom.round[i], 'opacity', square ? '0' : '');
            setStyle(dom.round[i], 'visibility', square ? 'hidden' : '');
        }
        if (square) {
            // The game's inner ring (hidden here) shows combat and objective areas; our inner line does now.
            var icls = 'rp-inner' + (model('hud_sonar_inside_objective_area', false) ? ' rp-inner--objective' : '') +
                (model('hud_sonar_in_combat', false) ? ' rp-inner--combat' : '');
            if (dom.inner.className !== icls) dom.inner.className = icls;
        }
    }

    // ------------------------------------------------------------------ square and rounded edges
    // Outline geometry: a closed polyline at distance h from the centre, clockwise from the top centre.
    // kind 0 is the square, 1 rounded (the outline's corner radius shifted by the offset), 2 a circle.
    // Angles are measured clockwise from "up", like CSS rotations.
    var outlines = {};
    function outline(half, h, kind) {
        var key = half.toFixed(2) + '|' + h.toFixed(2) + '|' + kind;
        if (outlines[key]) return outlines[key];
        var R = kind === 2 ? h : kind === 1 ? Math.max(0, CORNER * half + (h - half)) : 0, c = h - R, pts = [[0, -h]], N = 12;
        [[c, -c, 0], [c, c, 0.5], [-c, c, 1], [-c, -c, 1.5]].forEach(function (k) {
            if (R <= 0) { pts.push([k[0] > 0 ? h : -h, k[1] > 0 ? h : -h]); return; }
            for (var i = 0; i <= N; i++) { var a = (k[2] + i / N * 0.5) * Math.PI; pts.push([k[0] + R * Math.sin(a), k[1] - R * Math.cos(a)]); }
        });
        pts.push([0, -h]);
        var ang = [], cum = [0];
        for (var i = 0; i < pts.length; i++) {
            var a = Math.atan2(pts[i][0], -pts[i][1]);
            if (a < 0) a += 2 * Math.PI;
            ang.push(i === pts.length - 1 ? 2 * Math.PI : a);
            if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        }
        ang[0] = 0;
        var o = { pts: pts, ang: ang, cum: cum, len: cum[cum.length - 1] };
        outlines[key] = o;
        return o;
    }
    function wrapAngle(a) { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }
    // Where the ray at angle a crosses the outline: {x, y, s} (s = distance along the outline).
    function pointAtAngle(o, a) {
        a = wrapAngle(a);
        var lo = 0, hi = o.ang.length - 1;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (o.ang[mid] <= a) lo = mid; else hi = mid; }
        var p = o.pts[lo], q = o.pts[hi], dx = q[0] - p[0], dy = q[1] - p[1];
        var ux = Math.sin(a), uy = -Math.cos(a), den = ux * dy - uy * dx;
        var t = Math.abs(den) > 1e-9 ? clamp((p[0] * uy - p[1] * ux) / den, 0, 1) : 0;
        return { x: p[0] + dx * t, y: p[1] + dy * t, s: o.cum[lo] + (o.cum[hi] - o.cum[lo]) * t };
    }
    function pointAtS(o, s) {
        s %= o.len; if (s < 0) s += o.len;
        var lo = 0, hi = o.cum.length - 1;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (o.cum[mid] <= s) lo = mid; else hi = mid; }
        var seg = o.cum[hi] - o.cum[lo], t = seg > 0 ? (s - o.cum[lo]) / seg : 0, p = o.pts[lo], q = o.pts[hi];
        return { x: p[0] + (q[0] - p[0]) * t, y: p[1] + (q[1] - p[1]) * t, s: s };
    }
    // Outward normal from the chord across s-d .. s+d; turns smoothly around corners.
    function normalAt(o, s, d) {
        var a = pointAtS(o, s - d), b = pointAtS(o, s + d), dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        return { x: dy / l, y: -dx / l };
    }
    function svgPath(o, ox, oy) {
        var d = '';
        for (var i = 0; i < o.pts.length - 1; i++) d += (i ? 'L' : 'M') + (ox + o.pts[i][0]).toFixed(2) + ' ' + (oy + o.pts[i][1]).toFixed(2);
        return d + 'Z';
    }
    function px(v) { return v.toFixed(2) + 'px'; }

    // An SVG canvas `pad` px bigger than the radar on every side, wrapped in a div moved by transform.
    function svgBox(parent, paths, W, H, pad) {
        var holder = document.createElement('div');
        holder.className = 'rp-svgbox';
        holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
            paths + '</svg>';
        var svg = holder.querySelector('svg');
        if (!svg) return null;
        setStyle(holder, 'width', W + 'px'); setStyle(holder, 'height', H + 'px');
        setStyle(holder, 'transform', 'translate(' + (-pad) + 'px, ' + (-pad) + 'px)');
        parent.insertBefore(holder, parent.firstChild);
        return svg;
    }
    // The SVGs hold static paths only (rebuilt when shape or size changes); everything that moves
    // does so through stroke dashes and CSS transforms.
    function ensureChrome(half, hw, hh, kind) {
        var key = half.toFixed(2) + '|' + kind;
        if (dom.svgKey === key && dom.outline) return true;
        var olds = dom.chrome.querySelectorAll('.rp-svgbox');
        for (var o = 0; o < olds.length; o++) if (olds[o].parentNode) olds[o].parentNode.removeChild(olds[o]);
        dom.outline = null;
        var vh = window.innerHeight / 100, pad = Math.ceil(half * 0.4), W = Math.ceil(2 * hw + 2 * pad), H = Math.ceil(2 * hh + 2 * pad);
        var sw = Math.max(1, 0.1388888889 * vh), aw = Math.max(1.5, 0.23 * vh);
        var body = outline(half, half - sw / 2, kind), ringOut = outline(half, half * OBJECTIVE_RING, kind),
            ringIn = outline(half, half * OBJECTIVE_RING_BETWEEN, kind);
        var cx = pad + hw, cy = pad + hh;
        var outlineSvg = svgBox(dom.outlineGroup, '<path class="rp-outline" d="' + svgPath(body, cx, cy) +
            '" fill="none" stroke="#e8e8e8" stroke-width="' + sw.toFixed(2) + '"/>', W, H, pad);
        if (!outlineSvg) return false;
        dom.outline = outlineSvg.querySelector('.rp-outline');
        var arcs = '<path class="rp-arc rp-arc--out" d="' + svgPath(ringOut, cx, cy) + '" fill="none" stroke="#fbe732" stroke-width="' +
            aw.toFixed(2) + '" style="display:none"/>' + '<path class="rp-arc rp-arc--in" d="' + svgPath(ringIn, cx, cy) +
            '" fill="none" stroke="#fbe732" stroke-width="' + aw.toFixed(2) + '" style="display:none"/>';
        for (var k = 0; k < dom.objectives.length; k++) {
            var slot = dom.objectives[k], svg = svgBox(slot.group, arcs, W, H, pad);
            slot.out = svg ? svg.querySelector('.rp-arc--out') : null;
            slot.inner = svg ? svg.querySelector('.rp-arc--in') : null;
        }
        dom.geo = { body: body, ringOut: ringOut, ringIn: ringIn, arrow: outline(half, half * OBJECTIVE_ARROW, kind), sw: sw, pad: pad };
        for (var l = 0; l < dom.legs.length; l++) setStyle(dom.legs[l], 'height', px(sw));
        setStyle(dom.ear, 'transform', 'translate(' + (-pad) + 'px, ' + (-pad) + 'px)');
        setStyle(dom.ear, 'width', W + 'px'); setStyle(dom.ear, 'height', H + 'px');
        dom.svgKey = key;
        return !!dom.outline;
    }
    function hideObjective(slot) {
        if (!slot.shown) return;
        slot.shown = false;
        show(slot.group, false);
    }
    // The native objective indicator is a ring cut by two half-planes: the clip half turned by a,
    // and inside it the fill half turned by a + b. What stays visible is their overlap.
    function objectiveSpan(clip, fill) {
        var a = parseAngle(clip), b = parseAngle(fill);
        if (a === null || b === null) return null;
        b = wrapAngle(b + Math.PI) - Math.PI;
        return b >= 0 ? { from: a + b, to: a + Math.PI } : { from: a, to: a + Math.PI + b };
    }

    // ------------------------------------------------------------------ lock rotation (north up)
    // The game turns its sonar with the camera through data bindings, which update at their own moment
    // in the frame: anything counter-rotated against them wobbles. So with the rotation locked the game's
    // moving parts are hidden and our own copies shown, all placed from one reading of the game's values
    // per frame: each icon (copied like the world markers), the north axis (outline, notch and "N",
    // static at north), the glass and the player marker. The view cone has no binding and is just turned.
    function lockedCopy(el) {
        // A binding-free copy in a full-size wrapper right after the original, so it stacks the same.
        if (!el || !el.parentNode) return null;
        var wrap = document.createElement('div'); wrap.className = 'rp-lk-wrap';
        var copy = copyIcon(el);
        setStyle(copy.root, 'visibility', ''); setStyle(copy.root, 'opacity', '');  // the original may be hidden or faded
        wrap.appendChild(copy.root);
        el.parentNode.insertBefore(wrap, el.nextSibling);
        syncIcon(copy);
        return { wrap: wrap, copy: copy };
    }
    function dropCopy(c) { if (c && c.wrap.parentNode) c.wrap.parentNode.removeChild(c.wrap); }
    function setLocked(on) {
        var lk = dom.lk;
        if (lk.on === on || !dom.sonar) return;
        lk.on = on;
        if (dom.sonar.classList && dom.sonar.classList.contains('rp-locked') !== on) dom.sonar.classList.toggle('rp-locked', on);
        if (on) {
            lk.bg = lockedCopy(dom.bg);
            lk.axis = lockedCopy(dom.axis);
            lk.player = lockedCopy(dom.player);
            lk.label = lk.axis ? lk.axis.copy.root.querySelector('.sonar__axis__north-label') : null;
            lk.shape = lk.axis ? lk.axis.copy.root.querySelector('.sonar__axis__shape') : null;
            lk.icon = lk.player ? lk.player.copy.root.querySelector('.sonar__center-player__icon') : null;
            lk.layer = document.createElement('div'); lk.layer.className = 'rp-lk';
            dom.sonar.appendChild(lk.layer);
        } else {
            [lk.bg, lk.axis, lk.player].forEach(dropCopy);
            if (lk.layer && lk.layer.parentNode) lk.layer.parentNode.removeChild(lk.layer);
            lk.bg = lk.axis = lk.player = lk.layer = lk.label = lk.shape = lk.icon = null;
            if (dom.pois) dom.pois.forEach(function (e) { e.lk = null; });
            lk.cone = null;
            turnCone(null);
            lk.shapeKey = '';
        }
        [dom.bg, dom.axis, dom.player].forEach(function (n) { setStyle(n, 'visibility', on ? 'hidden' : ''); });
    }
    // The view cone is a box in the radar's top-left: it turns about the radar's centre.
    function turnCone(deg) {
        var key = deg === null ? '' : deg.toFixed(2);
        if (!dom.cone || dom.lk.cone === key) return;
        dom.lk.cone = key;
        setStyle(dom.cone, 'transformOrigin', key ? (measure().coneOrigin || '83.3333% 83.3333%') : '');
        setStyle(dom.cone, 'transform', key ? 'rotate(' + key + 'deg)' : '');
    }
    function lockedIcon(e) {
        if (!e.poi || !dom.lk.layer) return null;
        if (!e.lk || e.lk.live !== e.poi || e.lk.wrap.parentNode !== dom.lk.layer) {
            if (e.lk && e.lk.wrap.parentNode) e.lk.wrap.parentNode.removeChild(e.lk.wrap);
            var wrap = document.createElement('div'); wrap.className = 'rp-lk-poi';
            var copy = copyIcon(e.poi);
            wrap.appendChild(copy.root);
            dom.lk.layer.appendChild(wrap);
            syncIcon(copy);
            e.lk = { wrap: wrap, copy: copy, live: e.poi, at: '' };
        }
        return e.lk;
    }

    // Locked, the game's own numbers are not steady enough while the camera turns: the north angle and
    // the icons' camera-relative positions come from slightly different moments, so turning one back by
    // the other leaves a jitter. So each icon's direction is taken from the world instead (its world
    // position minus the player's, from the DLL), turned into the radar's north-up frame; only its
    // distance from the centre comes from the game, which doesn't depend on the camera. The world-to-
    // radar orientation (a turn, possibly mirrored) is learned from the game's sonar itself: every visible
    // icon pairs a world direction with the direction the game draws it at, turned back by north. The
    // pairs are averaged over about a second, which evens out the camera noise.
    var compass = { rc: 0, rs: 0, fc: 0, fs: 0, n: 0, phi: 0, flip: false, ready: false, quality: 0, lastLog: 0 };
    function learnCompass(dx, dz, vx, vy) {
        var dl = Math.sqrt(dx * dx + dz * dz), vl = Math.sqrt(vx * vx + vy * vy);
        if (dl < 1 || vl < 2) return;
        dx /= dl; dz /= dl; vx /= vl; vy /= vl;
        compass.rc += dx * vx + dz * vy; compass.rs += dx * vy - dz * vx;  // turned
        compass.fc += dx * vx - dz * vy; compass.fs += dx * vy + dz * vx;  // turned and mirrored
        compass.n += 1;
    }
    function settleCompass() {
        var qr = Math.sqrt(compass.rc * compass.rc + compass.rs * compass.rs), qf = Math.sqrt(compass.fc * compass.fc + compass.fs * compass.fs);
        if (compass.n >= 3) {
            // Both fit a single direction; a second direction tells them apart, hence the margin.
            var flip = qf > qr, q = (flip ? qf : qr) / compass.n, other = (flip ? qr : qf) / compass.n;
            if (q > 0.9 && q - other > 0.05) {
                compass.flip = flip;
                compass.phi = flip ? Math.atan2(compass.fs, compass.fc) : Math.atan2(compass.rs, compass.rc);
                compass.ready = true;
            }
            compass.quality = q;
        }
        var k = compass.ready && compass.n > 500 ? 0.999 : 0.98;  // learn in about a second, then average over ~10 s
        compass.rc *= k; compass.rs *= k; compass.fc *= k; compass.fs *= k; compass.n *= k;
    }
    // World XZ offset to a unit direction on the north-up radar (x right, y down), or null.
    function compassDir(dx, dz) {
        var l = Math.sqrt(dx * dx + dz * dz);
        if (!compass.ready || l < 0.5) return null;
        dx /= l; dz /= l;
        if (compass.flip) dz = -dz;
        var c = Math.cos(compass.phi), sn2 = Math.sin(compass.phi);
        return { x: dx * c - dz * sn2, y: dx * sn2 + dz * c };
    }
    function worldForLock() {
        var r = worldFeed.data;
        if (!r || now() - worldFeed.receivedAt > 500 || !r.bySlot || !r.player || r.player.length !== 3 || !r.player.every(finite)) return null;
        return r;
    }

    var edge = { rEdge: 0, samples: 0, arcSamples: 0, error: '', lastSync: 0, lastFeed: 0, lastSample: 0 };
    function updateEdges() {
        if (!dom.pois || !dom.sonar) return;
        // If the game rebuilt the POI elements under us, pick up the new ones.
        if (dom.poisStale || (dom.pois.length && (dom.pois[0].el.parentNode !== dom.sonar || dom.pois[dom.pois.length - 1].el.parentNode !== dom.sonar))) {
            if (dom.lk.on) setLocked(false);
            dom.poisStale = false;
            dom.pois = mapPois(dom.sonar);
            log('poi elements were replaced; re-mapped ' + dom.pois.length, true);
        }
        // Diagnostics: each visible slot's data next to the class of the element we pair it with.
        if (DIAG && now() - edge.lastSample > 5000) {
            edge.lastSample = now();
            var sample = [];
            for (var q = 0; q < dom.pois.length && sample.length < 8; q++) {
                var ep = dom.pois[q], pq = 'hud_sonar_poi_' + ep.index + '_';
                if (!model(pq + 'visible', false)) continue;
                sample.push(ep.index + ': type ' + model(pq + 'map_marker_type', '?') + ' css ' + model(pq + 'type_css_class', '?') +
                    ' -> el "' + (ep.poi ? String(ep.poi.className).slice(0, 80) : '-') + '"');
            }
            log('poi sample: ' + (sample.join(' | ') || 'none visible'));
        }
        // North is read here, every frame, next to the icon positions it turns: the 33 ms loop's copy
        // would be a few frames old while the camera turns, and icons would jump back and forth.
        var square = state.shape !== 0, north = parseAngle(model('hud_sonar_rotation', '')), locked = state.locked && north !== null;
        // The map turns every frame too (its tiles move with the position feed); locked, it stays north up.
        if (dom.origin && north !== null) setStyle(dom.origin, 'transform', 'rotate(' + (locked ? 0 : north * 180 / Math.PI).toFixed(3) + 'deg)');
        setLocked(locked);
        var active = state.hudOn && (square || locked);
        var size = active ? layoutSize() : null;
        var hw = size ? size.w / 2 : 0, hh = size ? size.h / 2 : 0, half = Math.min(hw, hh);
        var r1 = half * RING_FRACTION, rounded = state.shape === 2, kind = square ? (rounded ? 1 : 0) : 2;
        // Rounded: a path at distance h from the centre keeps the outline's corner, shrunk by the inset.
        function cornerAt(h) { return rounded ? Math.max(0, CORNER * half - (half - h)) : 0; }
        // Our own objective arcs: always for square and rounded; for the circle too while locked.
        var chrome = active && half > 0 && ensureChrome(half, hw, hh, kind);
        show(dom.chrome, !!chrome);
        show(dom.outlineGroup, square); show(dom.ear, square);
        var geo = chrome ? dom.geo : null, vh = window.innerHeight / 100, used = 0, t0 = now();
        var sync = locked && t0 - edge.lastSync >= 100;
        if (sync) edge.lastSync = t0;
        // Locked: the game places icons with the camera's heading up; turning them by -north puts north
        // up. cs/sn are 1/0 (no turn) otherwise.
        var turn = active && locked, cs = turn ? Math.cos(north) : 1, sn = turn ? Math.sin(north) : 0;
        // Radar icons: which kinds the radar shows. None also drops the game's objective ring.
        var iconLevel = level('radar_icons'), filtering = iconLevel !== LEVEL_ALL, picked = iconLevel === LEVEL_CUSTOM;
        var noArcs = iconLevel === LEVEL_NONE || (picked && !!filters.r.objective);
        if (dom.sonar.classList && dom.sonar.classList.contains('rp-no-arcs') !== noArcs) dom.sonar.classList.toggle('rp-no-arcs', noArcs);
        // Icon distance: how far away radar icons may be, from the world positions the DLL reports. While
        // the HUD is hidden they are still fetched now and then, so the icons are sorted when it's back.
        var iconRange = clamp(option('radar_icon_range'), ICON_RANGE_MIN, ICON_RANGE_MAX);
        var byKind = filtering, byDistance = !!NATIVE.world && iconRange < ICON_RANGE_MAX;
        filtering = byKind || byDistance;
        if (NATIVE.world && (turn || (byDistance && (state.hudOn || t0 - edge.lastFeed >= 250)))) { edge.lastFeed = t0; tickWorldFeed(t0); }
        var feed = turn || byDistance ? worldForLock() : null, wd = turn ? feed : null;
        for (var j = 0; j < dom.pois.length; j++) {
            var e = dom.pois[j], want = '', at = '', pre = 'hud_sonar_poi_' + e.index + '_', vis = model(pre + 'visible', false);
            var shown = active && half > 0 && vis;
            // Filtering, a slot stays hidden until it shows a wanted kind, so an unwanted icon never flashes
            // up for a frame before the filter sees it. Objective arcs go by the kind alone.
            var kind = filtering ? slotKind(pre) : '';
            var wanted = !byKind || (picked ? !filters.r[slotKey(pre)] : kindWanted(kind, iconLevel));
            if (!vis) { e.far = e.farKnown = false; e.farSince = 0; }
            var near = !byDistance || !vis || kind === 'tracked' || kind === 'pin' || !iconFar(e, feed, iconRange, t0);
            var iconOn = !filtering || (vis && wanted && near);
            e.lkDir = null;
            if (shown) {
                var raw = model(pre + 'transform', null), t = parseTranslation(raw);
                if (t) {
                    var vx = t.x - hw, vy = t.y - hh;
                    var qx = vx * cs + vy * sn, qy = -vx * sn + vy * cs;  // where we want it
                    var w = wd && wd.bySlot[e.index];
                    if (w) {
                        // Locked: the direction from the world, the distance from the game.
                        var ox = w[1] - wd.player[0], oz = w[3] - wd.player[2];
                        learnCompass(ox, oz, qx, qy);
                        var dir = compassDir(ox, oz), rad = Math.sqrt(vx * vx + vy * vy);
                        if (dir) { qx = dir.x * rad; qy = dir.y * rad; e.lkDir = dir; }
                    }
                    var r = Math.sqrt(qx * qx + qy * qy);
                    if (square && r > r1 * 0.5) {
                        var ux = qx / r, uy = qy / r, target = r;
                        var outside = !!model(pre + 'is_outside', false);
                        if (outside) {
                            if (r > r1) edge.rEdge = Math.max(edge.rEdge * 0.999, r);
                            target = boundary(ux, uy, r, cornerAt(r));
                        } else if (r > r1) {
                            // Between the inner ring and the edge: stretch that band out to our edge.
                            var re = Math.max(edge.rEdge || half * 0.95, r);
                            var b = boundary(ux, uy, re, cornerAt(re));
                            target = re > r1 ? r1 + (r - r1) * (b - r1) / (re - r1) : b;
                        }
                        qx = ux * target; qy = uy * target;
                    }
                    if (turn) {
                        at = 'translate(' + (hw + qx).toFixed(1) + 'px, ' + (hh + qy).toFixed(1) + 'px)';
                    } else {
                        var dx = qx - vx, dy = qy - vy;
                        if (Math.abs(dx) >= 0.25 || Math.abs(dy) >= 0.25)
                            want = 'translate(-50%, -50%) translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px)';
                    }
                }
            }
            if (e.applied !== want) { e.el.style.transform = want; e.applied = want; }
            setStyle(e.el, 'visibility', iconOn ? '' : 'hidden');
            // Locked: our copy of the icon; its classes follow the game's (so it fades in and out the same).
            if (turn) {
                var lkIcon = at ? lockedIcon(e) : e.lk;
                if (lkIcon) {
                    setStyle(lkIcon.wrap, 'visibility', iconOn ? '' : 'hidden');
                    if (at && lkIcon.at !== at) { setStyle(lkIcon.copy.root, 'transform', at); lkIcon.at = at; }
                    if (sync) syncIcon(lkIcon.copy);
                }
            }

            // Objective marker: the game's ring arc only fits a circle turning with the camera, so we draw
            // our own. The game's own (.poi__distance, a full-size sibling of the POI containers) is hidden
            // by the .rp-square / .rp-locked rules while ours is drawn.
            if (chrome && wanted && !noArcs && used < ARC_SLOTS && model(pre + 'distance_indicator_visible', false)) {
                var theta = parseAngle(model(pre + 'rotation', '')), wo = turn && wd && wd.bySlot[e.index];
                var od = e.lkDir || (wo ? compassDir(wo[1] - wd.player[0], wo[3] - wd.player[2]) : null);
                if (turn && od) theta = Math.atan2(od.x, -od.y);  // the objective's world direction
                else if (theta !== null && turn) theta -= north;
                if (DIAG && turn && t0 - (edge.lastObjLog || 0) > 3000) {
                    edge.lastObjLog = t0;
                    log('objective ' + e.index + ' locked: ' + (od ? 'world direction ' + (theta * 180 / Math.PI).toFixed(1) + ' deg' : 'camera fallback') +
                        ', icon ' + (e.lkDir ? 'placed' : 'not placed') + ', world entry ' + !!wo);
                }
                var span = objectiveSpan(model(pre + 'distance_indicator_clip_transform', ''), model(pre + 'distance_indicator_fill_transform', ''));
                if (DIAG && edge.arcSamples < 4) {
                    edge.arcSamples++;
                    log('objective ' + e.index + ' rotation=' + JSON.stringify(model(pre + 'rotation', null)) + ' clip=' +
                        JSON.stringify(model(pre + 'distance_indicator_clip_transform', null)) + ' fill=' +
                        JSON.stringify(model(pre + 'distance_indicator_fill_transform', null)) + ' outside=' + model(pre + 'is_outside', null) +
                        ' between=' + model(pre + 'is_between', null));
                }
                if (theta !== null) {
                    var slot = dom.objectives[used], between = !!model(pre + 'is_between', false) && !model(pre + 'is_outside', false);
                    var ring = between ? geo.ringIn : geo.ringOut, path = between ? slot.inner : slot.out, other = between ? slot.out : slot.inner;
                    var from = theta + (span ? span.from : -Math.PI / 8), to = theta + (span ? span.to : Math.PI / 8);
                    var s1 = pointAtAngle(ring, from).s, s2 = pointAtAngle(ring, to).s, len = ((s2 - s1) % ring.len + ring.len) % ring.len;
                    // Far-away objectives fade to half, as a whole (see .rp-objective).
                    setStyle(slot.group, 'opacity', model(pre + 'is_far_away', false) ? '0.5' : '');
                    if (path && len > 0.5) {
                        setStyle(path, 'display', '');
                        setStyle(path, 'strokeDasharray', len.toFixed(2) + ' ' + (ring.len - len).toFixed(2));
                        setStyle(path, 'strokeDashoffset', ((ring.len - s1) % ring.len).toFixed(2));
                    } else setStyle(path, 'display', 'none');
                    setStyle(other, 'display', 'none');
                    if (model(pre + 'is_outside', false)) {
                        var pa = pointAtAngle(geo.arrow, theta), n = normalAt(geo.arrow, pa.s, half * 0.05);
                        setStyle(slot.arrow, 'transform', 'translate(' + px(hw + pa.x) + ', ' + px(hh + pa.y) + ') translate(-50%, -100%) rotate(' +
                            (Math.atan2(n.x, -n.y) * 180 / Math.PI).toFixed(2) + 'deg)');
                        show(slot.arrow, true);
                    } else show(slot.arrow, false);
                    if (!slot.shown) { slot.shown = true; show(slot.group, true); }
                    used++;
                }
            }
        }
        for (var k = used; k < dom.objectives.length; k++) hideObjective(dom.objectives[k]);
        if (turn && wd) {
            settleCompass();
            if (DIAG && t0 - compass.lastLog > 3000) {
                compass.lastLog = t0;
                log('compass: ' + (compass.ready ? 'ready' : 'learning') + ', turn ' + (compass.phi * 180 / Math.PI).toFixed(2) + ' deg' +
                    (compass.flip ? ' mirrored' : '') + ', quality ' + compass.quality.toFixed(4) + ', weight ' + compass.n.toFixed(1));
            }
        }

        // Locked: the copies. The axis and glass copies stay at north; square and rounded hide their
        // round art like the originals'. The player marker turns by its facing minus north.
        var lk = dom.lk;
        if (lk.on) {
            var shapeKey = square ? 'sq' : 'c';
            if (lk.shapeKey !== shapeKey) {
                lk.shapeKey = shapeKey;
                if (lk.bg) show(lk.bg.wrap, !square);
                setStyle(lk.shape, 'visibility', square ? 'hidden' : ''); setStyle(lk.shape, 'opacity', square ? '0' : '');
            }
            if (sync) { if (lk.axis) syncIcon(lk.axis.copy); if (lk.player) syncIcon(lk.player.copy); }
            var face = parseAngle(model('hud_sonar_player_rotation', ''));
            if (lk.icon && face !== null) setStyle(lk.icon, 'transform', 'translate(-50%, -50%) rotate(' + ((face - north) * 180 / Math.PI).toFixed(2) + 'deg)');
        }
        turnCone(turn ? -north * 180 / Math.PI : null);

        // North: the outline opens where north crosses it and two legs rise into a right-angled
        // point, like the ear on the game's round outline. The "N" sits just beyond the point.
        var nwant = '', lkLabel = '';
        if (chrome && square && north !== null) {
            var body = geo.body, w = half * NOTCH_HALF_WIDTH, h = half * NOTCH_HEIGHT;
            var p0 = pointAtAngle(body, turn ? 0 : north), bm = pointAtS(body, p0.s - w), bp = pointAtS(body, p0.s + w);
            var nn = normalAt(body, p0.s, w), tip = { x: p0.x + nn.x * h, y: p0.y + nn.y * h };
            var gap = 2 * w, offs = ((body.len - gap - (p0.s - w)) % body.len + body.len) % body.len;
            setStyle(dom.outline, 'strokeDasharray', (body.len - gap).toFixed(2) + ' ' + gap.toFixed(2));
            setStyle(dom.outline, 'strokeDashoffset', offs.toFixed(2));
            [bm, bp].forEach(function (base, i) {
                var lx = tip.x - base.x, ly = tip.y - base.y, len = Math.hypot(lx, ly);
                setStyle(dom.legs[i], 'width', px(len + geo.sw / 2));
                setStyle(dom.legs[i], 'transform', 'translate(' + px(hw + base.x) + ', ' + px(hh + base.y - geo.sw / 2) + ') rotate(' +
                    (Math.atan2(ly, lx) * 180 / Math.PI).toFixed(2) + 'deg)');
            });
            var ox = geo.pad + hw, oy = geo.pad + hh;
            setStyle(dom.ear, 'clipPath', 'polygon(' + px(ox + bm.x) + ' ' + px(oy + bm.y) + ', ' + px(ox + tip.x) + ' ' + px(oy + tip.y) + ', ' +
                px(ox + bp.x) + ' ' + px(oy + bp.y) + ')');
            // The game's label hangs off its rotating axis: express our target in the axis' own frame.
            // Locked, our copy of the axis doesn't turn, so its label just goes to the notch.
            var off = 0.7407407407 * vh, tx = p0.x + nn.x * off, ty = p0.y + nn.y * off;
            if (turn) lkLabel = northLabel(tx, ty, hh + off, 0);
            else nwant = northLabel(tx, ty, hh + off, north);
        }
        if (dom.north) setStyle(dom.north, 'transform', nwant);
        if (lk.label) setStyle(lk.label, 'transform', lkLabel);
        if (DIAG && chrome) logPois(hw, hh);
    }

    // Transform for the "N" label, which hangs off an axis turned by north: (tx, ty) is where its bottom
    // centre should go (from the radar's centre), rest the distance of its own anchor above the centre.
    function northLabel(tx, ty, rest, north) {
        var c = Math.cos(north), s2 = Math.sin(north);
        var lx = tx * c + ty * s2, ly = -tx * s2 + ty * c;  // rotate back by -north
        return 'translate(-50%, -100%) translate(' + px(lx) + ', ' + px(ly + rest) + ')';
    }

    // Diagnostics: what the game reports for each visible POI versus where it actually renders.
    function logPois(hw, hh) {
        var t = now();
        if (t - (edge.lastPoiLog || 0) < 5000) return;
        edge.lastPoiLog = t;
        var sr = dom.sonar.getBoundingClientRect(), scale = sr.width / (2 * hw) || 1, lines = [];
        for (var j = 0; j < dom.pois.length && lines.length < 12; j++) {
            var e = dom.pois[j], pre = 'hud_sonar_poi_' + e.index + '_';
            var vis = model(pre + 'visible', null), dv = model(pre + 'distance_indicator_visible', null);
            if (!vis && !dv) continue;
            var raw = model(pre + 'transform', null), tr = parseTranslation(raw), pr = e.poi ? e.poi.getBoundingClientRect() : null;
            var rendered = pr && (pr.width > 0 || pr.height > 0)
                ? (((pr.left + pr.right) / 2 - sr.left) / scale - hw).toFixed(1) + ',' + (((pr.top + pr.bottom) / 2 - sr.top) / scale - hh).toFixed(1) : 'none';
            lines.push('#' + e.index + ' vis=' + vis + ' out=' + model(pre + 'is_outside', null) + ' betw=' + model(pre + 'is_between', null) +
                ' ind=' + dv + ' model=' + (tr ? (tr.x - hw).toFixed(1) + ',' + (tr.y - hh).toFixed(1) : JSON.stringify(raw)) +
                ' rendered=' + rendered + ' applied="' + e.applied + '"');
        }
        log('pois: sonar ' + sr.width.toFixed(1) + 'x' + sr.height.toFixed(1) + ' scale ' + scale.toFixed(3) + ' half ' + hw.toFixed(1) +
            ' rp-square=' + (dom.sonar.classList ? dom.sonar.classList.contains('rp-square') : '?') + ' | ' + (lines.join(' | ') || 'none visible'));
    }

    // ------------------------------------------------------------------ terrain
    function requestTile(t, url) {
        releaseTile(t);
        t.src = url;
        try {
            t.token = streaming.acquire(url, function (w) {
                if (t.token !== w || !w.active) return;
                if (!streaming.ready(w)) { releaseTile(t); t.failedUrl = url; return; }
                var im = new Image();
                t.preload = im;
                im.onload = function () { if (t.token !== w || !w.active) return; t.node.src = url; t.loaded = true; t.preload = null; };
                im.onerror = function () { if (t.token !== w || !w.active) return; releaseTile(t); t.failedUrl = url; };
                im.src = url;
            });
        } catch (e) { releaseTile(t); t.failedUrl = url; log('tile request failed: ' + e); }
    }
    function drawTerrain(p, shape) {
        var atlas = atlasCache[String(p.district)];
        var ring = model('hud_sonar_in_combat', false) ? zoom.rings[2] : zoom.rings[0];
        if (!(ring > 0)) ring = 40;
        var size = layoutSize(), minSide = Math.min(size.w, size.h);
        var pxPerMetre = minSide * RING_FRACTION / 2 / ring;
        var sx = pxPerMetre * UNIT_METRES_X, sy = pxPerMetre * UNIT_METRES_Y;
        var factor = p.uiHeight / 1080, cx = p.x / factor, cy = p.y / factor;
        // Map units visible from the centre to the layer's corner, plus a margin for rotation.
        var layerHalf = (shape === 0 ? minSide : Math.sqrt(size.w * size.w + size.h * size.h)) * RING_FRACTION / 2;
        var reach = layerHalf / Math.min(sx, sy) * 1.1;
        var requested = 0, loaded = 0;
        for (var i = 0; i < dom.tiles.length; i++) {
            var t = dom.tiles[i], a = atlas && atlas.tiles[i];
            var hit = a && a.x < cx + reach && a.x + a.w > cx - reach && a.y < cy + reach && a.y + a.h > cy - reach;
            if (!hit) { if (t.src) releaseTile(t); show(t.node, false); continue; }
            var url = TILE_ROOT + a.path + '.png';
            if (t.src !== url && t.failedUrl !== url) requestTile(t, url);
            if (t.failedUrl === url) { show(t.node, false); continue; }
            requested++;
            if (t.loaded) loaded++;
            show(t.node, t.loaded);
            setStyle(t.node, 'width', (a.w * sx).toFixed(2) + 'px');
            setStyle(t.node, 'height', (a.h * sy).toFixed(2) + 'px');
            setStyle(t.node, 'transform', 'translate(' + ((a.x - cx) * sx).toFixed(2) + 'px,' + ((a.y - cy) * sy).toFixed(2) + 'px)');
        }
        return requested > 0 && loaded === requested;
    }

    // ------------------------------------------------------------------ neighbouring HUD pieces
    // Widgets anchored just left of the radar (district name/XP, challenge score). The radar grows
    // leftward from its right edge, so push them left by exactly that growth to keep the game's gap.
    // cohtml ignores margin-right on these absolutely positioned widgets, so we override "right"
    // itself: the game's own offset (UI.bundle.css) plus the growth.
    var NEIGHBOURS = [
        { sel: '.district-xp', rightVh: 27.7777777778 },
        { sel: '.challenge-hud', rightVh: 25.9259259259, skip: /challenge-hud--(timer|time-out)/ }  // centred modes
    ];
    var neighbourEls = {}, neighbourScan = 0, neighbourCheck = 0, lastNeighbourLog = 0;
    function applyNeighbours(extraPx) {
        // Searching the whole HUD is the expensive part: do it every 15 s, or at once if a widget we hold
        // was replaced (the game can rebuild the HUD on a level load).
        var t = now(), rescan = t - neighbourScan > 15000;
        if (!rescan && t - neighbourCheck > 1000) {
            neighbourCheck = t;
            for (var sel in neighbourEls) {
                var held = neighbourEls[sel];
                for (var h = 0; h < held.length && !rescan; h++) if (!connected(held[h])) rescan = true;
            }
        }
        if (rescan) neighbourScan = neighbourCheck = t;
        var vh = window.innerHeight / 100, info = [];
        for (var i = 0; i < NEIGHBOURS.length; i++) {
            var n = NEIGHBOURS[i], els = neighbourEls[n.sel];
            if (rescan || !els) els = neighbourEls[n.sel] = document.querySelectorAll(n.sel);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                var want = extraPx > 0.5 && !(n.skip && n.skip.test(el.className || '')) ? (n.rightVh * vh + extraPx).toFixed(1) + 'px' : '';
                setStyle(el, 'right', want);
                if (DIAG && t - lastNeighbourLog > 5000) {
                    var r = el.getBoundingClientRect();
                    info.push(n.sel + '[' + j + '] right=' + (el.style.right || 'css') + ' rect=' + Math.round(r.left) + '..' + Math.round(r.right) +
                        ' connected=' + connected(el));
                }
            }
        }
        if (info.length) { lastNeighbourLog = t; log('neighbours: growth ' + extraPx.toFixed(1) + 'px | ' + info.join(' | ')); }
    }
    function radarGrowth() {
        var w = dom.container ? measure().containerW : 0;
        if (!(w > 0)) w = 14.8148148148 * window.innerHeight / 100;  // .sonar-container width while hidden
        return Math.max(0, (currentScale - 1) * w);
    }
    // CRModMenu's status line ("Saving... / Saved"): hidden by CSS above; this covers engines that do
    // not support the sibling selector.
    var lastStatusCheck = 0;
    function hideMenuStatus(t) {
        if (t - lastStatusCheck < 500) return;
        lastStatusCheck = t;
        // Only while the options menu is open; otherwise the search would run through the HUD for nothing.
        var menuOpen = window.ui_stacks_menu_options_active;
        if (menuOpen && menuOpen.value !== undefined && !menuOpen.value) return;
        var blocks = document.querySelectorAll('.options-description');
        for (var i = 0; i < blocks.length; i++) {
            var ps = blocks[i].querySelectorAll('.options-description__text');
            if (ps.length >= 2) setStyle(ps[ps.length - 1], 'display', 'none');
        }
    }

    // CRModMenu shows a description as plain text. The game's own name each choice in bold with a
    // paragraph apiece; ours are written the same way (a paragraph per choice, starting with its label),
    // so they read fine as they are. While one of our options is focused, the MODS page shows a copy
    // with the choice labels and hotkeys in bold instead, and CRModMenu's own line is hidden.
    // The game keeps a hidden page as a deep copy of itself (taken 400 ms after it hides, see the
    // game's removeAndCacheVisibleIfElement) and puts that copy back when the page shows again. So a
    // page that comes back has new elements, maybe with an old copy of ours in it, and is looked up anew.
    var OUR_OPTIONS = {};
    Object.keys(DEFAULTS).forEach(function (k) { OUR_OPTIONS['cmm_' + hex(MOD_ID) + '_' + hex(k)] = k; });
    var menuDesc = { src: null, el: null, name: '', text: '', searched: 0, misses: 0, error: '' };
    // CRModMenu's description line: the one bound to its ui_cmm_description model.
    function findMenuDescription() {
        var ps = document.querySelectorAll('.options-description__text');
        for (var i = 0; i < ps.length; i++) {
            var at = ps[i].attributes;
            for (var j = 0; at && j < at.length; j++)
                if (at[j] && typeof at[j].value === 'string' && at[j].value.indexOf('ui_cmm_description') !== -1) return ps[i];
        }
        return null;
    }
    function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function wordEdge(s, i) { return i < 0 || i >= s.length || /[\s.,;:!?()]/.test(s.charAt(i)); }
    // The description as HTML, each term in bold wherever it stands as a word of its own.
    function descriptionHtml(text, terms) {
        var out = '', at = 0;
        for (;;) {
            var best = -1, len = 0;
            for (var j = 0; j < terms.length; j++) {
                var p = text.indexOf(terms[j], at);
                while (p !== -1 && !(wordEdge(text, p - 1) && wordEdge(text, p + terms[j].length))) p = text.indexOf(terms[j], p + 1);
                if (p !== -1 && (best === -1 || p < best || (p === best && terms[j].length > len))) { best = p; len = terms[j].length; }
            }
            if (best === -1) break;
            out += escapeHtml(text.slice(at, best)) + '<b>' + escapeHtml(text.slice(best, best + len)) + '</b>';
            at = best + len;
        }
        return out + escapeHtml(text.slice(at));
    }
    // What goes in bold: the choice labels as CRModMenu shows them, and the hotkeys that the size and
    // range descriptions name.
    function descriptionTerms(key, name) {
        var terms = [], keys = C.keys || {};
        for (var k = 0; k < 8; k++) {
            var v = model('ui_cmm_text_' + name + '_choice_' + k, null);
            if (typeof v !== 'string') break;
            terms.push(v);
        }
        if (key === 'radar_size') terms.push(keys.sizeUp, keys.sizeDown);
        if (key === 'radar_range') terms.push(keys.zoomIn, keys.zoomOut);
        return terms.filter(function (s) { return typeof s === 'string' && s.length > 0; });
    }
    // CRModMenu's line back, ours out.
    function dropMenuDescription() {
        if (menuDesc.src) setStyle(menuDesc.src, 'display', '');
        if (menuDesc.src && menuDesc.src.parentNode) setStyle(menuDesc.src.parentNode, 'pointerEvents', '');
        if (menuDesc.el && menuDesc.el.parentNode) menuDesc.el.parentNode.removeChild(menuDesc.el);
        if (menuDesc.grid && menuDesc.grid.parentNode) menuDesc.grid.parentNode.removeChild(menuDesc.grid);
        menuDesc.el = menuDesc.grid = null; menuDesc.name = menuDesc.text = menuDesc.pick = '';
    }
    function updateMenuDescription(t) {
        var open = window.ui_stacks_menu_options_active;
        if ((open && open.value === false) || model('ui_stacks_menu_options_states_mods_active', true) === false) { menuDesc.misses = 0; return; }
        if (menuDesc.src && !connected(menuDesc.src)) { menuDesc.src = menuDesc.el = menuDesc.grid = null; menuDesc.name = menuDesc.text = menuDesc.pick = ''; }
        if (!menuDesc.src) {
            // Every frame at first (the page's copy goes back in on a frame of its own), then once a second.
            if (menuDesc.misses >= 10 && t - menuDesc.searched < 1000) return;
            menuDesc.searched = t;
            var found = findMenuDescription();
            if (!found || !found.parentNode) { menuDesc.misses++; return; }
            menuDesc.misses = 0;
            // A copy taken while ours showed: our old paragraph and picker out, CRModMenu's line back.
            var old = found.parentNode.querySelectorAll('.rp-desc,.rp-filter');
            for (var i = 0; i < old.length; i++) if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
            setStyle(found, 'display', '');
            setStyle(found.parentNode, 'pointerEvents', '');
            menuDesc.src = found;
        }
        var src = menuDesc.src, name = window.focusedOptionName;
        var key = typeof name === 'string' && Object.prototype.hasOwnProperty.call(OUR_OPTIONS, name) ? OUR_OPTIONS[name] : '';
        var text = key ? model('ui_cmm_description', null) : null;
        if (key && typeof text !== 'string') text = src.textContent;
        if (!text) { if (menuDesc.el) dropMenuDescription(); return; }
        // Custom picked for one of the icon settings: the panel becomes that setting's icon picker, under
        // the description's first paragraph (the whole of it would leave no room).
        var pick = key === 'radar_icons' ? 'r' : key === 'world_markers' ? 'w' : key === 'map_icons' ? 'm' : '';
        if (pick && level(key) !== LEVEL_CUSTOM) pick = '';
        if (menuDesc.el && menuDesc.el.parentNode === src.parentNode && menuDesc.name === name && menuDesc.text === text && menuDesc.pick === pick) return;
        // A new paragraph for each text, made the way the game makes its own (inline bold runs).
        var body = pick ? text.split('\n\n')[0] + '\n\n' + PICK_TEXT : text;
        var holder = document.createElement('div');
        holder.innerHTML = '<p class="rp-desc" cohinline>' + descriptionHtml(body, descriptionTerms(key, name)) + '</p>' + (pick ? pickerHtml(pick) : '');
        var el = holder.querySelector('.rp-desc'), grid = pick ? holder.querySelector('.rp-filter') : null;
        if (!el) return;
        // Ahead of CRModMenu's line, so its "Saved" line still follows that one (see the CSS above).
        src.parentNode.insertBefore(el, src);
        if (grid) { src.parentNode.insertBefore(grid, src); wirePicker(grid, pick); }
        if (menuDesc.el && menuDesc.el.parentNode) menuDesc.el.parentNode.removeChild(menuDesc.el);
        if (menuDesc.grid && menuDesc.grid.parentNode) menuDesc.grid.parentNode.removeChild(menuDesc.grid);
        menuDesc.el = el; menuDesc.grid = grid; menuDesc.name = name; menuDesc.text = text; menuDesc.pick = pick;
        // The game's description box ignores the mouse; the picker needs it.
        setStyle(src.parentNode, 'pointerEvents', grid ? 'auto' : '');
        setStyle(src, 'display', 'none');
    }

    // ------------------------------------------------------------------ world markers
    // The DLL reports, for every sonar slot, where its object is in the world, plus the camera the
    // HUD's own world-to-screen transform uses (view-projection, row vectors: clip = [x y z 1] * M).
    // We draw a copy of the slot's sonar icon over the object, in the game's world-tracking layer
    // (full screen, hidden in menus and cutscenes) below its own prompts.
    var WORLD_BASE_SCALE = 1.5;                    // at 100% the icons are 1.5x their sonar size
    var WORLD_LIFT_ACTOR = 2.0, WORLD_LIFT = 0.5;  // metres above the reported position (actors: their feet)
    var WORLD_EDGE_MARGIN = 6;                     // vh kept clear at the screen edge for the tracked objective
    var WORLD_FADE_FROM = 2, WORLD_FADE_TO = 5;    // metres: markers fade out as you arrive
    var WORLD_COMBAT_GRACE = 2000;                 // ms after the fighting stops before markers come back
    var WORLD_TYPES = /(TrackedQuest|Quest|Bounty|MapMarker|Friend|FodderEnemy|HeavyEnemy)/;

    function worldKind(cls) {
        var m = WORLD_TYPES.exec(typeof cls === 'string' ? cls : '');
        var t = m ? m[1] : '';
        if (t === 'TrackedQuest') return 'tracked';
        if (t === 'Quest' || t === 'Bounty') return 'quest';
        if (t === 'Friend') return 'friend';
        if (t === 'FodderEnemy' || t === 'HeavyEnemy') return 'enemy';
        return 'marker';  // map markers and the player's own markers
    }
    // Icon filters, shared by "Radar icons" and "World markers". The values keep what 1.1 saved for the
    // world markers (0 off, 1 objective, 2 markers, 3 all); "pins" came later as 4.
    // "Custom" (5) came with the icon picker: each icon shown or hidden on its own (icon filters, below).
    var LEVEL_NONE = 0, LEVEL_OBJECTIVE = 1, LEVEL_MARKERS = 2, LEVEL_ALL = 3, LEVEL_PINS = 4, LEVEL_CUSTOM = 5;
    function level(key) {
        var v = Math.round(option(key));
        return v >= LEVEL_NONE && v <= LEVEL_CUSTOM ? v : LEVEL_ALL;
    }
    function slotKind(pre) {
        var kind = worldKind(model(pre + 'type_css_class', ''));
        // The player's own map pins: the game shows their numbered marker only while this is false.
        if (kind !== 'tracked' && model(pre + 'is_not_custom_marker', true) === false) kind = 'pin';
        return kind;
    }

    // Icon filters: with Custom, each icon is shown or hidden on its own, separately for r (Radar icons),
    // w (World markers) and m (Main map icons). An icon's key is its kind (objective, pin, quest, bounty,
    // friend, enemy, other) or, for map markers, "m" + its MapMarkerType number; the map's own quest,
    // tracked quest, bounty, friend and enemy types share the kinds' keys, so a tile means the same thing
    // everywhere. CRModMenu can only save numbers, so the DLL keeps the choices in filters.ini.
    var MAP_KEY_ALIAS = { 11: 'objective', 7: 'quest', 3: 'bounty', 39: 'friend', 20: 'enemy' };
    var MAP_PLAYER_TYPES = { 6: 1, 15: 1, 28: 1, 29: 1 };
    // English names for the game's MapMarkerType, until the map's legend gives the game's own.
    var MAP_TYPE_NAMES = ['Ability door', 'Airlock', 'Large chest', 'Bounty', 'Challenge', 'Fast travel point', 'Player',
        'Quest', 'Secret', 'Sign', 'Small chests', 'Tracked quest', 'Vendor', 'Map tower', 'Sub-area', 'Player', 'Probe',
        'Langston', 'Challenge waypoint', 'Outfit change', 'Enemy', 'Dog', 'Polaroid', 'Taxi', 'Pope research',
        'Testing facility', 'Time anomaly', 'Diving bell', 'Player', 'Player', 'Sketchbook', 'Power core station',
        'Bounty objective', 'Task board', 'Gravity well', 'Person', 'Locked door (GA)', 'Locked door (Reach)',
        'Mold tentacle', 'Friend', 'Locked fast travel door', 'Sketch'];
    var FILTER_KINDS = { objective: 'Tracked objective', pin: 'Your pins', quest: 'Quests', bounty: 'Bounties',
        friend: 'Friends', enemy: 'Enemies', other: 'Other icons' };
    var FILTER_ICON = { objective: 11, quest: 7, bounty: 3 };  // their map icons
    // The map's marker pictures by type. Since the game's 1 October update its UI binds this URL instead of
    // having a map-marker-icon--N class per type (.map-marker-icon still sizes and centres the picture).
    var MAP_MARKER_PICTURE = 'coui://base/textures/uiresources/UI/automatic/map/map_markers/map_marker-';
    // The radar draws friends and enemies as dots in these colours (the game's .poi--Friend and
    // .poi--FodderEnemy); the map's own friend image is blank.
    var FILTER_DOT = { friend: 'friend', enemy: 'enemy', other: 'other' };
    var SEEN_SEED = [5, 40, 19, 12, 2, 10, 35];  // listed from the start; other types once met
    var MAP_FILTER_STYLE_ID = 'radarplus-mapfilter';
    var PICK_TEXT = 'Custom: click an icon to show or hide it, and hover one to see what it is.';
    var filters = { r: {}, w: {}, m: {}, seen: {}, names: {}, saveAt: 0, lastScan: 0, css: null };
    (function () {
        var f = C.filters || {};
        ['r', 'w', 'm'].forEach(function (k) {
            (typeof f[k] === 'string' ? f[k] : '').split(',').forEach(function (key) { if (key) filters[k][key] = true; });
        });
        (typeof f.s === 'string' ? f.s : '').split(',').concat(SEEN_SEED.map(String)).forEach(function (n) {
            if (/^\d+$/.test(n)) filters.seen[Number(n)] = true;
        });
    })();
    function mapKey(t) { return MAP_KEY_ALIAS[t] || 'm' + t; }
    function slotKey(pre) {
        var cls = model(pre + 'type_css_class', '');
        cls = typeof cls === 'string' ? cls : '';
        if (cls.indexOf('TrackedQuest') !== -1) return 'objective';
        if (model(pre + 'is_not_custom_marker', true) === false) return 'pin';
        if (model(pre + 'is_not_map_marker', true) === false) {
            var t = model(pre + 'map_marker_type', -1);
            if (typeof t === 'number' && t >= 0) return mapKey(t);
        }
        if (model(pre + 'is_bounty', false) || cls.indexOf('Bounty') !== -1) return 'bounty';
        if (model(pre + 'is_friend', false) || cls.indexOf('Friend') !== -1) return 'friend';
        if (model(pre + 'is_fodder_enemy', false) || model(pre + 'is_heavy_enemy', false) || cls.indexOf('Enemy') !== -1) return 'enemy';
        if (cls.indexOf('Quest') !== -1) return 'quest';
        return 'other';
    }
    function filterName(key) {
        if (FILTER_KINDS[key]) return FILTER_KINDS[key];
        var t = Number(key.slice(1));
        return filters.names[t] || MAP_TYPE_NAMES[t] || 'Icon ' + t;
    }
    // The picker's tiles for one setting: the kinds, then the map-marker types met so far.
    function filterKeys(target) {
        var keys = target === 'm' ? ['objective', 'pin', 'quest', 'bounty'] : ['objective', 'pin', 'quest', 'bounty', 'friend', 'enemy', 'other'];
        Object.keys(filters.seen).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
            if (!MAP_PLAYER_TYPES[t] && !MAP_KEY_ALIAS[t]) keys.push('m' + t);
        });
        return keys;
    }
    function saveFilters() {
        filters.saveAt = 0;
        var list = function (set) { return encodeURIComponent(Object.keys(set).filter(function (k) { return set[k]; }).join(',')); };
        getJson(OWN_URL + 'filters__.json?r=' + list(filters.r) + '&w=' + list(filters.w) + '&m=' + list(filters.m) +
            '&s=' + list(filters.seen) + '&n=' + now(), function (r, err) {
                if (!r || !r.ok) log('icon filters could not be saved: ' + (err || 'rejected'), true);
            }, 2000);
    }
    function toggleFilter(target, key) {
        if (filters[target][key]) delete filters[target][key]; else filters[target][key] = true;
        if (target === 'm') applyMapFilter();
        saveFilters();
    }
    // Once a second: the map-marker types met on the radar, and on the map while it's open, with the
    // names its legend gives them (in the game's language).
    function scanSeen(t) {
        if (t - filters.lastScan < 1000) return;
        filters.lastScan = t;
        var added = false;
        var met = function (n) {
            if (typeof n === 'number' && n >= 0 && n < 64 && !filters.seen[n] && !MAP_PLAYER_TYPES[n]) { filters.seen[n] = true; added = true; }
        };
        if (dom.pois) for (var i = 0; i < dom.pois.length; i++) {
            var pre = 'hud_sonar_poi_' + dom.pois[i].index + '_';
            if (model(pre + 'visible', false) && model(pre + 'is_not_map_marker', true) === false) met(model(pre + 'map_marker_type', -1));
        }
        if (model('ui_stacks_game_states_map_active', false)) {
            var ms = document.querySelectorAll('.map-marker');
            for (var j = 0; j < ms.length; j++) {
                var mm = /map-marker--(\d+)/.exec(typeof ms[j].className === 'string' ? ms[j].className : '');
                if (mm) met(Number(mm[1]));
            }
            for (var k = 0; k < 40; k++) {
                if (!model('ui_map_legend_markers_' + k + '_visible', false)) continue;
                var type = model('ui_map_legend_markers_' + k + '_type', -1), txt = window['ui_map_legend_markers_' + k + '_text'];
                if (typeof type === 'number' && txt && typeof txt.translation === 'string' && txt.translation) filters.names[type] = txt.translation;
            }
        }
        if (added && !filters.saveAt) filters.saveAt = t + 3000;
        if (filters.saveAt && t >= filters.saveAt) saveFilters();
    }
    // Custom on the map: the presets' parts-only rules, for the icons picked. Numbers are the pins' (and
    // the tracked quest's when several are tracked); objective areas go with the objective (the tracked
    // one) or the quests (the rest).
    function mapFilterCss() {
        var root = '.rp-map-' + LEVEL_CUSTOM + ' ', f = filters.m, hide = [], back = [];
        for (var t = 0; t < 64; t++) {
            if (MAP_PLAYER_TYPES[t] || !f[mapKey(t)]) continue;
            for (var p = 0; p < 3; p++) hide.push(root + '.map-marker--' + t + ' ' + MAP_PARTS[p]);
        }
        if (f.pin) {
            hide.push(root + '.map-marker__tracking-number');
            if (!f.objective) back.push(root + MAP_TRACKED + ' .map-marker__tracking-number');
        } else if (f.objective) hide.push(root + MAP_TRACKED + ' .map-marker__tracking-number');
        var css = (hide.length ? hide.join(',') + '{opacity:0 !important}' : '') + (back.length ? back.join(',') + '{opacity:1 !important}' : '');
        if (f.quest && f.objective) css += root + '.objective-area{opacity:0 !important}';
        else if (f.quest) css += root + '.objective-area{opacity:0 !important}' + root + '.objective-area--tracked{opacity:1 !important}' +
            root + '.objective-area--collapsed{opacity:0 !important}';
        else if (f.objective) css += root + '.objective-area--tracked{opacity:0 !important}';
        return css;
    }
    function applyMapFilter() {
        var st = filters.css;
        if (!st || !st.parentNode) {
            st = document.getElementById(MAP_FILTER_STYLE_ID);
            if (!st && document.head) { st = document.createElement('style'); st.id = MAP_FILTER_STYLE_ID; document.head.appendChild(st); }
            filters.css = st;
        }
        if (!st) return;
        var css = mapFilterCss();
        if (st.textContent !== css) st.textContent = css;
    }
    // The picker: a tile per icon under the description, shown while a Custom setting is focused.
    function pickerHtml(target) {
        var tiles = filterKeys(target).map(function (k) {
            var icon = k === 'pin' ? '<div class="rp-filter__pin"><div class="rp-filter__pin-n">1</div></div>' :
                FILTER_DOT[k] ? '<div class="rp-filter__dot rp-filter__dot--' + FILTER_DOT[k] + '"></div>' :
                '<div class="map-marker-icon rp-filter__icon" style="background-image:url(\'' + MAP_MARKER_PICTURE +
                (FILTER_ICON[k] !== undefined ? FILTER_ICON[k] : k.slice(1)) + '.png\')"></div>';
            return '<div class="rp-filter__tile' + (filters[target][k] ? ' rp-filter__tile--off' : '') + '" data-key="' + k + '">' + icon +
                '<div class="rp-filter__strike"></div></div>';
        }).join('');
        return '<div class="rp-filter"><div class="rp-filter__grid">' + tiles + '</div><p class="rp-filter__caption" cohinline></p></div>';
    }
    function wirePicker(grid, target) {
        var caption = grid.querySelector('.rp-filter__caption'), tiles = grid.querySelectorAll('.rp-filter__tile');
        var describe = function (tile) {
            var k = tile.getAttribute('data-key');
            if (caption) caption.textContent = filterName(k) + (filters[target][k] ? ': hidden' : ': shown');
        };
        for (var i = 0; i < tiles.length; i++) (function (tile) {
            tile.addEventListener('click', function (ev) {
                var k = tile.getAttribute('data-key');
                toggleFilter(target, k);
                if (tile.classList) tile.classList.toggle('rp-filter__tile--off', !!filters[target][k]);
                describe(tile);
                if (ev && ev.stopPropagation) ev.stopPropagation();
            });
            tile.addEventListener('mouseenter', function () { describe(tile); });
        })(tiles[i]);
    }
    // Icon distance (metres): radar icons further away than this are hidden. The slider's top means no
    // limit (at its longest range the radar reaches 900 m).
    var ICON_RANGE_MIN = 20, ICON_RANGE_MAX = 900, ICON_RANGE_SLACK = 3;
    // Whether a shown icon is further away than the limit, 3D from the player like the world markers'. A
    // little slack keeps an icon right at the limit from blinking. An icon whose position hasn't arrived
    // yet (it follows the icon by a frame or two) waits hidden for a moment rather than flash up; one that
    // never gets a position shows after that.
    function iconFar(e, feed, range, t) {
        var w = feed && feed.bySlot[e.index];
        if (w) {
            var dx = w[1] - feed.player[0], dy = w[2] - feed.player[1], dz = w[3] - feed.player[2];
            var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            e.far = e.farKnown && e.far ? d > range - ICON_RANGE_SLACK : d > range;
            e.farKnown = true;
        } else if (!e.farKnown) {
            if (!e.farSince) e.farSince = t;
            e.far = t - e.farSince < 300;
        }
        return e.far;
    }
    // Main map icons: which icons the full map shows. The map gives each marker its MapMarkerType number
    // as a class (map-marker--N; the game's enum: 6 Player, 11 TrackedQuest, 15/28/29 the player's other
    // looks), so a class on <body> picks the level and CSS does the rest, with no work per frame. The rules
    // hide a marker's parts rather than the marker, so a pin's number can stay while the icons go, and
    // the game's own opacity (hidden, dimmed) sits on the marker itself, not on these parts.
    var MAP_PLAYER = ['.map-marker--player', '.map-marker--6', '.map-marker--15', '.map-marker--28', '.map-marker--29'];
    var MAP_TRACKED = '.map-marker--11';
    var MAP_PARTS = ['.map-marker__icon', '.map-marker__clamped-arrow', '.map-marker__player-badge', '.map-marker__tracking-number'];
    function mapIconsCss() {
        var css = '';
        [LEVEL_NONE, LEVEL_OBJECTIVE, LEVEL_PINS].forEach(function (lvl) {
            var root = '.rp-map-' + lvl + ' ', keep = lvl === LEVEL_NONE ? MAP_PLAYER : MAP_PLAYER.concat([MAP_TRACKED]), back = [];
            // Pins keep every number: the player's pins show as numbered markers.
            var hide = lvl === LEVEL_PINS ? MAP_PARTS.slice(0, 3) : MAP_PARTS;
            keep.forEach(function (k) { MAP_PARTS.forEach(function (p) { back.push(root + k + ' ' + p); }); });
            css += hide.map(function (p) { return root + p; }).join(',') + '{opacity:0 !important}' +
                back.join(',') + '{opacity:1 !important}' + root + '.objective-area{opacity:0 !important}';
            // The tracked objective's area stays, unless the game has folded it away.
            if (lvl !== LEVEL_NONE) css += root + '.objective-area--tracked{opacity:1 !important}' + root + '.objective-area--collapsed{opacity:0 !important}';
        });
        return css;
    }
    var mapIconsOn = null;
    function setMapIcons(lvl) {
        var b = document.body;
        if (!b || !b.classList) return;
        [LEVEL_NONE, LEVEL_OBJECTIVE, LEVEL_PINS, LEVEL_CUSTOM].forEach(function (v) {
            if (b.classList.contains('rp-map-' + v) !== (v === lvl)) b.classList.toggle('rp-map-' + v, v === lvl);
        });
        mapIconsOn = lvl;
    }
    function applyMapIcons() {
        var lvl = level('map_icons');
        if (lvl === LEVEL_MARKERS) lvl = LEVEL_ALL;  // not offered for the map
        if (lvl === LEVEL_CUSTOM && (!filters.css || !filters.css.parentNode)) applyMapFilter();
        if (lvl !== mapIconsOn) setMapIcons(lvl);
    }
    function kindWanted(kind, lvl) {
        if (lvl === LEVEL_ALL) return true;
        if (lvl === LEVEL_MARKERS) return kind !== 'friend' && kind !== 'enemy';
        if (lvl === LEVEL_PINS) return kind === 'tracked' || kind === 'pin';
        return lvl === LEVEL_OBJECTIVE && kind === 'tracked';
    }
    function validMatrix(m) { return !!m && m.length === 16 && m.every(finite); }
    function projectWorld(m, x, y, z) {
        var cx = x * m[0] + y * m[4] + z * m[8] + m[12];
        var cy = x * m[1] + y * m[5] + z * m[9] + m[13];
        var cw = x * m[3] + y * m[7] + z * m[11] + m[15];
        // Behind the camera the game divides by |w| as well, which keeps left and right the right way round.
        var front = cw > 1e-4, d = front ? cw : Math.max(-cw, 1e-4);
        return { x: cx / d, y: cy / d, front: front };
    }
    // The camera sits where clip x, y and w are all zero: rows 0, 1 and 3 of [x y z 1] * M.
    function cameraPosition(m) {
        var a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[3], h = m[7], i = m[11];
        var r0 = -m[12], r1 = -m[13], r2 = -m[15];
        var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        if (!(Math.abs(det) > 1e-12)) return null;
        return [(r0 * (e * i - f * h) - b * (r1 * i - f * r2) + c * (r1 * h - e * r2)) / det,
            (a * (r1 * i - f * r2) - r0 * (d * i - f * g) + c * (d * r2 - r1 * g)) / det,
            (a * (e * r2 - r1 * h) - b * (d * r2 - r1 * g) + r0 * (d * h - e * g)) / det];
    }

    var worldFeed = { pending: false, data: null, receivedAt: 0, error: '', replies: 0, generation: 0 };
    function resetWorldFeed() {
        ++worldFeed.generation;
        worldFeed.pending = false; worldFeed.data = null; worldFeed.receivedAt = 0; worldFeed.error = '';
    }
    function tickWorldFeed(t) {
        if (stopped || worldFeed.pending) return;
        var generation = worldFeed.generation, sending = true;
        worldFeed.pending = true;  // set before the call: the callback may run synchronously
        getJson(OWN_URL + 'world__.json?n=' + t, function (r, err) {
            if (stopped || generation !== worldFeed.generation) return;
            worldFeed.pending = false;
            worldFeed.replies++;
            if (!r || r.installed !== true || !r.pois || typeof r.pois.length !== 'number') {
                worldFeed.data = null; worldFeed.error = r ? 'not installed' : err; hideWorld(); return;
            }
            r.bySlot = {};
            for (var i = 0; i < r.pois.length; i++) {
                var q = r.pois[i];
                if (q && q.length >= 4 && finite(q[0]) && finite(q[1]) && finite(q[3])) r.bySlot[q[0]] = q;
            }
            worldFeed.data = r; worldFeed.receivedAt = now(); worldFeed.error = '';
            // Late replies used to wait for the next RAF. Apply now without issuing another request.
            // A synchronous reply is consumed by updateWorld after tickWorldFeed returns.
            if (!sending) {
                try { applyWorldSnapshot(r, worldFeed.receivedAt); } catch (e) { worldError(e); }
            }
        }, 500);
        sending = false;
    }

    var world = { layer: null, markers: {}, lastSync: 0, lastLog: 0, shown: 0 };
    function elementChildren(n) {
        var c = n.children || n.childNodes || [], out = [];
        for (var i = 0; i < c.length; i++) if (c[i] && (c[i].nodeType === undefined || c[i].nodeType === 1)) out.push(c[i]);
        return out;
    }
    function stripBindings(n) {
        if (!n.attributes || typeof n.removeAttribute !== 'function') return;
        var names = [];
        for (var i = 0; i < n.attributes.length; i++) {
            var a = n.attributes[i];
            if (a && typeof a.name === 'string' && a.name.indexOf('data-bind') === 0) names.push(a.name);
        }
        names.forEach(function (k) { n.removeAttribute(k); });
    }
    // The style properties a node gets from bindings (data-bind-style-*). The map marker's picture is one:
    // background-image-url, from the slot's marker type. The copy's root keeps our own transform.
    function boundStyles(n, isRoot) {
        var out = [];
        for (var i = 0; n.attributes && i < n.attributes.length; i++) {
            var name = n.attributes[i] && n.attributes[i].name;
            if (typeof name !== 'string' || name.indexOf('data-bind-style-') !== 0) continue;
            var prop = name.slice(16);
            if (prop === 'transform2d') prop = 'transform';
            else if (prop === 'background-image-url') prop = 'background-image';
            if (isRoot && prop === 'transform') continue;
            out.push(prop.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }));
        }
        return out;
    }
    // A copy of the slot's .poi without its data bindings; syncIcon keeps its classes, numbers and bound
    // styles in step with the original, so it looks exactly like the sonar icon even when the game hands
    // the slot to another marker.
    function copyIcon(live) {
        var root = live.cloneNode(true), pairs = [];
        (function walk(a, b) {
            var text = !!(b.getAttribute && b.getAttribute('data-bind-value'));
            var styles = boundStyles(b, b === root);
            stripBindings(b);
            pairs.push({ live: a, copy: b, text: text, styles: styles });
            var ac = elementChildren(a), bc = elementChildren(b);
            for (var i = 0; i < ac.length && i < bc.length; i++) walk(ac[i], bc[i]);
        })(live, root);
        setStyle(root, 'transform', 'none');  // was the sonar position
        return { root: root, pairs: pairs };
    }
    function syncIcon(copy) {
        for (var i = 0; i < copy.pairs.length; i++) {
            var p = copy.pairs[i], c = p.live.className;
            if (typeof c === 'string' && p.copy.className !== c) p.copy.className = c;
            if (p.text && p.copy.textContent !== p.live.textContent) p.copy.textContent = p.live.textContent;
            for (var j = 0; j < p.styles.length; j++) {
                var k = p.styles[j], v = p.live.style[k];
                if (typeof v === 'string' && p.copy.style[k] !== v) p.copy.style[k] = v;
            }
        }
    }
    function findWorldHost() {
        var all = document.querySelectorAll('.hud__world-tracking');
        for (var i = 0; i < all.length; i++) if (connected(all[i]) && !staged(all[i])) return all[i];
        return null;
    }
    function clearWorld() {
        Object.keys(world.markers).forEach(function (k) {
            var mk = world.markers[k];
            if (mk.el.parentNode) mk.el.parentNode.removeChild(mk.el);
        });
        world.markers = {};
        if (world.layer && world.layer.parentNode) world.layer.parentNode.removeChild(world.layer);
        world.layer = null;
    }
    function ensureWorldLayer() {
        if (world.layer && connected(world.layer)) return world.layer;
        var host = findWorldHost();
        if (!host) return null;
        clearWorld();
        var stale = document.querySelectorAll('.rp-world');  // cloned with the HUD on a level load
        for (var i = 0; i < stale.length; i++) if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
        world.layer = document.createElement('div');
        world.layer.className = 'rp-world';
        host.insertBefore(world.layer, host.firstChild);
        return world.layer;
    }
    function makeMarker(livePoi) {
        var el = document.createElement('div'); el.className = 'rp-wm';
        var icon = document.createElement('div'); icon.className = 'rp-wm__icon';
        var copy = copyIcon(livePoi);
        icon.appendChild(copy.root);
        el.appendChild(icon);
        var arrow = document.createElement('div'); arrow.className = 'rp-wm__arrow'; show(arrow, false); el.appendChild(arrow);
        var dist = document.createElement('div'); dist.className = 'rp-wm__dist'; show(dist, false); el.appendChild(dist);
        world.layer.appendChild(el);
        syncIcon(copy);
        return { el: el, icon: icon, copy: copy, arrow: arrow, dist: dist, live: livePoi, kind: '', text: '', shown: true };
    }
    function hideMarker(mk) { if (mk.shown) { mk.shown = false; show(mk.el, false); } }
    // Hide in combat: the game's own combat flag (the one that turns the radar's inner line red), held for
    // a moment after it clears, so markers don't flicker between waves.
    var combat = { on: false, lastSeen: 0 };
    function inCombat(t) {
        if (model('hud_sonar_in_combat', false)) { combat.on = true; combat.lastSeen = t; }
        else if (combat.on && t - combat.lastSeen > WORLD_COMBAT_GRACE) combat.on = false;
        return combat.on;
    }
    // Show on press: the DLL counts presses of the show button (any controller) and key (read-only, so both keep
    // their game actions). Each new press shows the chosen parts for the set time from that press: holding doesn't
    // extend it, pressing again starts it over. Values: 1 Radar, 2 World markers, 3 Both.
    var REVEAL_RADAR = 1, REVEAL_WORLD = 2;
    var reveal = { count: null, until: 0 };
    function trackReveal(t) {
        var info = SOURCE === 'mapfusion' ? { reveal: keyFeed.reveal } : feed.info, n = info && finite(info.reveal) ? info.reveal : null;
        if (n === null) return;
        if (reveal.count !== null && n !== reveal.count) {
            reveal.until = t + clamp(option('reveal_seconds'), 1, 30) * 1000;
            if (DIAG) log('show on press: press ' + n + ', mode ' + option('reveal_mode') + ', shown for ' + clamp(option('reveal_seconds'), 1, 30) + ' s');
        }
        reveal.count = n;
    }
    // The show button and key are Mod Settings Menu key options; the DLL watches whichever are bound.
    var revealKeys = { sent: '', pending: false, retryAt: 0 };
    function syncRevealKeys(t) {
        var pad = Math.round(option('reveal_pad')), key = Math.round(option('reveal_key')), want = pad + ',' + key;
        if (want === revealKeys.sent || revealKeys.pending || t < revealKeys.retryAt) return;
        revealKeys.pending = true;
        getJson(OWN_URL + 'reveal__.json?pad=' + pad + '&key=' + key, function (r) {
            revealKeys.pending = false;
            if (r) revealKeys.sent = want;  // a refusal (a code the menu wouldn't store) isn't retried
            else revealKeys.retryAt = now() + 2000;
            if (r && r.ok !== true) log('show on press: the DLL refused button ' + pad + ' / key ' + key, true);
        }, 1000);
    }
    function waitsForPress(part, t) { return (Math.round(option('reveal_mode')) & part) !== 0 && t >= reveal.until; }
    function hideWorld() {
        if (!world.layer) return;
        show(world.layer, false);
        world.shown = 0;
    }

    function updateWorld(t) {
        if (stopped || !NATIVE.world || level('world_markers') === LEVEL_NONE || !state.hudOn || !alive() || !dom.pois) { hideWorld(); return; }
        tickWorldFeed(t);
        applyWorldSnapshot(worldFeed.data, now());
    }
    function worldError(e) {
        if (!world.error) log('world error: ' + (e && e.stack || e), true);
        world.error = String(e);
        try { hideWorld(); } catch (e2) { }
    }
    function applyWorldSnapshot(r, t) {
        var mode = level('world_markers');
        if (stopped || !NATIVE.world || mode === LEVEL_NONE || !state.hudOn || !alive() || !dom.pois) { hideWorld(); return; }
        if (!r || t - worldFeed.receivedAt > 1000 || !(r.ageMs <= 1000) || !validMatrix(r.m)) { hideWorld(); return; }
        if (world.poisFor !== dom.pois) {
            world.poisFor = dom.pois; world.live = {};
            for (var j = 0; j < dom.pois.length; j++) if (dom.pois[j].poi) world.live[dom.pois[j].index] = dom.pois[j].poi;
        }
        var live = world.live;
        for (var s = 0; s < r.pois.length; s++) {
            var lp = r.pois[s] && live[r.pois[s][0]];
            if (lp && !poiAttached(lp)) { dom.poisStale = true; hideWorld(); return; }  // re-mapped next RAF
        }
        var layer = ensureWorldLayer();
        if (!layer) return;
        show(layer, true);
        // Fading out for combat, or until a press (Show on press); once faded, the markers are left as they are.
        if ((option('world_marker_combat') >= 0.5 && inCombat(t)) || waitsForPress(REVEAL_WORLD, t)) {
            if (!world.fadedAt) world.fadedAt = t;
            setStyle(layer, 'opacity', '0');
            if (t - world.fadedAt > 350) return;
        } else {
            world.fadedAt = 0;
            setStyle(layer, 'opacity', '');
        }
        var W = window.innerWidth, H = window.innerHeight, vh = H / 100, m = r.m;
        var player = r.player && r.player.length === 3 && r.player.every(finite) ? r.player : null;
        var from = player || cameraPosition(m);
        var k = clamp(option('world_marker_size'), 50, 200) / 100 * WORLD_BASE_SCALE;
        var maxRange = clamp(option('world_marker_range'), 10, 1000);
        var labels = option('world_marker_labels') >= 0.5;
        var sync = t - world.lastSync >= 100;
        if (sync) world.lastSync = t;
        var seen = {}, shown = 0, sample = [];
        var margin = WORLD_EDGE_MARGIN * vh, hw = W / 2, hh = H / 2;
        for (var i = 0; i < r.pois.length; i++) {
            var q = r.pois[i];
            if (!q || q.length < 4 || !finite(q[0]) || !finite(q[1]) || !finite(q[2]) || !finite(q[3])) continue;
            var slot = q[0], pre = 'hud_sonar_poi_' + slot + '_', livePoi = live[slot];
            if (!livePoi || seen[slot] || !model(pre + 'visible', false)) continue;
            var kind = slotKind(pre);
            if (mode === LEVEL_CUSTOM ? filters.w[slotKey(pre)] : !kindWanted(kind, mode)) continue;
            var dx = q[1] - (from ? from[0] : 0), dy = q[2] - (from ? from[1] : 0), dz = q[3] - (from ? from[2] : 0);
            var dist = from ? Math.sqrt(dx * dx + dy * dy + dz * dz) : 0;
            if (kind !== 'tracked' && kind !== 'pin' && dist > maxRange) continue;  // destinations always show
            var p = projectWorld(m, q[1], q[2] + (kind === 'friend' || kind === 'enemy' ? WORLD_LIFT_ACTOR : WORLD_LIFT), q[3]);
            var onScreen = p.front && Math.abs(p.x) <= 1.02 && Math.abs(p.y) <= 1.02;
            if (!onScreen && kind !== 'tracked') continue;
            var X, Y, arrowAngle = null;
            if (onScreen) {
                X = (p.x + 1) * hw; Y = (1 - p.y) * hh;
            } else {
                // Off screen or behind: slide to the screen edge towards it, with an arrow pointing on.
                var vx = p.x * hw, vy = -p.y * hh;
                if (Math.abs(vx) < 1e-3 && Math.abs(vy) < 1e-3) vy = 1;  // straight behind: bottom edge
                var s = Math.min((hw - margin) / Math.max(Math.abs(vx), 1e-6), (hh - margin) / Math.max(Math.abs(vy), 1e-6));
                X = hw + vx * s; Y = hh + vy * s;
                arrowAngle = Math.atan2(vx, -vy);
            }
            var mk = world.markers[slot];
            if (mk && mk.live !== livePoi) { if (mk.el.parentNode) mk.el.parentNode.removeChild(mk.el); mk = null; }
            if (!mk) mk = world.markers[slot] = makeMarker(livePoi);
            else if (sync) syncIcon(mk.copy);
            seen[slot] = true;
            shown++;
            if (!mk.shown) { mk.shown = true; show(mk.el, true); }
            if (mk.kind !== kind) { mk.kind = kind; mk.el.className = 'rp-wm rp-wm--' + kind; }
            setStyle(mk.el, 'transform', 'translate(' + X.toFixed(1) + 'px, ' + Y.toFixed(1) + 'px)');
            setStyle(mk.icon, 'transform', 'translate(-50%, -50%) scale(' + k.toFixed(3) + ')');
            var fade = clamp((dist - WORLD_FADE_FROM) / (WORLD_FADE_TO - WORLD_FADE_FROM), 0, 1);
            setStyle(mk.el, 'opacity', !from || fade >= 1 ? '' : fade.toFixed(2));
            setStyle(mk.el, 'zIndex', String(10000 - Math.min(9999, Math.round(dist))));  // nearer on top
            if (arrowAngle !== null) {
                var ar = 1.3 * vh * k + 0.5 * vh;
                setStyle(mk.arrow, 'transform', 'translate(' + (Math.sin(arrowAngle) * ar).toFixed(1) + 'px, ' +
                    (-Math.cos(arrowAngle) * ar).toFixed(1) + 'px) translate(-50%, -50%) rotate(' + (arrowAngle * 180 / Math.PI).toFixed(1) + 'deg)');
                show(mk.arrow, true);
            } else show(mk.arrow, false);
            var text = labels && from ? Math.round(dist) + ' m' : '';
            if (mk.text !== text) { mk.text = text; mk.dist.textContent = text; show(mk.dist, !!text); }
            if (text) setStyle(mk.dist, 'transform', 'translate(-50%, ' + (1.1 * vh * k).toFixed(1) + 'px)');
            if (DIAG && sample.length < 4) sample.push('slot ' + slot + ' ' + kind + ' d=' + dist.toFixed(1) + ' ndc=' + p.x.toFixed(3) + ',' +
                p.y.toFixed(3) + (p.front ? '' : ' behind') + ' px=' + X.toFixed(0) + ',' + Y.toFixed(0));
        }
        Object.keys(world.markers).forEach(function (key) { if (!seen[key]) hideMarker(world.markers[key]); });
        world.shown = shown;
        if (DIAG && t - world.lastLog > 3000) {
            world.lastLog = t;
            var cam = cameraPosition(m), f2 = function (v) { return v.toFixed(2); };
            var apart = cam && player ? Math.sqrt(Math.pow(cam[0] - player[0], 2) + Math.pow(cam[1] - player[1], 2) + Math.pow(cam[2] - player[2], 2)) : null;
            log('world: mode ' + mode + ', ' + r.pois.length + ' entries, ' + shown + ' shown, age ' + r.ageMs + ' ms, replies ' +
                worldFeed.replies + ', lens ' + JSON.stringify(r.lens) + ', camera ' + (cam ? cam.map(f2).join(',') : 'none') +
                ', player ' + (player ? player.map(f2).join(',') : 'none') + (apart !== null ? ' (' + apart.toFixed(2) + ' m apart)' : '') +
                ' | ' + (sample.join(' | ') || 'none drawn'));
        }
    }

    // ------------------------------------------------------------------ label
    var labelUntil = 0, startedAt = now();
    function flash(text, t) {
        if (!dom.label || t - startedAt < 2000) return;
        dom.label.textContent = text;
        labelUntil = t + 1600;
    }

    // ------------------------------------------------------------------ main loop
    var stopped = false, timer = null, lastError = '', lastDiag = 0, mapFusionStopped = false;
    var state = { shape: 0, hudOn: false, north: null, locked: false };
    function stopMapFusion() {
        if (mapFusionStopped) return;
        try {
            if (window.MapFusionControl && typeof MapFusionControl.stop === 'function') {
                MapFusionControl.stop();
                mapFusionStopped = true;
                log('MapFusion overlay stopped; RadarPlus draws the map now', true);
            }
        } catch (e) { }
    }
    function frame() {
        if (stopped) return;
        var delay = 33, t = now(), started = DIAG ? clock() : 0;
        try {
            stopMapFusion();
            migrateRange();
            hideMenuStatus(t);
            applyMapIcons();
            scanSeen(t);
            syncZoom(t);
            if (!alive() && !mount()) {
                state.hudOn = false;
                if (DIAG && t - lastDiag > 3000) { lastDiag = t; log('state: no sonar mounted (map open ' + !!model('ui_stacks_game_states_map_active', false) + ')'); }
                feed.tick(t, 250);
                tickKeyFeed(t);
                handleKeys(SOURCE === 'mapfusion' ? keyFeed.counts : feed.info && feed.info.keys, t);
                trackReveal(t);
                syncRevealKeys(t);
                timer = setTimeout(frame, 250);
                return;
            }
            var mapOpen = !!model('ui_stacks_game_states_map_active', false);
            var hudOn = !!model('hud_visibility_sonar', false) && !!model('hud_sonar_visible', false) &&
                !model('hud_settings_hide_player_hud', false) && !model('hud_settings_hide_sonar', false) && !mapOpen;
            var terrainOn = option('terrain_enabled') >= 0.5;
            var shape = Math.round(option('radar_shape'));
            if (shape !== 1 && shape !== 2) shape = 0;
            applySize();
            applyNeighbours(radarGrowth());
            applyShape(shape);
            var opacity = clamp(option('terrain_opacity'), 0, 100) / 100;
            var backdrop = clamp(option('radar_backdrop'), 0, 100) / 100;
            setStyle(dom.origin, 'opacity', String(opacity));
            setStyle(dom.backdrop, 'opacity', String(backdrop));

            // Poll fast while the radar is on screen (position + hotkeys), slowly otherwise.
            feed.tick(t, hudOn || mapOpen ? 50 : 200);
            tickKeyFeed(t);
            var p = feed.get(t);
            if (feed.info) applyZoomReply(feed.info);
            handleKeys(SOURCE === 'mapfusion' ? keyFeed.counts : feed.info && feed.info.keys, t);
            trackReveal(t);
            syncRevealKeys(t);
            // Show on press, Radar: the radar waits for a press (a fade on the game's container, which has no style bindings).
            setStyle(dom.container, 'transition', 'opacity .3s');
            setStyle(dom.container, 'opacity', waitsForPress(REVEAL_RADAR, t) ? '0' : '');
            if (p) learnAtlas(p);
            var north = parseAngle(model('hud_sonar_rotation', ''));
            state.shape = shape; state.hudOn = hudOn; state.north = north; state.locked = option('radar_north_up') >= 0.5;
            var terrainReady = false;
            if (terrainOn && hudOn && p && north !== null) terrainReady = drawTerrain(p, shape);
            else releaseTiles();
            show(dom.origin, terrainReady);
            show(dom.layer, hudOn && (terrainReady || backdrop > 0));
            show(dom.label, hudOn && t < labelUntil);
            if (DIAG && t - lastDiag > 3000) {
                lastDiag = t;
                log('state hud=' + hudOn + ' map=' + mapOpen + ' terrain=' + terrainOn + '/' + terrainReady + ' shape=' + shape +
                    (state.locked ? ' north-up' : '') +
                    ' size=' + option('radar_size') + ' zoom=' + zoom.percent + ' ring=' + zoom.rings.join('/') + ' north=' +
                    (north === null ? 'none' : north.toFixed(2)) + ' pos=' + (p ? p.district + ':' + p.x.toFixed(1) + ',' + p.y.toFixed(1) +
                    ' epoch ' + p.epoch : 'none (' + feed.error() + ')') + ' atlas=' + Object.keys(atlasCache).join(',') +
                    ' rEdge=' + edge.rEdge.toFixed(1) + ' show=' + option('reveal_mode') + '/' + (t < reveal.until ? 'shown' : 'waiting') +
                    ' (menu ' + (function () { try { return typeof window.CMM.value(MOD_ID, 'reveal_mode'); } catch (e) { return 'n/a'; } })() + ')' +
                    (lastError ? ' lastError=' + lastError : '') + (edge.error ? ' edgeError=' + edge.error : ''));
            }
        } catch (e) {
            lastError = String(e && e.stack || e);
            log('frame error: ' + lastError, true);
            try { if (dom.layer) show(dom.layer, false); releaseTiles(); } catch (e2) { }
            delay = 1000;
        }
        if (DIAG) { note('frame', clock() - started); logPerf(t); }
        timer = setTimeout(frame, delay);
    }
    function logPerf(t) {
        if (!perf.since) { perf.since = t; return; }
        if (t - perf.since < 5000) return;
        var secs = (t - perf.since) / 1000, n = worldFeed.data && worldFeed.data.perf, nat = '';
        if (n && n.length === 4 && perf.native) {
            var hooks = n[1] - perf.native[1], jsons = n[3] - perf.native[3];
            nat = ' | native: world hook ' + (hooks > 0 ? ((n[0] - perf.native[0]) / hooks / 1000).toFixed(1) : '-') + ' us avg (' + hooks +
                '), world reply ' + (jsons > 0 ? ((n[2] - perf.native[2]) / jsons / 1000).toFixed(1) : '-') + ' us avg (' + jsons + ')';
        }
        if (n && n.length === 4) perf.native = n.slice();
        log('perf: ' + perfLine('frame') + ' | ' + perfLine('edges') + ' | ' + perfLine('world') + ' | ' +
            (perf.requests / secs).toFixed(1) + ' native requests/s, ' + world.shown + ' world markers' + nat);
        perf.frame = [0, 0, 0]; perf.edges = [0, 0, 0]; perf.world = [0, 0, 0]; perf.requests = 0; perf.since = t;
    }
    function edgeLoop() {
        if (stopped) return;
        var a = DIAG ? clock() : 0;
        try { updateEdges(); } catch (e) {
            if (!edge.error) log('edge error: ' + (e && e.stack || e), true);
            edge.error = String(e);
        }
        var b = DIAG ? clock() : 0;
        if (DIAG) note('edges', b - a);
        try { updateWorld(now()); } catch (e) {
            worldError(e);
        }
        if (DIAG) note('world', clock() - b);
        try { updateMenuDescription(now()); } catch (e) {
            if (!menuDesc.error) log('menu description error: ' + (e && e.stack || e), true);
            menuDesc.error = String(e);
        }
        raf(edgeLoop);
    }
    function stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        unmount();
        try { dropMenuDescription(); } catch (e) { }
        try { setMapIcons(LEVEL_ALL); } catch (e) { }
        try { var mf = document.getElementById(MAP_FILTER_STYLE_ID); if (mf && mf.parentNode) mf.parentNode.removeChild(mf); } catch (e) { }
        var st = document.getElementById(STYLE_ID);
        if (st && st.parentNode) st.parentNode.removeChild(st);
        window.__RadarPlusInstalled = false;
    }
    window.RadarPlus = {
        version: C.version, stop: stop,
        state: function () {
            return { zoom: zoom, atlas: Object.keys(atlasCache), position: feed.info, error: lastError, edge: edge,
                world: { shown: world.shown, error: world.error || '', feed: worldFeed.error, replies: worldFeed.replies } };
        }
    };
    if (window.addEventListener) window.addEventListener('beforeunload', stop);
    log('RadarPlus ' + (C.version || '?') + ' started (native ' + SOURCE + ', position ' + !!NATIVE.position + ', zoom ' +
        !!NATIVE.zoom + ', world ' + !!NATIVE.world + ', cached districts ' + Object.keys(atlasCache).length + ')', true);
    // Diagnostics: the same request twice. Two "cache probe" lines in RadarPlus.log mean the UI engine
    // does not cache our replies, so the per-request URLs never pile up anywhere.
    if (DIAG) { log('cache probe'); log('cache probe'); }
    timer = setTimeout(frame, 100);
    raf(edgeLoop);
})();
