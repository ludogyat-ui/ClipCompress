import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const $ = (s) => document.querySelector(s);
const fileInput = $("#fileInput");
const queueEl = $("#queue");
const template = $("#jobTemplate");
const compressAllBtn = $("#compressAllBtn");
const shareAllBtn = $("#shareAllBtn");
const clearBtn = $("#clearBtn");
const customMB = $("#customMB");
const engineStatus = $("#engineStatus");
const editorDialog = $("#editorDialog");
const editorVideo = $("#editorVideo");
const editorName = $("#editorName");
const startRange = $("#startRange");
const endRange = $("#endRange");
const startLabel = $("#startLabel");
const endLabel = $("#endLabel");
const cutList = $("#cutList");
const timeline = $("#timeline");

let jobs = [];
let targetMB = 8;
let activeJob = null;
let ffmpeg = null;
let engineReady = false;
let running = false;
let currentProgressJob = null;

const ENGINE_LOAD_TIMEOUT_MS = 45000;

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

document.querySelectorAll(".target").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".target").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    targetMB = Number(btn.dataset.mb);
    customMB.value = "";
    renderQueue();
  });
});

customMB.addEventListener("input", () => {
  const n = Number(customMB.value);
  if (Number.isFinite(n) && n >= 1) {
    targetMB = n;
    document.querySelectorAll(".target").forEach(x => x.classList.remove("active"));
    renderQueue();
  }
});

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  for (const file of files) {
    const duration = await getDuration(file);
    jobs.push({
      id: crypto.randomUUID(),
      file,
      duration,
      cuts: [],
      state: "ready",
      progress: 0,
      output: null,
      outputSize: 0,
      error: ""
    });
  }
  renderQueue();
});

clearBtn.addEventListener("click", () => {
  if (running) return;
  for (const j of jobs) if (j.output?.url) URL.revokeObjectURL(j.output.url);
  jobs = [];
  renderQueue();
});

compressAllBtn.addEventListener("click", async () => {
  if (running || !jobs.length) return;
  running = true;
  renderQueue();
  try {
    await ensureEngine();
    for (const job of jobs) {
      if (job.state === "done") continue;
      await compressJob(job);
    }
  } catch (error) {
    console.error(error);
    engineStatus.textContent = `Compressor could not start: ${error?.message || error}`;
    alert(`ClipCompress could not start the compressor.\n\nError: ${error?.message || error}\n\nRefresh once and try again. If it returns, send me a screenshot.`);
  } finally {
    running = false;
    currentProgressJob = null;
    renderQueue();
  }
});

shareAllBtn.addEventListener("click", async () => {
  const finished = jobs.filter(j => j.state === "done" && j.output?.file);
  if (!finished.length) return;
  const files = finished.map(j => j.output.file);
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files, title: "ClipCompress exports" }).catch(() => {});
  } else {
    alert("Your browser cannot share several files at once. Use Share / Save on each video.");
  }
});

$("#closeEditor").addEventListener("click", closeEditor);
$("#doneEditor").addEventListener("click", closeEditor);
$("#clearCutsBtn").addEventListener("click", () => {
  if (!activeJob) return;
  activeJob.cuts = [];
  renderEditorCuts();
});
$("#playheadStart").addEventListener("click", () => {
  if (!activeJob) return;
  startRange.value = Math.min(editorVideo.currentTime, Number(endRange.value) - 0.05);
  syncEditorLabels();
});
$("#playheadEnd").addEventListener("click", () => {
  if (!activeJob) return;
  endRange.value = Math.max(editorVideo.currentTime, Number(startRange.value) + 0.05);
  syncEditorLabels();
});
startRange.addEventListener("input", () => {
  if (Number(startRange.value) >= Number(endRange.value)) {
    startRange.value = Math.max(0, Number(endRange.value) - 0.05);
  }
  editorVideo.currentTime = Number(startRange.value);
  syncEditorLabels();
});
endRange.addEventListener("input", () => {
  if (Number(endRange.value) <= Number(startRange.value)) {
    endRange.value = Math.min(activeJob?.duration || 1, Number(startRange.value) + 0.05);
  }
  editorVideo.currentTime = Number(endRange.value);
  syncEditorLabels();
});
$("#addCutBtn").addEventListener("click", () => {
  if (!activeJob) return;
  const start = Number(startRange.value);
  const end = Number(endRange.value);
  if (!(end > start + 0.04)) return;
  activeJob.cuts.push({ id: crypto.randomUUID(), start, end });
  activeJob.cuts = mergeCuts(activeJob.cuts, activeJob.duration);
  activeJob.state = "ready";
  if (activeJob.output?.url) URL.revokeObjectURL(activeJob.output.url);
  activeJob.output = null;
  activeJob.outputSize = 0;
  renderEditorCuts();
});

