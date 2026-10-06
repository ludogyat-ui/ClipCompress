import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const $ = (s) => document.querySelector(s);

const fileInput = $("#fileInput");
const queueEl = $("#queue");
const template = $("#jobTemplate");
const compressAllBtn = $("#compressAllBtn");
const cancelBtn = $("#cancelBtn");
const shareAllBtn = $("#shareAllBtn");
const clearBtn = $("#clearBtn");
const clearFinishedBtn = $("#clearFinishedBtn");
const retryBtn = $("#retryBtn");
const sortBtn = $("#sortBtn");
const customMB = $("#customMB");
const engineStatus = $("#engineStatus");
const queueStats = $("#queueStats");
const keepAudioEl = $("#keepAudio");
const skipSmallEl = $("#skipSmall");
const lowMemoryEl = $("#lowMemory");

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
let targetMB = 20;
let qualityMode = "smart";
let activeJob = null;
let ffmpeg = null;
let engineReady = false;
let running = false;
let cancelRequested = false;
let currentProgressJob = null;
let currentStartedAt = 0;
let wakeLock = null;
let recentLogs = [];
let sortedSmallestFirst = false;

const ENGINE_LOAD_TIMEOUT_MS = 45000;
const LARGE_FILE_BYTES = 120 * 1_000_000;
const LONG_VIDEO_SECONDS = 75;

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

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && running) {
    await requestWakeLock();
  }
});

document.querySelectorAll(".target").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".target").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    targetMB = Number(btn.dataset.mb);
    customMB.value = "";
    markOutputsStale();
    renderQueue();
  });
});

customMB.addEventListener("input", () => {
  const n = Number(customMB.value);
  if (Number.isFinite(n) && n >= 1) {
    targetMB = n;
    document.querySelectorAll(".target").forEach(x => x.classList.remove("active"));
    markOutputsStale();
    renderQueue();
  }
});

document.querySelectorAll(".mode").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    qualityMode = btn.dataset.mode;
    markOutputsStale();
    renderQueue();
  });
});

for (const el of [keepAudioEl, skipSmallEl, lowMemoryEl]) {
  el.addEventListener("change", () => {
    markOutputsStale();
    renderQueue();
  });
}

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";

  for (const file of files) {
    try {
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
        error: "",
        errorDetails: "",
        note: "",
        emergency: false
      });
    } catch (error) {
      jobs.push({
        id: crypto.randomUUID(),
        file,
        duration: 0,
        cuts: [],
        state: "error",
        progress: 0,
        output: null,
        outputSize: 0,
        error: "Could not read video metadata.",
        errorDetails: String(error),
        note: "",
        emergency: false
      });
    }
  }

  if (sortedSmallestFirst) jobs.sort((a, b) => a.file.size - b.file.size);
  renderQueue();
});

clearBtn.addEventListener("click", () => {
  if (running) return;
  disposeAllOutputs();
  jobs = [];
  renderQueue();
});

clearFinishedBtn.addEventListener("click", () => {
  if (running) return;
  const remove = jobs.filter(j => j.state === "done");
  for (const j of remove) if (j.output?.url) URL.revokeObjectURL(j.output.url);
  jobs = jobs.filter(j => j.state !== "done");
  renderQueue();
});

retryBtn.addEventListener("click", async () => {
  if (running) return;
  for (const job of jobs) {
    if (job.state === "error" || job.state === "cancelled") {
      job.state = "ready";
      job.error = "";
      job.errorDetails = "";
      job.progress = 0;
    }
  }
  renderQueue();
  await runBatch();
});

sortBtn.addEventListener("click", () => {
  if (running) return;
  sortedSmallestFirst = !sortedSmallestFirst;
  if (sortedSmallestFirst) {
    jobs.sort((a, b) => a.file.size - b.file.size);
    sortBtn.textContent = "Original order unavailable";
  } else {
    sortBtn.textContent = "Smallest first";
  }
  renderQueue();
});

compressAllBtn.addEventListener("click", runBatch);

cancelBtn.addEventListener("click", () => {
  if (!running) return;
  cancelRequested = true;
  engineStatus.textContent = "Cancelling current compression…";
  try { ffmpeg?.terminate(); } catch {}
  ffmpeg = null;
  engineReady = false;
});

