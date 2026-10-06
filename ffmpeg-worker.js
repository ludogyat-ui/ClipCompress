const CORE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js";
const FFMessageType = {
  LOAD: "LOAD", EXEC: "EXEC", FFPROBE: "FFPROBE", WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE", DELETE_FILE: "DELETE_FILE", RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR", LIST_DIR: "LIST_DIR", DELETE_DIR: "DELETE_DIR",
  ERROR: "ERROR", DOWNLOAD: "DOWNLOAD", PROGRESS: "PROGRESS", LOG: "LOG",
  MOUNT: "MOUNT", UNMOUNT: "UNMOUNT"
};

let ffmpeg;

async function load({ coreURL: requestedCoreURL, wasmURL: requestedWasmURL, workerURL: requestedWorkerURL }) {
  const first = !ffmpeg;
  let coreURL = requestedCoreURL || CORE_URL;

  try {
    importScripts(coreURL);
  } catch {
    if (!coreURL || coreURL === CORE_URL) coreURL = CORE_URL.replace("/umd/", "/esm/");
    self.createFFmpegCore = (await import(coreURL)).default;
    if (!self.createFFmpegCore) throw new Error("failed to import ffmpeg-core.js");
  }

  const wasmURL = requestedWasmURL || coreURL.replace(/.js$/g, ".wasm");
  const workerURL = requestedWorkerURL || coreURL.replace(/.js$/g, ".worker.js");

  ffmpeg = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`
  });

  ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
  ffmpeg.setProgress((data) => self.postMessage({ type: FFMessageType.PROGRESS, data }));
  return first;
}

function exec({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}
function ffprobe({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}
const writeFile = ({ path, data }) => (ffmpeg.FS.writeFile(path, data), true);
const readFile = ({ path, encoding }) => ffmpeg.FS.readFile(path, { encoding });
const deleteFile = ({ path }) => (ffmpeg.FS.unlink(path), true);
const rename = ({ oldPath, newPath }) => (ffmpeg.FS.rename(oldPath, newPath), true);
const createDir = ({ path }) => (ffmpeg.FS.mkdir(path), true);
const listDir = ({ path }) => ffmpeg.FS.readdir(path).map(name => {
  const stat = ffmpeg.FS.stat(`${path}/${name}`);
  return { name, isDir: ffmpeg.FS.isDir(stat.mode) };
});
const deleteDir = ({ path }) => (ffmpeg.FS.rmdir(path), true);
const mount = ({ fsType, options, mountPoint }) => {
  const fs = ffmpeg.FS.filesystems[fsType];
  if (!fs) return false;
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
};
const unmount = ({ mountPoint }) => (ffmpeg.FS.unmount(mountPoint), true);

self.onmessage = async ({ data: { id, type, data: input } }) => {
  const transfer = [];
  let data;
  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) throw new Error("ffmpeg is not loaded");
    switch (type) {
      case FFMessageType.LOAD: data = await load(input); break;
      case FFMessageType.EXEC: data = exec(input); break;
      case FFMessageType.FFPROBE: data = ffprobe(input); break;
      case FFMessageType.WRITE_FILE: data = writeFile(input); break;
      case FFMessageType.READ_FILE: data = readFile(input); break;
      case FFMessageType.DELETE_FILE: data = deleteFile(input); break;
      case FFMessageType.RENAME: data = rename(input); break;
      case FFMessageType.CREATE_DIR: data = createDir(input); break;
      case FFMessageType.LIST_DIR: data = listDir(input); break;
      case FFMessageType.DELETE_DIR: data = deleteDir(input); break;
      case FFMessageType.MOUNT: data = mount(input); break;
      case FFMessageType.UNMOUNT: data = unmount(input); break;
      default: throw new Error("unknown message type");
    }
  } catch (error) {
    self.postMessage({ id, type: FFMessageType.ERROR, data: String(error) });
    return;
  }

  if (data instanceof Uint8Array) transfer.push(data.buffer);
  self.postMessage({ id, type, data }, transfer);
};