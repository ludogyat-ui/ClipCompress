# ClipCompress v5

An iPhone-friendly installable PWA for cutting middle sections from screen recordings and batch compressing them toward a chosen size.

## v5 features

- 8 MB, 20 MB, 25 MB, 50 MB, 100 MB, or custom target
- Smart mode (recommended)
- Fast mode: 480p / 24 fps
- Balanced mode: up to 720p
- Best quality mode: up to 1080p
- Large-file low-memory mode
- Optional audio removal
- Automatically skips re-encoding files already under the target
- Multiple middle-section cuts
- Queue statistics
- Smallest-first processing option
- Retry failed videos
- Clear finished videos
- Cancel current compression
- ETA while FFmpeg progress is available
- Screen Wake Lock during compression when supported by iOS/Safari
- Detailed FFmpeg error logs
- Automatic retry without audio when a recording has an audio-stream problem
- Corrupt-frame tolerance
- Single-pass encoding in Smart/Fast/Balanced for substantially faster results
- Best mode can retry once to get closer to the exact size
- WORKERFS input so large selected videos do not first get copied wholesale into FFmpeg memory
- Local/on-device video processing

## Install

Publish these files through GitHub Pages. Open the Pages URL in Safari, tap Share, then Add to Home Screen.

## Important iPhone limitation

This is still a browser-based FFmpeg/WebAssembly compressor, so giant recordings will be slower than a native or cloud transcoder. Smart/Fast modes are designed to reduce that wait as much as practical.
