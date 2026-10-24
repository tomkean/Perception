/**
 * capture-worker.js
 * The capture loop, off the page. Chrome holds back a page it thinks is hidden -- which the capture page is, under
 * a fullscreen game -- so a loop driven from the page ran at one picture every few seconds. Here each frame of the
 * shared screen arrives as it is captured, and the checks and sends follow from that, not from a timer.
 *
 * Messages in:  {type: 'start', readable, modules: [{name, url}]}   frames of the shared screen
 *               {type: 'stop'}
 *               {type: 'snapshot'}                                   the next whole frame, as a JPEG
 * Messages out: {type: 'status', modules: [...]}                     for the page to show
 *               {type: 'snapshot', blob} | {type: 'snapshot', error}
 *
 * Each module's spec says, per screen it wants:
 *   detect: a small region, shrunk to `size` and compared against `pixels` (grey, 0-255) -- a match at or above
 *           `min_match` means the screen is showing. A list of them must all match. None: always showing, for a
 *           module that tells its screens apart itself
 *   send:   the region to crop and post, as JPEG at `quality`; none: the whole screen
 *   post:   where to post it, on the module; every_ms: how often at most
 * Regions are in `ref_width` x `ref_height` pixels and scaled to the captured size.
 *
 * A spec may also name `requests`: a path the worker asks every half second for whole pictures the module wants
 * now -- a capture button pressed on a phone, say. It answers {pictures: [{post, fields}]}, each handed out once;
 * the next frame goes to each `post`, whole, with the `fields` added to the form.
 */
// While no module's screen is showing, look only this often: opening a box is noticed within half a second.
const IDLE_CHECK_MS = 500;
const SPEC_RETRY_MS = 30000;
const MODULE_LIST_MS = 30000;
const STATUS_MS = 500;
// Pictures on their way to one module at once. Most of a picture's round trip is cutting, encoding and sending it,
// so with several on the way they follow each other that much more closely. Never more: a slow module still gets fewer
// pictures, not a queue of stale ones.
const MAX_IN_FLIGHT = 3;

let reader = null;
let modules = [];          // {name, url, spec, error, nextTry, screens: {id: status}}
let lastCheck = 0;
let lastStatus = 0;
let snapshotWanted = false;
const wanted = [];         // whole pictures modules asked for: {m, post, fields}
const small = new OffscreenCanvas(1, 1);

onmessage = e => {
    const msg = e.data;
    if (msg.type === 'start') start(msg.readable, msg.modules);
    else if (msg.type === 'stop') stop();
    else if (msg.type === 'snapshot') snapshotWanted = true;
};

async function start(readable, list) {
    stop();
    modules = list.map(m => ({ ...m, spec: null, error: null, nextTry: 0, screens: {}, asking: false,
                               pictures: { sent: 0, error: null } }));
    lastListCheck = Date.now();
    reader = readable.getReader();
    const mine = reader;
    refreshSpecs();
    while (reader === mine) {
        const { value: frame, done } = await mine.read();
        if (done) break;
        try {
            onFrame(frame);
        } catch (err) {
            console.warn('[capture-worker]', err);
        } finally {
            frame.close();
        }
    }
}

function stop() {
    reader?.cancel().catch(() => {});
    reader = null;
}

/** Pick up modules added to (or removed from) modules.json since the screen was linked: a new module works without
 *  reloading this page. */
let lastListCheck = 0;
async function refreshModuleList() {
    const now = Date.now();
    if (now - lastListCheck < MODULE_LIST_MS) return;
    lastListCheck = now;
    try {
        const list = await (await fetch('/api/modules')).json();
        if (!Array.isArray(list) || !list.length) return;
        const known = new Map(modules.map(m => [m.url, m]));
        modules = list.map(m => known.get(m.url) ?? ({ ...m, spec: null, error: null, nextTry: 0, screens: {},
                                                       asking: false, pictures: { sent: 0, error: null } }));
    } catch (err) {
        // The Pi's server unreachable for a moment: keep the modules there are.
    }
}

async function refreshSpecs() {
    refreshModuleList();
    const now = Date.now();
    for (const m of modules) {
        if (m.spec || now < m.nextTry) continue;
        m.nextTry = now + SPEC_RETRY_MS;
        try {
            const res = await fetch(`${m.url}/api/perception/spec`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            m.spec = await res.json();
            m.error = null;
            for (const sc of m.spec.screens) {
                m.screens[sc.id] = { showing: false, last: 0, inFlight: 0, summary: '', error: null, sent: 0 };
            }
        } catch (err) {
            m.error = `not reachable (${err.message}); retrying`;
        }
    }
}

/** Ask each module that takes requests whether it wants a whole picture. One question at a time per module: one
 *  that is down is not asked again until the last question has failed. */
function askForRequests() {
    for (const m of modules) {
        if (!m.spec?.requests || m.asking) continue;
        m.asking = true;
        fetch(`${m.url}${m.spec.requests}`)
            .then(res => res.ok ? res.json() : { pictures: [] })
            .then(r => { for (const p of r.pictures ?? []) wanted.push({ m, post: p.post, fields: p.fields ?? {} }); })
            .catch(() => {})
            .finally(() => { m.asking = false; });
    }
}

/** Post the whole frame to everyone who asked for it. */
function sendWanted(frame, w, h) {
    const full = new OffscreenCanvas(w, h);
    full.getContext('2d').drawImage(frame, 0, 0, w, h);
    const taken = Date.now();
    const jobs = wanted.splice(0);
    full.convertToBlob({ type: 'image/jpeg', quality: 0.92 }).then(blob => {
        for (const { m, post, fields } of jobs) {
            const form = new FormData();
            form.append('file', blob, 'screen.jpg');
            form.append('capture_w', w);
            form.append('capture_h', h);
            form.append('taken', taken);
            for (const [k, v] of Object.entries(fields)) form.append(k, v);
            fetch(`${m.url}${post}`, { method: 'POST', body: form })
                .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); m.pictures.sent++; m.pictures.error = null; })
                .catch(err => { m.pictures.error = err.message; });
        }
    });
}

