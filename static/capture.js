/**
 * capture.js
 * Shares the game screen and sends each module the part it asked for, while that screen is showing.
 *
 * The page knows nothing about any game screen. Each module's spec says, per screen it wants:
 *   detect: a small region, shrunk to `size` and compared against `pixels` (grey, 0-255) -- a match at or above
 *           `min_match` means the screen is showing
 *   send:   the region to crop and post, as JPEG at `quality`
 *   post:   where to post it, on the module; every_ms: how often at most
 * Regions are in `ref_width` x `ref_height` pixels and scaled to the captured size.
 *
 * Nothing is recognised here beyond that check: the reading itself is done by the module, in Python.
 */
(() => {
    const TICK_MS = 250;
    const SPEC_RETRY_MS = 30000;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const frameCanvas = document.createElement('canvas');
    const smallCanvas = document.createElement('canvas');

    let stream = null;
    let audio = null;
    // ?replay=<image url>: use a saved capture as the screen, for testing without the game. Same origin only,
    // or the canvas cannot be read back.
    const replayUrl = new URLSearchParams(location.search).get('replay');
    let replay = null;
    const modules = [];          // {name, url, spec, error, nextTry, screens: {id: status}}

    const $ = sel => document.querySelector(sel);

    // ------------------------------------------------------------------ linking the screen

    async function link() {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            showSetup();
            return;
        }
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                // The pointer left out of the picture where Chrome honours it, so it cannot sit over what is read.
                video: { displaySurface: 'monitor', cursor: 'never', frameRate: { ideal: 5, max: 10 } },
                audio: false,
            });
        } catch (e) {
            setLinkStatus(e.name === 'NotAllowedError' ? 'Not linked' : `Could not link: ${e.message}`, 'bad');
            return;
        }
        video.srcObject = stream;
        await video.play().catch(() => {});
        keepAwake();
        stream.getVideoTracks()[0].onended = unlink;
        const label = stream.getVideoTracks()[0].label;
        setLinkStatus(`Linked${label ? `: ${label}` : ''}`, 'good');
        $('#link').textContent = 'Unlink';
    }

    function unlink() {
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        video.srcObject = null;
        audio?.close().catch(() => {});
        audio = null;
        setLinkStatus('Not linked', 'muted');
        $('#link').textContent = 'Link screen';
    }

    /** Chrome slows timers right down in a page it thinks is hidden -- which is this one, under a fullscreen game.
     *  A page playing sound is exempt, so play an inaudible tone (Livestock's fix). */
    function keepAwake() {
        try {
            audio = new (window.AudioContext || window.webkitAudioContext)();
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            gain.gain.value = 0.0001;
            osc.connect(gain).connect(audio.destination);
            osc.start();
        } catch (e) {
            console.warn('[capture] keep-awake audio unavailable', e);
        }
    }

    function showSetup() {
        const el = $('#setup');
        el.classList.remove('hidden');
        el.innerHTML = window.isSecureContext
            ? 'This browser cannot share the screen.'
            : `Screen sharing needs a one-time Chrome setting. Open <span class="mono">chrome://flags/#unsafely-treat-insecure-origin-as-secure</span>,
               add <span class="mono">${location.origin}</span>, enable it and relaunch Chrome.`;
    }

    function setLinkStatus(text, cls) {
        const el = $('#link-status');
        el.textContent = text;
        el.className = cls;
    }

    // ------------------------------------------------------------------ module specs

    async function loadModules() {
        try {
            const list = await (await fetch('/api/modules')).json();
            for (const m of list) modules.push({ ...m, spec: null, error: null, nextTry: 0, screens: {} });
        } catch (e) {
            $('#modules').innerHTML = `<p class="bad">Could not load the module list: ${e.message}</p>`;
        }
    }

    async function refreshSpecs() {
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
                    m.screens[sc.id] = { showing: false, last: 0, busy: false, summary: '', error: null, sent: 0 };
                }
            } catch (e) {
                m.error = `not reachable (${e.message}); retrying`;
            }
        }
    }

    // ------------------------------------------------------------------ each frame

    function scaleRegion(region, sc, w, h) {
        const sx = w / sc.ref_width, sy = h / sc.ref_height;
        const [x, y, rw, rh] = region;
        const X = Math.max(0, Math.round(x * sx)), Y = Math.max(0, Math.round(y * sy));
        return [X, Y, Math.min(w - X, Math.round(rw * sx)), Math.min(h - Y, Math.round(rh * sy))];
    }

    /** Is this screen showing? Shrink the detect region, grey it the way OpenCV does, correlate with the spec. */
    function showing(sc, w, h) {
        const [x, y, rw, rh] = scaleRegion(sc.detect.region, sc, w, h);
        const [sw, sh] = sc.detect.size;
        smallCanvas.width = sw;
        smallCanvas.height = sh;
        const ctx = smallCanvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(frameCanvas, x, y, rw, rh, 0, 0, sw, sh);
        const px = ctx.getImageData(0, 0, sw, sh).data;
        const ref = sc.detect.pixels;
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
        return da && db ? num / Math.sqrt(da * db) >= sc.detect.min_match : false;
    }

    async function send(m, sc, status, w, h) {
        const [x, y, rw, rh] = scaleRegion(sc.send.region, sc, w, h);
        const crop = document.createElement('canvas');
        crop.width = rw;
        crop.height = rh;
        crop.getContext('2d').drawImage(frameCanvas, x, y, rw, rh, 0, 0, rw, rh);
        const blob = await new Promise(r => crop.toBlob(r, 'image/jpeg', sc.send.quality ?? 0.9));
        const form = new FormData();
        form.append('file', blob, `${sc.id}.jpg`);
        form.append('screen', sc.id);
        form.append('capture_w', w);
        form.append('capture_h', h);
        form.append('x', x); form.append('y', y); form.append('w', rw); form.append('h', rh);
        const res = await fetch(`${m.url}${sc.post}`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).summary ?? '';
    }

    function tick() {
        const source = stream ? video : replay;
        const w = stream ? video.videoWidth : replay?.naturalWidth;
        const h = stream ? video.videoHeight : replay?.naturalHeight;
        if (!source || !w) return;
        frameCanvas.width = w;
        frameCanvas.height = h;
        frameCanvas.getContext('2d').drawImage(source, 0, 0, w, h);
        const now = Date.now();
        for (const m of modules) {
            if (!m.spec) continue;
            for (const sc of m.spec.screens) {
                const st = m.screens[sc.id];
                st.showing = showing(sc, w, h);
                // One upload at a time per screen: a slow module gets fewer frames, never a queue of stale ones.
                if (!st.showing || st.busy || now - st.last < sc.every_ms) continue;
                st.busy = true;
                st.last = now;
                send(m, sc, st, w, h)
                    .then(summary => { st.summary = summary; st.error = null; st.sent++; })
                    .catch(e => { st.error = e.message; })
                    .finally(() => { st.busy = false; });
            }
        }
    }

    // ------------------------------------------------------------------ status

    function render() {
        const el = $('#modules');
        if (!modules.length) return;
        el.innerHTML = modules.map(m => {
            const head = `<div class="module-name">${m.spec?.module ?? m.name} <span class="muted small mono">${m.url}</span></div>`;
            if (!m.spec) return `<div class="module">${head}<div class="bad small">${m.error ?? 'connecting…'}</div></div>`;
            const rows = m.spec.screens.map(sc => {
                const st = m.screens[sc.id];
                const state = !stream && !replay ? '<span class="muted">screen not linked</span>'
                    : st.showing ? '<span class="good">showing</span>' : '<span class="muted">not on screen</span>';
                const result = st.error ? `<span class="bad">${st.error}</span>` : (st.summary || '');
                return `<div>${sc.label ?? sc.id}</div><div>${state} · ${st.sent} sent${result ? ' · ' + result : ''}</div>`;
            }).join('');
            return `<div class="module">${head}<div class="screen">${rows}</div></div>`;
        }).join('');
    }

    // ------------------------------------------------------------------ start

    $('#link').addEventListener('click', () => (stream ? unlink() : link()));
    if (replayUrl) {
        const img = new Image();
        img.onload = () => { replay = img; setLinkStatus(`Replaying ${replayUrl}`, 'warn'); };
        img.src = replayUrl;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) showSetup();
    loadModules().then(refreshSpecs);
    setInterval(tick, TICK_MS);
    setInterval(refreshSpecs, 5000);
    setInterval(render, 500);
})();