shareAllBtn.addEventListener("click", async () => {
  const finished = jobs.filter(j => j.state === "done" && j.output?.file);
  if (!finished.length) return;

  const files = finished.map(j => j.output.file);
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files, title: "ClipCompress exports" }).catch(() => {});
  } else {
    alert("iOS could not share all files together. Use Share / Save on each finished video.");
  }
});

async function runBatch() {
  if (running || !jobs.length) return;

  running = true;
  cancelRequested = false;
  renderQueue();
  await requestWakeLock();

  try {
    const pending = jobs.filter(j => j.state !== "done");

    // Short jobs first gives the user usable results sooner.
    if (sortedSmallestFirst) {
      pending.sort((a, b) => a.file.size - b.file.size);
    }

    let needsEngine = pending.some(j => needsTranscode(j));
    if (needsEngine) await ensureEngine();

    for (const job of pending) {
      if (cancelRequested) break;
      await compressJob(job);
    }
  } catch (error) {
    if (!cancelRequested) {
      console.error(error);
      engineStatus.textContent = `Compressor could not start: ${error?.message || error}`;
      alert(`ClipCompress could not start the compressor.\n\nError: ${error?.message || error}`);
    }
  } finally {
    running = false;
    currentProgressJob = null;
    cancelRequested = false;
    await releaseWakeLock();
    renderQueue();
  }
}

function needsTranscode(job) {
  const safeBytes = targetBytes();
  return !(skipSmallEl.checked && job.cuts.length === 0 && job.file.size <= safeBytes);
}

function markOutputsStale() {
  if (running) return;
  for (const job of jobs) {
    if (job.state === "done") {
      if (job.output?.url) URL.revokeObjectURL(job.output.url);
      job.output = null;
      job.outputSize = 0;
      job.state = "ready";
      job.note = "";
    }
  }
}

function disposeAllOutputs() {
  for (const j of jobs) if (j.output?.url) URL.revokeObjectURL(j.output.url);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

$("#closeEditor").addEventListener("click", closeEditor);
$("#doneEditor").addEventListener("click", closeEditor);

$("#clearCutsBtn").addEventListener("click", () => {
  if (!activeJob) return;
  activeJob.cuts = [];
  invalidateJob(activeJob);
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
  invalidateJob(activeJob);
  renderEditorCuts();
});

function invalidateJob(job) {
  if (job.output?.url) URL.revokeObjectURL(job.output.url);
  job.output = null;
  job.outputSize = 0;
  job.state = "ready";
  job.error = "";
  job.errorDetails = "";
  job.note = "";
  job.emergency = false;
}

function closeEditor() {
  editorVideo.pause();
  if (editorVideo.src.startsWith("blob:")) URL.revokeObjectURL(editorVideo.src);
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
      invalidateJob(activeJob);
      renderEditorCuts();
    });

    cutList.appendChild(row);
  });
}