function scaleRegion(region, sc, w, h) {
    const sx = w / sc.ref_width, sy = h / sc.ref_height;
    const [x, y, rw, rh] = region;
    const X = Math.max(0, Math.round(x * sx)), Y = Math.max(0, Math.round(y * sy));
    return [X, Y, Math.min(w - X, Math.round(rw * sx)), Math.min(h - Y, Math.round(rh * sy))];
}

/** Is this screen showing? Every detect patch must match; a screen with none is always showing. */
function showing(frame, sc, w, h) {
    if (!sc.detect) return true;
    const rules = Array.isArray(sc.detect) ? sc.detect : [sc.detect];
    return rules.every(rule => matches(frame, sc, rule, w, h));
}

/** Shrink the detect region, grey it the way OpenCV does, correlate with the spec. Only that small patch is copied
 *  out of the frame, so watching costs the gaming PC next to nothing. */
function matches(frame, sc, detect, w, h) {
    const [x, y, rw, rh] = scaleRegion(detect.region, sc, w, h);
    const [sw, sh] = detect.size;
    small.width = sw;
    small.height = sh;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, x, y, rw, rh, 0, 0, sw, sh);
    const px = ctx.getImageData(0, 0, sw, sh).data;
    const ref = detect.pixels;
    const n = sw * sh;
    const a = new Float32Array(n);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) {
        a[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
        ma += a[i];
        mb += ref[i];
    }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
        const u = a[i] - ma, v = ref[i] - mb;
        num += u * v; da += u * u; db += v * v;
    }
    return da && db ? num / Math.sqrt(da * db) >= detect.min_match : false;
}

/** Cut the crop out now, while the frame is open; the upload carries on after the frame is closed. */
function send(frame, m, sc, st, w, h) {
    const [x, y, rw, rh] = sc.send?.region ? scaleRegion(sc.send.region, sc, w, h) : [0, 0, w, h];
    const crop = new OffscreenCanvas(rw, rh);
    crop.getContext('2d').drawImage(frame, x, y, rw, rh, 0, 0, rw, rh);
    st.inFlight++;
    st.last = Date.now();
    const taken = st.last;
    (async () => {
        const blob = await crop.convertToBlob({ type: 'image/jpeg', quality: sc.send?.quality ?? 0.9 });
        const form = new FormData();
        form.append('file', blob, `${sc.id}.jpg`);
        form.append('screen', sc.id);
        form.append('capture_w', w);
        form.append('capture_h', h);
        form.append('x', x); form.append('y', y); form.append('w', rw); form.append('h', rh);
        form.append('taken', taken);    // so the module can tell a late answer from the latest picture
        const res = await fetch(`${m.url}${sc.post}`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).summary ?? '';
    })()
        .then(summary => { st.summary = summary; st.error = null; st.sent++; })
        .catch(err => { st.error = err.message; })
        .finally(() => { st.inFlight--; });
}

function onFrame(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    const now = Date.now();
    if (snapshotWanted) {
        snapshotWanted = false;
        const full = new OffscreenCanvas(w, h);
        full.getContext('2d').drawImage(frame, 0, 0, w, h);
        full.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
            .then(blob => postMessage({ type: 'snapshot', blob }))
            .catch(err => postMessage({ type: 'snapshot', error: err.message }));
    }
    if (wanted.length) sendWanted(frame, w, h);
    if (now - lastStatus >= STATUS_MS) {
        lastStatus = now;
        refreshSpecs();
        askForRequests();
        postMessage({ type: 'status', modules: modules.map(({ name, url, spec, error, screens, pictures }) =>
            ({ name, url, error, module: spec?.module, pictures: spec?.requests ? pictures : null,
               screens: (spec?.screens ?? []).map(sc => ({ label: sc.label ?? sc.id, ...screens[sc.id] })) })) });
    }
    const anyShowing = modules.some(m => Object.values(m.screens).some(st => st.showing));
    if (!anyShowing && now - lastCheck < IDLE_CHECK_MS) return;
    lastCheck = now;
    for (const m of modules) {
        if (!m.spec) continue;
        for (const sc of m.spec.screens) {
            const st = m.screens[sc.id];
            st.showing = showing(frame, sc, w, h);
            if (st.showing && st.inFlight < MAX_IN_FLIGHT && now - st.last >= sc.every_ms) send(frame, m, sc, st, w, h);
        }
    }
}
