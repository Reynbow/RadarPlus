// Run the actual HUD script against a small DOM/XHR boundary fixture. No production test hooks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
    constructor(className = '') {
        this.className = className;
        this.style = {};
        this.children = [];
        this.attributes = [];
        this.nodeType = 1;
        this.textContent = '';
        this.classList = { contains: c => this.className.split(' ').includes(c), toggle: () => {} };
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child, before) {
        child.parentNode = this;
        const at = this.children.indexOf(before);
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        return child;
    }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    get firstChild() { return this.children[0] || null; }
    getAttribute() { return null; }
    removeAttribute() {}
    cloneNode() { return new Element(this.className); }
    querySelectorAll(selector) {
        const classes = selector.split(',').map(s => s.trim().slice(1));
        const found = [];
        const walk = n => n.children.forEach(c => {
            if (classes.some(k => c.className.split(' ').includes(k))) found.push(c);
            walk(c);
        });
        walk(this);
        return found;
    }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}

function snapshot(x = 0) {
    // World point (0, 0, 10), lifted to y=.5; identity with a hand-picked clip-x translation.
    return { installed: true, serial: 1, ageMs: 0,
        m: [1,0,0,0, 0,1,0,0, 0,0,1,0, x,0,0,1],
        player: [0,0,0], pois: [[0,0,0,10,0,1,0]], lens: [1,1,3] };
}

function hud(count = 1) {
    let time = 10000;
    const body = new Element(), head = new Element(), requests = [], timers = [];
    const menu = { world_markers: 3, world_marker_combat: 0 };
    let syncReply = null;
    const context = {
        console, Date: { now: () => time }, setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
        clearTimeout: t => { if (t) t.cleared = true; },
        document: { body, head, createElement: () => new Element(), getElementById: () => null,
            querySelectorAll: s => body.querySelectorAll(s) },
        XMLHttpRequest: class {
            open(method, url) { this.url = url; }
            send() { requests.push(this); if (syncReply && this.url.includes('__radarplus_world__')) this.reply(syncReply); }
            abort() { this.aborted = true; }
            reply(r) { this.status = 200; this.responseText = JSON.stringify(r); this.onload(); }
        },
        __RadarPlusConfig: { native: { world: true }, menu }, innerWidth: 1920, innerHeight: 1080,
        requestAnimationFrame: () => {}, addEventListener: () => {},
        hud_sonar_poi_0_visible: { value: true }, hud_sonar_poi_0_type_css_class: { value: 'MapMarker' }
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '../mod/RadarPlus.js'), 'utf8');
    const hooks = `window.testHud = { updateWorld: updateWorld, tickWorldFeed: tickWorldFeed,
        unmount: unmount, stop: stop, feed: worldFeed,
        install: function(container, sonar, layer, pois) {
            dom = emptyDom(); dom.container = container; dom.sonar = sonar; dom.layer = layer;
            dom.pois = pois.map(function(poi, index) {return {el: poi.parentNode, poi: poi, index: index};}); state.hudOn = true;
        } };`;
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, hooks + '\n})();'), context);
    function install() {
        const container = body.appendChild(new Element('sonar-container'));
        const sonar = container.appendChild(new Element('sonar'));
        const layer = sonar.appendChild(new Element('rp-layer'));
        const slots = [], pois = [];
        for (let i = 0; i < count; i++) {
            const slot = sonar.appendChild(new Element('poi-container'));
            slots.push(slot); pois.push(slot.appendChild(new Element('poi')));
            context['hud_sonar_poi_' + i + '_visible'] = { value: true };
        }
        const host = body.appendChild(new Element('hud__world-tracking'));
        context.testHud.install(container, sonar, layer, pois);
        return { container, sonar, host, slots, pois };
    }
    const fixture = install();
    const worldRequests = () => requests.filter(r => r.url.includes('__radarplus_world__'));
    return { api: context.testHud, fixture, body, install, menu, timers, worldRequests,
        transform: () => body.querySelector('.rp-wm')?.style.transform,
        advance: ms => { time += ms; }, now: () => time, synchronous: r => { syncReply = r; } };
}