function closeEditor() {
  editorVideo.pause();
  editorVideo.removeAttribute("src");
  editorVideo.load();
  editorDialog.close();
  activeJob = null;
  renderQueue();
}

function openEditor(job) {
  activeJob = job;
  editorName.textContent = job.file.name;
  editorVideo.src = URL.createObjectURL(job.file);
  startRange.max = job.duration;
  endRange.max = job.duration;
  startRange.value = 0;
  endRange.value = Math.min(job.duration, Math.max(1, job.duration * 0.1));
  syncEditorLabels();
  renderEditorCuts();
  editorDialog.showModal();
}

function syncEditorLabels() {
  startLabel.textContent = formatTime(Number(startRange.value));
  endLabel.textContent = formatTime(Number(endRange.value));
}

function renderEditorCuts() {
  if (!activeJob) return;
  cutList.innerHTML = "";
  timeline.innerHTML = "";

  if (!activeJob.cuts.length) {
    cutList.innerHTML = `<div class="job-status">No cuts yet.</div>`;
  }

  activeJob.cuts.forEach(cut => {
    const block = document.createElement("div");
    block.className = "cut-block";
    block.style.left = `${(cut.start / activeJob.duration) * 100}%`;
    block.style.width = `${((cut.end - cut.start) / activeJob.duration) * 100}%`;
    timeline.appendChild(block);

    const row = document.createElement("div");
    row.className = "cut-row";
    row.innerHTML = `
      <span>${formatTime(cut.start)} → ${formatTime(cut.end)}</span>
      <span>-${formatTime(cut.end - cut.start)}</span>
      <button aria-label="Delete cut">×</button>`;
    row.querySelector("button").addEventListener("click", () => {
      activeJob.cuts = activeJob.cuts.filter(x => x.id !== cut.id);
      activeJob.state = "ready";
      renderEditorCuts();
    });
    cutList.appendChild(row);
  });
}