function renderQueue() {
  const done = jobs.filter(j => j.state === "done").length;
  const failed = jobs.filter(j => j.state === "error").length;
  const processing = jobs.filter(j => j.state === "processing").length;
  const totalBytes = jobs.reduce((sum, j) => sum + j.file.size, 0);

  queueStats.textContent = jobs.length
    ? `${jobs.length} video${jobs.length === 1 ? "" : "s"} • ${formatBytes(totalBytes)} • ${done} finished${failed ? ` • ${failed} failed` : ""}`
    : "No videos yet.";

  retryBtn.hidden = failed === 0 && !jobs.some(j => j.state === "cancelled");
  clearFinishedBtn.hidden = done === 0;

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
    cancelBtn.hidden = true;
    shareAllBtn.hidden = true;
    return;
  }

  queueEl.className = "queue";

  compressAllBtn.disabled = running;
  compressAllBtn.textContent = running ? "Compressing queue…" : "Compress all";
  cancelBtn.hidden = !running;
  shareAllBtn.hidden = done === 0;

  for (const job of jobs) {
    const node = template.content.cloneNode(true);
    const article = node.querySelector(".job");
    article.dataset.id = job.id;

    node.querySelector(".job-name").textContent = job.file.name;
    node.querySelector(".job-meta").textContent =
      `${formatBytes(job.file.size)} • ${formatTime(job.duration)} • target ${targetMB} MB`;

    node.querySelector(".job-cuts").textContent = job.cuts.length
      ? `${job.cuts.length} cut${job.cuts.length === 1 ? "" : "s"} • removes ${formatTime(totalCutDuration(job.cuts))}`
      : "";

    const badges = node.querySelector(".job-badges");
    const profile = chooseProfile(job, null, !!job.emergency);
    badges.innerHTML = profile.badges.map(b => `<span class="badge ${b.kind || ""}">${b.text}</span>`).join("");

    const status = node.querySelector(".job-status");
    const progress = node.querySelector(".job-progress");
    const progressBar = progress.firstElementChild;
    const result = node.querySelector(".job-result");
    const share = node.querySelector(".share-job");
    const details = node.querySelector(".details-job");

    if (job.state === "processing") {
      const eta = estimateETA(job);
      status.className = "job-status processing";
      status.textContent = `Compressing… ${Math.round(job.progress * 100)}%${eta ? ` • ${eta} left` : ""}`;
      progress.hidden = false;
      progressBar.style.width = `${Math.min(100, Math.max(2, job.progress * 100))}%`;
    } else if (job.state === "done") {
      status.className = "job-status";
      status.textContent = job.note || "Finished";
      result.hidden = false;
      result.textContent = `${formatBytes(job.file.size)} → ${formatBytes(job.outputSize)}`;
      share.hidden = false;
    } else if (job.state === "error") {
      status.className = "job-status error";
      status.textContent = `Could not compress: ${job.error || "Unknown error"}`;
      details.hidden = !job.errorDetails;
    } else if (job.state === "cancelled") {
      status.className = "job-status cancelled";
      status.textContent = "Cancelled";
    } else {
      status.className = "job-status";
      status.textContent = "Ready";
    }

    const removeBtn = node.querySelector(".remove-job");
    removeBtn.disabled = running;
    removeBtn.addEventListener("click", () => {
      if (running) return;
      if (job.output?.url) URL.revokeObjectURL(job.output.url);
      jobs = jobs.filter(j => j.id !== job.id);
      renderQueue();
    });

    const editBtn = node.querySelector(".edit-job");
    editBtn.disabled = running || job.duration <= 0;
    editBtn.addEventListener("click", () => openEditor(job));

    const compressBtn = node.querySelector(".compress-job");
    compressBtn.disabled = running || job.state === "processing";
    compressBtn.addEventListener("click", async () => {
      if (running) return;
      running = true;
      cancelRequested = false;
      renderQueue();
      await requestWakeLock();

      try {
        if (needsTranscode(job)) await ensureEngine();
        await compressJob(job);
      } catch (error) {
        if (!cancelRequested) {
          job.state = "error";
          job.error = error?.message || String(error);
          job.errorDetails = String(error?.stack || error);
        }
      } finally {
        running = false;
        cancelRequested = false;
        currentProgressJob = null;
        await releaseWakeLock();
        renderQueue();
      }
    });

    details.addEventListener("click", () => {
      alert(job.errorDetails || job.error || "No additional details.");
    });

    share.addEventListener("click", () => shareJob(job));

    queueEl.appendChild(node);
  }
}

async function ensureEngine() {
  if (engineReady) return;

  engineStatus.textContent = "Loading compressor engine…";
  recentLogs = [];
  ffmpeg = new FFmpeg();

  ffmpeg.on("progress", ({ progress }) => {
    if (!currentProgressJob) return;

    currentProgressJob.progress = Math.max(0, Math.min(1, progress || 0));
    const row = document.querySelector(`.job[data-id="${currentProgressJob.id}"]`);

    if (row) {
      const bar = row.querySelector(".job-progress");
      const fill = bar.firstElementChild;
      const status = row.querySelector(".job-status");
      const eta = estimateETA(currentProgressJob);

      bar.hidden = false;
      fill.style.width = `${Math.max(2, currentProgressJob.progress * 100)}%`;
      status.textContent = `Compressing… ${Math.round(currentProgressJob.progress * 100)}%${eta ? ` • ${eta} left` : ""}`;
    }
  });

  ffmpeg.on("log", ({ message }) => {
    if (!message) return;
    recentLogs.push(message);
    if (recentLogs.length > 100) recentLogs.shift();
    console.log("[ffmpeg]", message);
  });

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
  engineStatus.textContent = "Compressor ready • screen will stay awake while working.";
}

