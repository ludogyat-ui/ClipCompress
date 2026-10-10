# ClipCompress Chrome Extension v8

This rebuild removes FFmpeg/WebAssembly from the **primary conversion path**. Normal conversions use Chrome's native `MediaRecorder` + canvas pipeline instead, so the common WASM crashes (`memory access out of bounds`, `indirect call`, heap failures) are no longer part of normal processing.

## Main features

- Batch-select multiple videos
- Sequential processing (one encoder/decoder at a time)
- 720p Quality at 30 fps
- 720p Fast at 24 fps
- 540p Light / final compatibility fallback
- 20 MB preset, plus 8 / 25 / 50 / 100 MB and custom target
- Multiple middle-section cuts per video
- Keep or remove audio
- Strict-size retry that tries 720p again before lowering resolution
- Safe retry only after a real conversion failure
- No file-size-based Emergency Mode
- Original source video is never modified
- Explicit cleanup of MediaRecorder, streams/tracks, AudioContext, blob URLs, hidden video/canvas, and encoded chunks after every attempt
- Short delay between jobs so Chrome can reclaim decoder/encoder resources
- Detailed errors instead of generic `Conversion Failed`
- Duplicate detection/removal
- Retry failed, clear finished, smallest-first queue
- Download one or all finished files
- Wake Lock when available
- Saved settings through `chrome.storage`

## Size vs. quality

A fixed file-size target gives a fixed bitrate budget. Rough examples for 20 MB before the safety margin:

- 1 minute: about 2.7 Mbps — good for 720p screen video
- 2 minutes: about 1.3 Mbps — usable 720p
- 5 minutes: about 0.53 Mbps — visibly softer no matter which encoder is used

ClipCompress warns when a chosen target is too small for sharp 720p.

## Install

1. Unzip `ClipCompress-Chrome-v8.zip`.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `ClipCompress-Chrome-v8` folder.
6. Click the ClipCompress toolbar icon → **Open Compressor**.

## Recovering the old installed extension

See `RECOVER_INSTALLED_EXTENSION.md`. A PowerShell helper is also included and only copies files; it does not modify the installed extension.
