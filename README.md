# Perception

The shared screen capture for the Rust tools: Crossbreeding, Livestock and Sentinel.

A page served from the Pi runs in Chrome on the gaming PC. It shares the screen, and for each module it checks a
few pixels the module names to see whether the screen that module wants is showing -- for Crossbreeding, an open
box -- and if so posts just that part of the screen to the module. Every module does its own recognition, in
Python, on its own machine. Nothing here knows what a clone or an animal is.

Capture stays inside Chrome on purpose: anti-cheat will not reach into the browser's sandbox, but a standalone
capture program, or a store-listed extension, is something it could single out.

## Using it

1. Once per gaming PC: open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://raspberrypi:8300`,
   enable it and relaunch Chrome. (Screen sharing is only allowed on secure pages; this is the alternative to
   certificates.)
2. Open http://raspberrypi:8300, click **Link screen** and pick the screen Rust is on.
3. Leave the tab open and play. It keeps itself awake with an inaudible tone, as Chrome otherwise slows a hidden
   page right down.

## Modules

`modules.json` lists the modules to serve, by address. Each one answers `GET /api/perception/spec` with the screens
it wants:

```json
{"module": "Crossbreeding", "screens": [{
   "id": "box", "label": "Open box", "ref_width": 3840, "ref_height": 2160,
   "detect": {"region": [x, y, w, h], "size": [40, 18], "pixels": [...], "min_match": 0.8},
   "send": {"region": [x, y, w, h], "quality": 0.92},
   "post": "/api/perception/frame", "every_ms": 700}]}
```

`pixels` is the detect region shrunk to `size`, greyscale 0-255. `detect` may be a list, all of which must match, or
left out for a screen that is always sent (the module tells its screens apart itself). Without `send` the whole
screen is sent. The page posts the crop as multipart: `file` (JPEG), `screen`, `capture_w`, `capture_h`, `taken`
(ms), and `x`, `y`, `w`, `h` (where the crop came from, in captured pixels). The module replies
`{"summary": "..."}`, which the page shows. A module has to allow this page's origin (`http://raspberrypi:8300`) for
cross-origin requests.

A spec may also have `"requests": "/some/path"`. The page asks it every half second; the module answers
`{"pictures": [{"post": "/path", "fields": {...}}]}` when something -- a button on a phone, a hotkey -- wants a whole
picture of the screen now, and hands each request out once. The next frame is posted whole to each `post` with
`file`, `capture_w`, `capture_h`, `taken` and the `fields`.

| Module | Address | Screens | Whole pictures |
|---|---|---|---|
| Crossbreeding | this PC :8200 | open box (grid crop) | - |
| Livestock | this PC :8100 | card strip, always, every 2 s | Capture button |
| Sentinel | Pi :8000 | death screen (whole) | recon snaps |

## Deploying

```
sh deploy_to_pi.sh
```

Copies the files to `/home/tom/Perception` on the Pi, sets up a virtualenv and runs it as the `perception` systemd
service on port 8300.