async function compressJob(job, emergencyRetry = false) {
  if (cancelRequested) return;

  job.emergency = emergencyRetry;
  let shouldEmergencyRetry = false;

  const safeBytes = targetBytes();

  if (skipSmallEl.checked && job.cuts.length === 0 && job.file.size <= safeBytes) {
    const url = URL.createObjectURL(job.file);
    job.output = { blob: job.file, file: job.file, url };
    job.outputSize = job.file.size;
    job.state = "done";
    job.note = "Already under target — no re-encode needed.";
    renderQueue();
    return;
  }

  if (!engineReady) await ensureEngine();

  currentProgressJob = job;
  currentStartedAt = performance.now();
  recentLogs = [];
  job.state = "processing";
  job.progress = 0;
  job.error = "";
  job.errorDetails = "";
  job.note = "";
  if (job.output?.url) URL.revokeObjectURL(job.output.url);
  job.output = null;
  renderQueue();

  const outputName = `clipcompress-${job.id}.mp4`;
  const mountPoint = `/input-${job.id}`;
  const inputPath = `${mountPoint}/${job.file.name}`;
  let mounted = false;

  try {
    engineStatus.textContent = `Preparing ${job.file.name}…`;

    await ffmpeg.createDir(mountPoint);
    await ffmpeg.mount("WORKERFS", { files: [job.file] }, mountPoint);
    mounted = true;

    const finalDuration = Math.max(0.1, job.duration - totalCutDuration(job.cuts));
    const wantedBytes = targetBytes();
    let totalKbps = Math.floor((wantedBytes * 8) / finalDuration / 1000 * 0.92);

    const profile = chooseProfile(job, totalKbps, emergencyRetry);
    const audioKbps = keepAudioEl.checked ? profile.audioKbps : 0;
    let videoKbps = Math.max(90, totalKbps - audioKbps);

    // Speed-first: Smart/Fast/Balanced do one encode pass.
    // Best mode may retry once if the first file is over target.
    const maxAttempts = qualityMode === "quality" ? 2 : 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      if (cancelRequested) throw new Error("cancelled");

      attempts += 1;
      job.progress = 0;
      currentStartedAt = performance.now();
      engineStatus.textContent = `Compressing ${job.file.name} • ${profile.label}${maxAttempts > 1 ? ` • pass ${attempts}/${maxAttempts}` : ""}`;

      const args = buildCommand(
        job,
        inputPath,
        outputName,
        videoKbps,
        audioKbps,
        profile.height,
        profile.fps,
        keepAudioEl.checked
      );

      let exitCode;

      try {
        exitCode = await ffmpeg.exec(args);
        if (exitCode !== 0) throw buildFFmpegError(exitCode);
      } catch (firstError) {
        if (cancelRequested) throw firstError;

        // A surprising number of mobile recordings have audio-stream quirks.
        // Retry without audio automatically.
        try { await ffmpeg.deleteFile(outputName); } catch {}
        const videoOnlyArgs = buildCommand(
          job,
          inputPath,
          outputName,
          videoKbps,
          0,
          profile.height,
          profile.fps,
          false
        );

        exitCode = await ffmpeg.exec(videoOnlyArgs);
        if (exitCode !== 0) throw buildFFmpegError(exitCode);
      }

      const data = await ffmpeg.readFile(outputName);
      const outputBytes = data.byteLength;

      if (outputBytes <= wantedBytes || attempts >= maxAttempts) {
        const blob = new Blob([data.buffer], { type: "video/mp4" });
        const exportName = `${stripExtension(job.file.name)}-compressed.mp4`;
        const file = new File([blob], exportName, { type: "video/mp4" });
        const url = URL.createObjectURL(blob);

        job.output = { blob, file, url };
        job.outputSize = outputBytes;
        job.note = outputBytes <= wantedBytes
          ? `Finished • ${profile.label}`
          : `Finished • ${profile.label} • slightly over target`;
        break;
      }

      const ratio = wantedBytes / outputBytes;
      videoKbps = Math.max(80, Math.floor(videoKbps * ratio * 0.88));
      try { await ffmpeg.deleteFile(outputName); } catch {}
    }

    if (!job.output) throw new Error("No output file was created.");

    job.state = "done";
    job.progress = 1;
    engineStatus.textContent = "Compressor ready • screen will stay awake while working.";
  } catch (error) {
    const raw = `${String(error?.message || error)}\n${recentLogs.slice(-20).join("\n")}`;
    const memoryFailure = /memory|out of memory|OOM|abort\(out of memory\)|cannot enlarge memory/i.test(raw);

    if (cancelRequested || String(error?.message || error).includes("cancelled")) {
      job.state = "cancelled";
      job.error = "";
      job.errorDetails = "";
    } else if (memoryFailure && !emergencyRetry) {
      console.warn("Memory limit hit; restarting in Emergency mode.");
      job.state = "ready";
      job.progress = 0;
      job.note = "Memory limit hit — retrying in Emergency mode…";
      shouldEmergencyRetry = true;

      try { ffmpeg?.terminate(); } catch {}
      ffmpeg = null;
      engineReady = false;
      mounted = false;
    } else {
      console.error(error);
      job.state = "error";
      job.error = friendlyError(error);
      job.errorDetails = `${String(error?.message || error)}\n\nRecent FFmpeg log:\n${recentLogs.slice(-20).join("\n")}`;
    }
  } finally {
    if (ffmpeg) {
      try { await ffmpeg.deleteFile(outputName); } catch {}
      if (mounted) {
        try { await ffmpeg.unmount(mountPoint); } catch {}
      }
      try { await ffmpeg.deleteDir(mountPoint); } catch {}
    }

    currentProgressJob = null;
    renderQueue();
  }

  if (shouldEmergencyRetry && !cancelRequested) {
    engineStatus.textContent = "Memory limit hit • restarting in Emergency mode…";
    await ensureEngine();
    return await compressJob(job, true);
  }
}

