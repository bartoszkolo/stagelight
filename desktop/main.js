// Stagelight desktop: a thin Electron shell around the local Python server.
//
// The installer stays small (~150 MB): on first launch we use the bundled `uv` to fetch a private
// Python and the AI packages into the user's app-data folder, then run the same FastAPI server
// as the web version and show it in a window. Electron's own Node doubles as the JavaScript
// runtime yt-dlp needs for YouTube.
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const isWin = process.platform === "win32";
const HOME = app.getPath("userData");           // e.g. %APPDATA%\Stagelight, ~/Library/Application Support/Stagelight
const ENGINE = path.join(HOME, "engine");
const VENV = path.join(ENGINE, "venv");
const PY = isWin ? path.join(VENV, "Scripts", "python.exe") : path.join(VENV, "bin", "python");
const MARKER = path.join(ENGINE, "installed.json");
const LOG = path.join(HOME, "stagelight.log");

// Packaged: the Python app and uv live in resources/. Dev (`npm start`): the repo root and uv on PATH.
const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, "app") : path.join(__dirname, "..");
const UV = app.isPackaged
  ? path.join(process.resourcesPath, "uv", isWin ? "uv.exe" : "uv")
  : process.env.STAGELIGHT_UV || "uv";

let setupWin = null, mainWin = null, server = null, quitting = false;
// Packaged builds take the icon from the executable; in dev (and on Linux) the window needs it explicitly.
const ICON = path.join(__dirname, "build", isWin ? "icon.ico" : "icon.png");

if (!app.requestSingleInstanceLock()) app.quit();

// YouTube treats an "Electron/…" user agent as a likely bot and blurs the embedded video behind a
// "sign in to confirm you're not a bot" prompt (and Google sign-in is blocked inside Electron anyway).
// Present the plain Chrome user agent this Electron version is built on.
app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/\S+/i, "").replace(/\sstagelight\/\S+/i, "");
app.on("second-instance", () => { const w = mainWin || setupWin; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });

function log(line) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  setupWin?.webContents.send("log", line);
}
const step = (id, state, detail = "") => setupWin?.webContents.send("step", { id, state, detail });

// ------------------------------------------------------------------ first-run install

function requirementsHash() {
  const h = crypto.createHash("sha256");
  for (const f of ["requirements.txt", "requirements-nodeps.txt"]) h.update(fs.readFileSync(path.join(APP_DIR, f)));
  return h.digest("hex").slice(0, 16);
}

function isInstalled() {
  try { return fs.existsSync(PY) && JSON.parse(fs.readFileSync(MARKER, "utf8")).requirements === requirementsHash(); }
  catch { return false; }
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${path.basename(cmd)} ${args.join(" ")}`);
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    const onData = (d) => d.toString().split(/\r?\n|\r/).filter(Boolean).forEach(log);
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`))));
  });
}

// uv unpacks Python into engine/python/cpython-3.12.<patch>-<platform>/; take the newest 3.12.
function findManagedPython() {
  const root = path.join(ENGINE, "python");
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root)
    .filter((d) => /^cpython-3\.12\.\d+/.test(d))
    .sort((a, b) => Number(b.split(".")[2].split("-")[0]) - Number(a.split(".")[2].split("-")[0]));
  for (const d of dirs) {
    const exe = isWin ? path.join(root, d, "python.exe") : path.join(root, d, "bin", "python3");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function hasNvidia() {
  return new Promise((resolve) => execFile("nvidia-smi", ["-L"], { windowsHide: true }, (err) => resolve(!err)));
}

async function install() {
  fs.mkdirSync(ENGINE, { recursive: true });
  const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(ENGINE, "python"), UV_NO_PROGRESS: "1" };

  step("python", "active");
  // On some Windows machines uv downloads Python fine but then fails to create its "3.12" alias
  // link, and its own interpreter lookup trips over that. So: tolerate the install error, find
  // the interpreter it unpacked ourselves, and hand `uv venv` the exact path.
  await run(UV, ["python", "install", "3.12"], uvEnv).catch((e) => log(`(continuing) ${e.message}`));
  const interpreter = findManagedPython();
  if (!interpreter) throw new Error("Couldn't download Python. Check your internet connection and try again.");
  log(`using ${interpreter}`);
  if (fs.existsSync(VENV)) fs.rmSync(VENV, { recursive: true, force: true });
  await run(UV, ["venv", "--python", interpreter, VENV], uvEnv);
  step("python", "done");

  step("packages", "active", "about 700 MB, this is the long part");
  const args = ["pip", "install", "--python", PY, "-r", path.join(APP_DIR, "requirements.txt"),
                "--index-strategy", "unsafe-best-match"];
  const gpu = process.platform !== "darwin" && (await hasNvidia());
  if (process.platform !== "darwin" && !gpu) args.push("--extra-index-url", "https://download.pytorch.org/whl/cpu");
  await run(UV, args, uvEnv);
  // audio-separator without its own dependency list: it would pull in diffq, which can't be
  // installed on macOS (see requirements.txt).
  await run(UV, ["pip", "install", "--python", PY, "--no-deps", "-r", path.join(APP_DIR, "requirements-nodeps.txt")], uvEnv);
  step("packages", "done");

  fs.writeFileSync(MARKER, JSON.stringify({ requirements: requirementsHash(), date: new Date().toISOString(), gpu }));
}

// ------------------------------------------------------------------ server

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

function waitForServer(port, timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/models", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(); else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (!server || server.exitCode !== null) return reject(new Error("The Stagelight engine stopped while starting. See the log."));
      if (Date.now() > until) return reject(new Error("The Stagelight engine took too long to start."));
      setTimeout(tryOnce, 500);
    };
    tryOnce();
  });
}

