# ClipCompress v9 — Website for Laptop + iPhone

This is the **website** version, not a Chrome extension. It requires no FFmpeg/WASM, server, API key, or extension. Use one deployed GitHub Pages URL on laptop or iPhone.

## Features
- Batch queue with sequential processing and cleanup after each video
- 720p 30 FPS Quality; 720p 24 FPS Fast; 540p 24 FPS compatibility option
- Size targets 8, **20**, 25, 50, 100 MB or custom
- Multiple middle cuts per video, keep beginning and end
- Keep or mute audio; skip files already below target
- Strict-size retry, optional safe retry only after actual encode errors
- Clear finished, retry failed, remove duplicate selections, smallest-first, cancel, progress/ETA, error details
- Download on laptop or iOS Share sheet on iPhone
- Home screen icon and offline shell via service worker

## Deploy GitHub Pages
1. Unzip `ClipCompress-Website-v9.zip`.
2. Upload **the files inside the folder**, including `index.html`, to the root of the GitHub `ClipCompress` repository (not a ZIP).
3. Overwrite the previous `app.js` and `README.md` where prompted. Use this website version's files, **not** the old Chrome-extension files.
4. Settings > Pages > Deploy from a branch > `main` > `/(root)` > Save.
5. Open `https://ludogyat-ui.github.io/ClipCompress/` in Safari or laptop Chrome. Refresh and confirm the label `v9 website`.
6. On iPhone, Safari Share > Add to Home Screen.

Unused Chrome extension files may remain in the repository, but do not serve the website; `index.html` at repository root is what matters. You can remove `manifest.json`, `popup.*` and the former extension assets later if desired. **Do not delete `index.html`.**

## Technical limits
This version replays source video through canvas and MediaRecorder, so conversion runs approximately in real time and requires the page to remain open. Output size is an estimate, not a guaranteed cap; MediaRecorder may output WebM on some browsers. Extremely large videos/long batches can exceed browser memory. The app does not upload video to any server. Files in the queue are not persistent across page reloads.

If output does not meet your 20 MB target, use 25/50 MB for sharper 720p, or use Fast. Forcing 20 MB on a long recording necessarily reduces bitrate and detail. Avoid switching apps or locking the screen while encoding if the browser pauses video playback.