function chooseProfile(job, totalKbps = null, emergencyRetry = false) {
  const kbps = totalKbps ?? Math.floor((targetBytes() * 8) / Math.max(1, job.duration) / 1000 * 0.92);
  let height, fps, audioKbps, label;
  const badges = [];

  if (qualityMode === "fast") {
    height = 480; fps = 24; audioKbps = 48; label = "Fast 480p";
    badges.push({ text: "Fast", kind: "fast" });
  } else if (qualityMode === "balanced") {
    height = 720; fps = 30; audioKbps = 64; label = "Balanced 720p";
    badges.push({ text: "Balanced" });
  } else if (qualityMode === "quality") {
    height = 1080; fps = 30; audioKbps = 80; label = "Best quality";
    badges.push({ text: "Best quality" });
  } else {
    if (kbps < 260) {
      height = 360; fps = 18; audioKbps = 32; label = "Smart 360p";
    } else if (kbps < 520) {
      height = 480; fps = 24; audioKbps = 40; label = "Smart 480p";
    } else if (kbps < 950) {
      height = 540; fps = 24; audioKbps = 48; label = "Smart 540p";
    } else {
      height = 720; fps = 30; audioKbps = 64; label = "Smart 720p";
    }
    badges.push({ text: "Smart", kind: "fast" });
  }

  const compressionRatio = targetBytes() / Math.max(1, job.file.size);
  const shouldUseLowMemory =
    lowMemoryEl.checked &&
    (
      job.file.size >= LARGE_FILE_BYTES ||
      job.duration >= LONG_VIDEO_SECONDS ||
      compressionRatio <= 0.15
    );

  if (emergencyRetry) {
    height = 360;
    fps = 15;
    audioKbps = Math.min(audioKbps, 32);
    label = "Emergency 360p";
    badges.push({ text: "Emergency memory mode", kind: "warn" });
  } else if (shouldUseLowMemory) {
    if (compressionRatio <= 0.10 || job.file.size >= 220 * 1_000_000 || job.duration >= 120) {
      height = Math.min(height, 360);
      fps = Math.min(fps, 18);
      audioKbps = Math.min(audioKbps, 40);
      label = label.replace(/\d+p/, "360p") + " • low-memory";
    } else {
      height = Math.min(height, 480);
      fps = Math.min(fps, 20);
      audioKbps = Math.min(audioKbps, 48);
      label = label.replace(/\d+p/, "480p") + " • low-memory";
    }
    badges.push({ text: "Large/long-file mode", kind: "warn" });
  }

  if (job.file.size <= targetBytes() && job.cuts.length === 0 && skipSmallEl.checked) {
    badges.push({ text: "Already under target", kind: "good" });
  }

  if (job.cuts.length) {
    badges.push({ text: `${job.cuts.length} cut${job.cuts.length === 1 ? "" : "s"}` });
  }

  if (!keepAudioEl.checked) {
    badges.push({ text: "Muted" });
  }

  return { height, fps, audioKbps, label, badges };
}

