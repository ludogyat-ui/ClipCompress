# ClipCompress PWA

ClipCompress is an installable iPhone web app for:

- selecting multiple videos at once
- removing one or more middle sections from each video
- keeping the beginning and ending
- compressing each video toward 8 MB / 25 MB / 50 MB / 100 MB / custom targets
- sharing the finished MP4 through the iOS share sheet
- running the actual video processing on-device with ffmpeg.wasm

## Deploy with GitHub Pages

1. Create a new **public** GitHub repository, for example `clipcompress`.
2. Upload every file in this folder to the repository root.
3. Open the repository's **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Choose `main` and `/ (root)`, then Save.
6. GitHub will show the Pages URL once deployment is ready.

## Install on iPhone

1. Open the GitHub Pages URL in **Safari**.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Turn on **Open as Web App** if shown.
5. Tap **Add**.

## How to save a finished video

Tap **Share / Save** on the finished file. iOS opens its share sheet, where you can choose the available save/share destination.

## Privacy

ClipCompress itself does not upload selected videos to a server. The browser processes them locally. The app loads the ffmpeg.wasm compressor engine from jsDelivr the first time it is used.

## Practical iPhone limitation

Browser-based video encoding uses substantial RAM. Very long or 4K videos may exceed Safari's memory limits. If that happens, trim the recording first, use a smaller number of videos in one session, or work from a lower-resolution source.

## Target-size behavior

The app estimates a bitrate from the selected target and final duration, leaves a safety margin, and automatically retries once at a lower bitrate if the first output is too large. The goal is to stay below the chosen size without cutting off the end of the video.


## v2 iPhone fix

This build hosts the FFmpeg class worker from the same GitHub Pages origin, uses the matching 0.12.10 UMD core, adds a 45-second engine startup timeout with visible errors, and uses WORKERFS for selected input files to avoid first duplicating very large recordings into WebAssembly memory.

## v4 Safari startup fix

- Added a dedicated 20 MB preset.
- Uses the matching @ffmpeg/core 0.12.10 ESM core inside the module worker.
- Keeps the same-origin FFmpeg class worker.
- Shows the actual engine startup error if initialization fails.
- Cache bumped to clipcompress-v4 so iPhone Safari will replace the old app shell.