test('a delayed reply positions the marker before another RAF/update request', () => {
    const h = hud();
    h.api.updateWorld(h.now());
    h.worldRequests()[0].reply(snapshot(.25));
    assert.equal(h.transform(), 'translate(1200.0px, 270.0px)');
    assert.equal(h.worldRequests().length, 1);
    h.advance(16);
    h.api.updateWorld(h.now());
    h.worldRequests()[1].reply(snapshot(-.25));
    assert.equal(h.transform(), 'translate(720.0px, 270.0px)');
});

test('synchronous replies do not recurse into another acquisition', () => {
    const h = hud(); h.synchronous(snapshot(.25));
    h.api.updateWorld(h.now());
    assert.equal(h.transform(), 'translate(1200.0px, 270.0px)');
    assert.equal(h.worldRequests().length, 1);
});

test('an old HUD reply cannot clear a new pending request or replace its snapshot', () => {
    const h = hud(); h.api.updateWorld(h.now()); const old = h.worldRequests()[0];
    h.api.unmount(); h.install();
    h.api.updateWorld(h.now()); const fresh = h.worldRequests()[1];
    old.reply(snapshot(.25));
    assert.equal(h.api.feed.pending, true);
    assert.equal(h.api.feed.data, null);
    assert.equal(h.transform(), undefined);
    fresh.reply(snapshot(-.25));
    assert.equal(h.transform(), 'translate(720.0px, 270.0px)');
});

test('a reply after stop does not recreate markers or reacquire data', () => {
    const h = hud(); h.api.updateWorld(h.now()); const request = h.worldRequests()[0];
    h.api.stop(); request.reply(snapshot(.25)); h.api.updateWorld(h.now());
    assert.equal(h.body.querySelector('.rp-world'), null);
    assert.equal(h.api.feed.data, null);
    assert.equal(h.worldRequests().length, 1);
});

test('a reply after HUD removal does not place stale icons in the replacement host', () => {
    const h = hud(); h.api.updateWorld(h.now());
    h.body.removeChild(h.fixture.container);
    h.worldRequests()[0].reply(snapshot(.25));
    assert.equal(h.body.querySelector('.rp-world'), null);
});

test('replacement of an interior slot rejects detached icons before the next RAF', () => {
    const h = hud(3); h.api.updateWorld(h.now());
    h.fixture.sonar.removeChild(h.fixture.slots[1]);
    h.fixture.sonar.appendChild(new Element('poi-container'));
    const r = snapshot(.25); r.pois.push([1,0,0,10,0,1,0], [2,0,0,10,0,1,0]);
    h.worldRequests()[0].reply(r);
    assert.equal(h.body.querySelectorAll('.rp-wm').length, 0);
});

test('replacement of a poi within its container rejects the detached icon', () => {
    const h = hud(); h.api.updateWorld(h.now());
    h.fixture.slots[0].removeChild(h.fixture.pois[0]);
    h.fixture.slots[0].appendChild(new Element('poi'));
    h.worldRequests()[0].reply(snapshot(.25));
    assert.equal(h.body.querySelectorAll('.rp-wm').length, 0);
});

test('invalid and expired replies hide the current markers and allow retry', () => {
    const h = hud(); h.api.updateWorld(h.now()); h.worldRequests()[0].reply(snapshot());
    h.advance(16); h.api.updateWorld(h.now()); h.worldRequests()[1].reply({ installed: false });
    assert.equal(h.body.querySelector('.rp-world').style.display, 'none');
    h.advance(16); h.api.updateWorld(h.now()); const stale = snapshot(.25); stale.ageMs = 1001;
    h.worldRequests()[2].reply(stale);
    assert.equal(h.body.querySelector('.rp-world').style.display, 'none');
    assert.equal(h.api.feed.pending, false);
});

test('turning world markers off while a request is in flight keeps them hidden', () => {
    const h = hud(); h.api.updateWorld(h.now()); h.menu.world_markers = 0;
    h.worldRequests()[0].reply(snapshot(.25));
    assert.equal(h.body.querySelector('.rp-world'), null);
});