function buildCommand(job, inputName, outputName, videoKbps, audioKbps, maxHeight, fps, includeAudio) {
  const scale = `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease:flags=fast_bilinear`;
  const cuts = mergeCuts(job.cuts, job.duration);

  const commonInput = [
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", inputName
  ];

  if (!cuts.length) {
    const args = [
      ...commonInput,
      "-map", "0:v:0"
    ];

    if (includeAudio) args.push("-map", "0:a:0?");

    args.push(
      "-vf", `fps=${fps},${scale}`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-threads", "1",
      "-tune", "fastdecode",
      "-b:v", `${videoKbps}k`,
      "-maxrate", `${Math.floor(videoKbps * 1.10)}k`,
      "-bufsize", `${Math.floor(videoKbps * 1.8)}k`,
      "-pix_fmt", "yuv420p",
      "-map_metadata", "-1",
      "-sn",
      "-dn"
    );

    if (includeAudio) args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
    else args.push("-an");

    args.push("-movflags", "+faststart", "-y", outputName);
    return args;
  }

  const expr = cuts
    .map(c => `between(t\\,${c.start.toFixed(3)}\\,${c.end.toFixed(3)})`)
    .join("+");

  const keep = `not(${expr})`;
  let filter = `[0:v]select='${keep}',setpts=N/FRAME_RATE/TB,fps=${fps},${scale}[v]`;

  if (includeAudio) {
    filter += `;[0:a]aselect='${keep}',asetpts=N/SR/TB[a]`;
  }

  const args = [
    ...commonInput,
    "-filter_complex", filter,
    "-map", "[v]"
  ];

  if (includeAudio) args.push("-map", "[a]");

  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-threads", "1",
    "-tune", "fastdecode",
    "-b:v", `${videoKbps}k`,
    "-maxrate", `${Math.floor(videoKbps * 1.10)}k`,
    "-bufsize", `${Math.floor(videoKbps * 1.8)}k`,
    "-pix_fmt", "yuv420p",
    "-map_metadata", "-1"
  );

  if (includeAudio) args.push("-c:a", "aac", "-b:a", `${audioKbps}k`);
  else args.push("-an");

  args.push("-movflags", "+faststart", "-y", outputName);
  return args;
}

function buildFFmpegError(exitCode) {
  const useful = recentLogs
    .slice()
    .reverse()
    .find(line =>
      /error|invalid|failed|unsupported|memory|moov|codec|could not|cannot/i.test(line)
    );

  return new Error(useful ? `${useful}` : `ffmpeg exited with code ${exitCode}`);
}

function friendlyError(error) {
  const msg = String(error?.message || error);

  if (/memory|abort\(out of memory\)|OOM/i.test(msg)) {
    return "iPhone memory limit hit. Emergency mode was already tried; use Fast mode, mute audio, or cut the video into shorter sections.";
  }
  if (/codec|unsupported|decoder/i.test(msg)) {
    return "This recording uses a codec the browser compressor could not decode.";
  }
  if (/moov|invalid data|corrupt/i.test(msg)) {
    return "The recording appears damaged or incomplete.";
  }
  if (/ffmpeg exited with code/i.test(msg)) {
    return "FFmpeg could not process this file. Tap Error details.";
  }
  return msg.length > 150 ? "Compression failed. Tap Error details." : msg;
}

function targetBytes() {
  return Math.max(900_000, targetMB * 1_000_000 - 180_000);
}

function estimateETA(job) {
  if (!job || job.progress < 0.03 || !currentStartedAt) return "";

  const elapsedMs = performance.now() - currentStartedAt;
  const totalMs = elapsedMs / job.progress;
  const remainingMs = Math.max(0, totalMs - elapsedMs);

  if (!Number.isFinite(remainingMs) || remainingMs > 24 * 60 * 60 * 1000) return "";
  return humanDuration(remainingMs / 1000);
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;

  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function shareJob(job) {
  if (!job.output?.file) return;

  const file = job.output.file;
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: file.name }).catch(() => {});
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

  const duration = activeJob?.duration ||
    Math.max(...cuts.map(c => c.end), 0);

  return mergeCuts(cuts, duration)
    .reduce((sum, c) => sum + (c.end - c.start), 0);
}

function getDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
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
