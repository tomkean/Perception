"""
Perception: the shared screen capture for the Rust tools.

This server does no image work.  It serves the capture page, which runs in
Chrome on the gaming PC, and tells it which modules to serve.  Each module
(Crossbreeding, Livestock, Sentinel, ...) publishes its own spec -- which
screen it wants, how to recognise it from a few pixels, and what part to send
-- and the page posts the crops straight to that module.  Recognition proper
happens in each module's own backend, in Python, off the gaming PC.

Capture stays in the browser on purpose: anti-cheat will not reach into
Chrome's sandbox, but a standalone capture program, or a store-listed
extension, is something it could single out.
"""
import json
import os
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("PERCEPTION_PORT", 8300))
MODULES_FILE = Path(os.environ.get("PERCEPTION_MODULES", HERE / "modules.json"))
# Whole-screen snapshots, taken from the page to teach a module a new screen.
SNAPSHOT_DIR = Path(os.environ.get("PERCEPTION_SNAPSHOTS", HERE / "snapshots"))

app = FastAPI(title="Perception")


@app.get("/api/modules")
async def modules():
    """The modules the page should ask for specs: [{name, url}, ...].
    Read on every call, so editing the file needs no restart."""
    try:
        return json.loads(MODULES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


@app.post("/api/snapshot")
async def snapshot(file: UploadFile = File(...)):
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    name = time.strftime("snap_%Y%m%d_%H%M%S.jpg")
    (SNAPSHOT_DIR / name).write_bytes(await file.read())
    return {"saved": name}


@app.get("/")
async def index():
    return FileResponse(HERE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
