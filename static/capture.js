/**
 * capture.js
 * Shares the game screen and hands it to capture-worker.js, which sends each module the part it asked for while
 * that screen is showing. This page only links the screen and shows how each module is doing: Chrome holds back
 * a page it thinks is hidden, as this one is under the game, so nothing that has to keep pace runs here.
 *
 * Nothing is recognised beyond the worker's few-pixel check: the reading itself is done by the module, in Python.
 */
(() => {
    let stream = null;
    let audio = null;
    // ?replay=<image url>: use a saved capture as the screen, for testing without the game. Same origin only,
    // or the canvas cannot be read back. It goes through the worker exactly as a shared screen does.
    const replayUrl = new URLSearchParams(location.search).get('replay');
    let moduleList = [];
    let status = null;           // the worker's latest report
    let snapshotPending = false;

    const worker = new Worker('/static/capture-worker.js');
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
                video: { displaySurface: 'monitor', cursor: 'never', frameRate: { ideal: 10, max: 15 } },
                audio: false,
            });
        } catch (e) {
            setLinkStatus(e.name === 'NotAllowedError' ? 'Not linked' : `Could not link: ${e.message}`, 'bad');
            return;
        }
        keepAwake();
        const track = stream.getVideoTracks()[0];
        track.onended = unlink;
        startWorker(track);
        setLinkStatus(`Linked${track.label ? `: ${track.label}` : ''}`, 'good');
        $('#link').textContent = 'Unlink';
    }

    function unlink() {
        worker.postMessage({ type: 'stop' });
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        status = null;
        audio?.close().catch(() => {});
        audio = null;
        setLinkStatus('Not linked', 'muted');
        $('#link').textContent = 'Link screen';
    }

    /** Hand the track's frames to the worker. */
    function startWorker(track) {
        if (!window.MediaStreamTrackProcessor) {
            setLinkStatus('This browser cannot pass the screen to a worker; use Chrome', 'bad');
            return;
        }
        const { readable } = new MediaStreamTrackProcessor({ track });
        worker.postMessage({ type: 'start', readable, modules: moduleList }, [readable]);
    }

    /** Chrome can freeze a page it thinks is hidden, but not one playing sound, so play an inaudible tone
     *  (Livestock's fix). It keeps this page answering the worker; the worker keeps the pace. */
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

    /** A saved capture played as a 10 fps screen. */
    function startReplay(url) {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            // A canvas stream only carries a frame when the canvas is drawn on, so keep drawing.
            setInterval(() => ctx.drawImage(img, 0, 0), 100);
            ctx.drawImage(img, 0, 0);
            startWorker(canvas.captureStream(10).getVideoTracks()[0]);
            setLinkStatus(`Replaying ${url}`, 'warn');
        };
        img.src = url;
    }

    // ------------------------------------------------------------------ snapshot

    /** Save the whole current screen on the Pi. */
    function snapshot() {
        if (!stream && !replayUrl) { setLinkStatus('Link the screen first', 'bad'); return; }
        snapshotPending = true;
        worker.postMessage({ type: 'snapshot' });
    }

    async function saveSnapshot(msg) {
        if (!snapshotPending) return;
        snapshotPending = false;
        try {
            if (msg.error) throw new Error(msg.error);
            const form = new FormData();
            form.append('file', msg.blob, 'snapshot.jpg');
            const res = await fetch('/api/snapshot', { method: 'POST', body: form });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            $('#snap').textContent = `Saved ${(await res.json()).saved}`;
        } catch (e) {
            $('#snap').textContent = `Snapshot failed: ${e.message}`;
        }
        setTimeout(() => { $('#snap').textContent = 'Snapshot'; }, 4000);
    }

    // ------------------------------------------------------------------ status

    function render() {
        const el = $('#modules');
        if (!moduleList.length) return;
        const reported = status ?? moduleList.map(m => ({ ...m, screens: [] }));
        el.innerHTML = reported.map(m => {
            const head = `<div class="module-name">${m.module ?? m.name} <span class="muted small mono">${m.url}</span></div>`;
            if (!status) return `<div class="module">${head}<div class="muted small">screen not linked</div></div>`;
            if (!m.module) return `<div class="module">${head}<div class="bad small">${m.error ?? 'connecting…'}</div></div>`;
            const rows = m.screens.map(st => {
                const state = st.showing ? '<span class="good">showing</span>' : '<span class="muted">not on screen</span>';
                const result = st.error ? `<span class="bad">${st.error}</span>` : (st.summary || '');
                return `<div>${st.label}</div><div>${state} · ${st.sent} sent${result ? ' · ' + result : ''}</div>`;
            }).join('') + (m.pictures ? `<div>Whole pictures</div><div>${m.pictures.sent} sent on request${
                m.pictures.error ? ` · <span class="bad">${m.pictures.error}</span>` : ''}</div>` : '');
            return `<div class="module">${head}<div class="screen">${rows}</div></div>`;
        }).join('');
    }

    worker.onmessage = e => {
        if (e.data.type === 'status') { status = e.data.modules; render(); }
        else if (e.data.type === 'snapshot') saveSnapshot(e.data);
    };

    // ------------------------------------------------------------------ start

    $('#link').addEventListener('click', () => (stream ? unlink() : link()));
    $('#snap').addEventListener('click', snapshot);
    if (!navigator.mediaDevices?.getDisplayMedia) showSetup();
    fetch('/api/modules')
        .then(r => r.json())
        .then(list => {
            moduleList = list;
            render();
            if (replayUrl) startReplay(replayUrl);
        })
        .catch(e => { $('#modules').innerHTML = `<p class="bad">Could not load the module list: ${e.message}</p>`; });
})();