function renderQueue() {
  queueEl.innerHTML = "";
  if (!jobs.length) {
    queueEl.className = "queue empty";
    queueEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <strong>No videos yet</strong>
        <span>Tap Add videos above.</span>
      </div>`;
    compressAllBtn.disabled = true;
    shareAllBtn.hidden = true;
    return;
  }

  queueEl.className = "queue";
  compressAllBtn.disabled = running;
  compressAllBtn.textContent = running ? "Compressing queue…" : "Compress all";
  shareAllBtn.hidden = !jobs.some(j => j.state === "done");

  for (const job of jobs) {
    const node = template.content.cloneNode(true);
    const article = node.querySelector(".job");
    article.dataset.id = job.id;
    node.querySelector(".job-name").textContent = job.file.name;
    node.querySelector(".job-meta").textContent = `${formatBytes(job.file.size)} • ${formatTime(job.duration)} • target ${targetMB} MB`;
    node.querySelector(".job-cuts").textContent = job.cuts.length
      ? `${job.cuts.length} cut${job.cuts.length === 1 ? "" : "s"} • removes ${formatTime(totalCutDuration(job.cuts))}`
      : "";

    const status = node.querySelector(".job-status");
    const progress = node.querySelector(".job-progress");
    const progressBar = progress.firstElementChild;
    const result = node.querySelector(".job-result");
    const share = node.querySelector(".share-job");

    if (job.state === "processing") {
      status.textContent = `Compressing… ${Math.round(job.progress * 100)}%`;
      progress.hidden = false;
      progressBar.style.width = `${Math.min(100, Math.max(2, job.progress * 100))}%`;
    } else if (job.state === "done") {
      status.textContent = "Finished";
      result.hidden = false;
      result.textContent = `${formatBytes(job.file.size)} → ${formatBytes(job.outputSize)}`;
      share.hidden = false;
    } else if (job.state === "error") {
      status.textContent = `Could not compress: ${job.error || "Unknown error"}`;
      status.style.color = "#ff8b96";
    } else {
      status.textContent = "Ready";
    }

    node.querySelector(".remove-job").disabled = running;
    node.querySelector(".remove-job").addEventListener("click", () => {
      if (running) return;
      if (job.output?.url) URL.revokeObjectURL(job.output.url);
      jobs = jobs.filter(j => j.id !== job.id);
      renderQueue();
    });
    node.querySelector(".edit-job").disabled = running;
    node.querySelector(".edit-job").addEventListener("click", () => openEditor(job));
    node.querySelector(".compress-job").disabled = running || job.state === "processing";
    node.querySelector(".compress-job").addEventListener("click", async () => {
      if (running) return;
      running = true;
      renderQueue();
      try {
        await ensureEngine();
        await compressJob(job);
      } catch (error) {
        console.error(error);
        engineStatus.textContent = `Compressor could not start: ${error?.message || error}`;
        alert(`ClipCompress could not start the compressor.\n\nError: ${error?.message || error}\n\nRefresh once and try again. If it returns, send me a screenshot.`);
      } finally {
        running = false;
        currentProgressJob = null;
        renderQueue();
      }
    });
    share.addEventListener("click", () => shareJob(job));
    queueEl.appendChild(node);
  }
}

async function ensureEngine() {
  if (engineReady) return;

  engineStatus.textContent = "Loading compressor engine…";
  ffmpeg = new FFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    if (!currentProgressJob) return;
    currentProgressJob.progress = Math.max(0, Math.min(1, progress || 0));
    const row = document.querySelector(`.job[data-id="${currentProgressJob.id}"]`);
    if (row) {
      const bar = row.querySelector(".job-progress");
      const fill = bar.firstElementChild;
      const status = row.querySelector(".job-status");
      bar.hidden = false;
      fill.style.width = `${Math.max(2, currentProgressJob.progress * 100)}%`;
      status.textContent = `Compressing… ${Math.round(currentProgressJob.progress * 100)}%`;
    }
  });

  ffmpeg.on("log", ({ message }) => {
    console.log("[ffmpeg]", message);
  });

  // Use the official single-thread UMD core version that matches the wrapper.
  // The wrapper itself is loaded as an ES module, so we explicitly point it at
  // a same-origin worker hosted with this app. This avoids Safari/CDN worker issues.
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const classWorkerURL = new URL("./ffmpeg-worker.js", window.location.href).href;

  try {
    await withTimeout(
      ffmpeg.load({
        classWorkerURL,
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm")
      }),
      ENGINE_LOAD_TIMEOUT_MS,
      "engine load timed out"
    );
  } catch (error) {
    try { ffmpeg.terminate(); } catch {}
    ffmpeg = null;
    engineReady = false;
    throw error;
  }

  engineReady = true;
  engineStatus.textContent = "Compressor ready • processing stays on this device.";
}
async function compressJob(job) {
  currentProgressJob = job;
  job.state = "processing";
  job.progress = 0;
  job.error = "";
  if (job.output?.url) URL.revokeObjectURL(job.output.url);
  job.output = null;
  renderQueue();

  const outputName = `clipcompress-${job.id}.mp4`;
  const mountPoint = `/input-${job.id}`;
  const inputPath = `${mountPoint}/${job.file.name}`;
  let mounted = false;

  try {
    engineStatus.textContent = `Preparing ${job.file.name}…`;

    // WORKERFS lets ffmpeg read the selected File directly instead of first
    // duplicating a 500+ MB recording into ffmpeg's in-memory filesystem.
    await ffmpeg.createDir(mountPoint);
    await ffmpeg.mount("WORKERFS", { files: [job.file] }, mountPoint);
    mounted = true;

    const finalDuration = Math.max(0.1, job.duration - totalCutDuration(job.cuts));
    const wantedBytes = Math.max(900_000, targetMB * 1_000_000 - 180_000);
    let totalKbps = Math.floor((wantedBytes * 8) / finalDuration / 1000 * 0.90);
    let audioKbps = totalKbps < 300 ? 40 : 64;
    let videoKbps = Math.max(100, totalKbps - audioKbps);
    let attempts = 0;

    while (attempts < 2) {
      attempts += 1;
      currentProgressJob.progress = 0;
      engineStatus.textContent = `Compressing ${job.file.name} • pass ${attempts}/2`;

      const maxHeight = videoKbps < 350 ? 360 : videoKbps < 700 ? 480 : videoKbps < 1500 ? 720 : 1080;
      const args = buildCommand(job, inputPath, outputName, videoKbps, audioKbps, maxHeight, true);

      let exitCode;
      try {
        exitCode = await ffmpeg.exec(args);
        if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);
      } catch (audioError) {
        // Some screen recordings contain no audio stream.
        const videoOnlyArgs = buildCommand(job, inputPath, outputName, videoKbps, audioKbps, maxHeight, false);
        exitCode = await ffmpeg.exec(videoOnlyArgs);
        if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);
      }

      const data = await ffmpeg.readFile(outputName);
      const outputBytes = data.byteLength;

      if (outputBytes <= wantedBytes || attempts >= 2) {
        const blob = new Blob([data.buffer], { type: "video/mp4" });
        const exportName = `${stripExtension(job.file.name)}-compressed.mp4`;
        const file = new File([blob], exportName, { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        job.output = { blob, file, url };
        job.outputSize = outputBytes;
        break;
      }

      const ratio = wantedBytes / outputBytes;
      videoKbps = Math.max(90, Math.floor(videoKbps * ratio * 0.90));
      try { await ffmpeg.deleteFile(outputName); } catch {}
    }

    if (!job.output) throw new Error("No output file was created.");

    job.state = "done";
    job.progress = 1;
    engineStatus.textContent = "Compressor ready • processing stays on this device.";
  } catch (error) {
    console.error(error);
    job.state = "error";
    job.error = String(error?.message || error || "Compression failed");
    engineStatus.textContent = "Compression stopped. See the video row for the error.";
  } finally {
    try { await ffmpeg.deleteFile(outputName); } catch {}
    if (mounted) {
      try { await ffmpeg.unmount(mountPoint); } catch {}
    }
    try { await ffmpeg.deleteDir(mountPoint); } catch {}
    currentProgressJob = null;
    renderQueue();
  }
}
function buildCommand(job, inputName, outputName, videoKbps, audioKbps, maxHeight, includeAudio) {
  const scale = `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease`;
  const cuts = mergeCuts(job.cuts, job.duration);

  if (!cuts.length) {
    const args = [
      "-i", inputName,
      "-map", "0:v:0"
    ];
    if (includeAudio) args.push("-map", "0:a:0");
    args.push(
      "-vf", scale,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-b:v", `${videoKbps}k`,
      "-maxrate", `${Math.floor(videoKbps * 1.12)}k`,
      "-bufsize", `${Math.floor(videoKbps * 2)}k`,
      "-pix_fmt", "yuv420p"
    );
    if (includeAudio) args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
    else args.push("-an");
    args.push("-movflags", "+faststart", "-y", outputName);
    return args;
  }

  const expr = cuts.map(c => `between(t\\,${c.start.toFixed(3)}\\,${c.end.toFixed(3)})`).join("+");
  const keep = `not(${expr})`;
  let filter = `[0:v]select='${keep}',setpts=N/FRAME_RATE/TB,${scale}[v]`;
  if (includeAudio) {
    filter += `;[0:a]aselect='${keep}',asetpts=N/SR/TB[a]`;
  }

  const args = [
    "-i", inputName,
    "-filter_complex", filter,
    "-map", "[v]"
  ];
  if (includeAudio) args.push("-map", "[a]");
  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-b:v", `${videoKbps}k`,
    "-maxrate", `${Math.floor(videoKbps * 1.12)}k`,
    "-bufsize", `${Math.floor(videoKbps * 2)}k`,
    "-pix_fmt", "yuv420p"
  );
  if (includeAudio) args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
  else args.push("-an");
  args.push("-movflags", "+faststart", "-y", outputName);
  return args;
}

async function shareJob(job) {
  if (!job.output?.file) return;
  const file = job.output.file;

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: file.name
    }).catch(() => {});
    return;
  }

  const a = document.createElement("a");
  a.href = job.output.url;
  a.download = file.name;
  a.click();
}

function mergeCuts(cuts, duration) {
  const normalized = cuts
    .map(c => ({
      id: c.id || crypto.randomUUID(),
      start: Math.max(0, Math.min(duration, Math.min(c.start, c.end))),
      end: Math.max(0, Math.min(duration, Math.max(c.start, c.end)))
    }))
    .filter(c => c.end - c.start > 0.01)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const cut of normalized) {
    const last = out[out.length - 1];
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
    } else {
      out.push({ ...cut });
    }
  }
  return out;
}

function totalCutDuration(cuts) {
  if (!cuts?.length) return 0;
  const maxDuration = activeJob?.duration || Number.MAX_SAFE_INTEGER;
  return mergeCuts(cuts, maxDuration).reduce((sum, c) => sum + (c.end - c.start), 0);
}

function getDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name}`));
    };
    video.src = url;
  });
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "") || "video";
}

function safeExtension(name) {
  const m = name.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "mp4";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(s / 60);
  const sec = s - min * 60;
  return `${min}:${sec.toFixed(2).padStart(5, "0")}`;
}

renderQueue();