async function startServer() {
  step("start", "active", "loading the AI models");
  const port = await freePort();
  server = spawn(PY, ["-m", "uvicorn", "server:app", "--app-dir", APP_DIR, "--host", "127.0.0.1", "--port", String(port),
                      "--no-access-log"], {
    cwd: APP_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      STAGELIGHT_DATA: path.join(HOME, "data"),
      STAGELIGHT_MODELS: path.join(HOME, "models"),
      STAGELIGHT_BIN: path.join(HOME, "bin"),
      // yt-dlp runs this as `node --version` / `node script.js`; with this flag Electron behaves as Node.
      STAGELIGHT_NODE: process.execPath,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  const onData = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(log);
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
  server.on("exit", (code) => {
    log(`engine exited with code ${code}`);
    if (!quitting && mainWin) {
      dialog.showErrorBox("Stagelight stopped", `The Stagelight engine stopped unexpectedly (code ${code}).\nLog: ${LOG}`);
      app.quit();
    }
  });
  await waitForServer(port);
  step("start", "done");
  return port;
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  // On Windows the server's children (ffmpeg, separation) must go too.
  if (isWin) execFile("taskkill", ["/pid", String(server.pid), "/t", "/f"], { windowsHide: true }, () => {});
  else server.kill("SIGTERM");
}

// ------------------------------------------------------------------ windows

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 560, height: 520, resizable: false, backgroundColor: "#07060d", title: "Stagelight",
    autoHideMenuBar: true, show: false, icon: ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  setupWin.loadFile(path.join(__dirname, "setup.html"));
  setupWin.once("ready-to-show", () => setupWin.show());
  setupWin.on("closed", () => { setupWin = null; if (!mainWin) app.quit(); });
  return new Promise((resolve) => setupWin.webContents.once("did-finish-load", resolve));
}

let serverPort = null;

// Same page, in the person's default browser (signed in to YouTube there, so music videos play).
function openInBrowser(pathAndQuery = "/") {
  if (!serverPort) return;
  const p = pathAndQuery.startsWith("/") ? pathAndQuery : "/";
  shell.openExternal(`http://127.0.0.1:${serverPort}${p}`);
}
ipcMain.on("open-in-browser", (_e, p) => openInBrowser(p));

function createMainWindow(port) {
  serverPort = port;
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 520, backgroundColor: "#07060d", title: "Stagelight",
    autoHideMenuBar: true, show: false, icon: ICON,
    webPreferences: { preload: path.join(__dirname, "preload-main.js") },
  });
  mainWin.loadURL(`http://127.0.0.1:${port}/`);
  // Links to GitHub, LRCLIB etc. open in the normal browser, not inside the app.
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  mainWin.once("ready-to-show", () => { mainWin.show(); setupWin?.close(); });
  mainWin.on("closed", () => { mainWin = null; app.quit(); });
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Open in Your Browser", click: () => {
        // Keep the current song: pass the window's path and query along.
        const u = mainWin ? new URL(mainWin.webContents.getURL()) : null;
        openInBrowser(u ? u.pathname + u.search : "/");
      } },
      { label: "Open Songs Folder", click: () => shell.openPath(path.join(HOME, "data")) },
      { label: "Show Log", click: () => shell.openPath(LOG) },
      { type: "separator" },
      { label: "Reinstall AI Engine…", click: reinstall },
      { type: "separator" },
      process.platform === "darwin" ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "toggleDevTools" }] },
    { role: "help", submenu: [{ label: "Stagelight on GitHub", click: () => shell.openExternal("https://github.com/bartoszkolo/stagelight") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function reinstall() {
  const { response } = await dialog.showMessageBox({
    type: "question", buttons: ["Reinstall", "Cancel"], defaultId: 1,
    message: "Reinstall the AI engine?", detail: "Your songs are kept. Stagelight restarts and downloads the engine again.",
  });
  if (response !== 0) return;
  try { fs.rmSync(MARKER, { force: true }); } catch {}
  app.relaunch();
  app.quit();
}

// ------------------------------------------------------------------ lifecycle

async function boot() {
  if (!setupWin) await createSetupWindow();
  try {
    // PyTorch no longer ships builds for Intel Macs, so the AI engine can't be installed there.
    if (process.platform === "darwin" && process.arch === "x64" && !app.runningUnderARM64Translation) {
      throw new Error("Stagelight needs a Mac with Apple Silicon (M1 or newer). Intel Macs aren't supported "
        + "yet, because the AI library it uses no longer has builds for them.");
    }
    if (isInstalled()) {
      step("python", "done"); step("packages", "done");
    } else {
      setupWin.webContents.send("first-run");
      await install();
    }
    const port = await startServer();
    createMainWindow(port);
  } catch (err) {
    log(`ERROR: ${err.stack || err}`);
    setupWin?.webContents.send("failed", { message: err.message, log: LOG });
  }
}

// "Try again" on the setup screen reruns everything in the same window.
ipcMain.on("retry", () => {
  if (server) { quitting = true; stopServer(); server = null; quitting = false; }
  setupWin?.webContents.send("reset");
  boot();
});
ipcMain.on("open-log", () => shell.openPath(LOG));

app.whenReady().then(() => {
  fs.mkdirSync(HOME, { recursive: true });
  buildMenu();
  boot();
});
app.on("before-quit", () => { quitting = true; stopServer(); });
app.on("window-all-closed", () => app.quit());
