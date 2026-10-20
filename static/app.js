const $ = (id) => document.getElementById(id);
// Set by the website's /demo page: the player runs as plain static files, with no server behind it.
const STATIC = !!window.STAGELIGHT_STATIC;
const audio = $("audio");
const vocals = $("vocals"); // separated vocal stem, mixed back in at the chosen level
const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

// ============================================================ settings

const DEFAULTS = {
  size: 100, font: "modern", anim: "wipe", color: "#ffd447", lines: "3", position: "bottom",
  ball: true, countdown: true, dim: 15, blur: false, music: 100, vocal: 0, model: "karaoke", video: true,
  difficulty: "normal", micDelay: 120,
};
const FONTS = {
  modern: "Outfit, system-ui, sans-serif",
  rounded: "'Baloo 2', Outfit, sans-serif",
  poster: "'Bebas Neue', Outfit, sans-serif",
  classic: "'Playfair Display', Georgia, serif",
};
const STORE = "stagelight.settings";

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE)) || {}); } catch {}

function saveSettings() {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {}
}

let saveSettingsTimer;
function set(key, value) {
  settings[key] = value;
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(saveSettings, 300);
  // Volumes change on every slider tick: keep that path cheap and don't touch the lyric DOM.
  if (key === "music" || key === "vocal") return applyAudio();
  applySettings();
  if (key === "video" && song) {
    setupVideo(song.id);
    if (value && !audio.paused) videoPlay();
  }
}

function applyAudio() {
  audio.volume = settings.music / 100;
  vocals.volume = settings.vocal;
  setRange("setMusic", settings.music, `${settings.music}%`, "musicVal");
  setRange("vocVol", settings.vocal, `${Math.round(settings.vocal * 100)}%`, "vocVal");
}

function applySettings() {
  const stage = $("stage"), root = document.documentElement.style;
  root.setProperty("--scale", settings.size / 100);
  root.setProperty("--hl", settings.color);
  root.setProperty("--lyric-font", FONTS[settings.font] || FONTS.modern);
  root.setProperty("--dim", settings.dim / 100);
  stage.className = [
    `anim-${settings.anim}`, `font-${settings.font}`, `lines-${settings.lines}`,
    settings.position === "center" ? "center" : "", settings.blur ? "blur" : "",
  ].join(" ");
  applyAudio();

  // Reflect values in the controls.
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === "checkbox") el.checked = !!settings[key];
    else el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === String(settings[key])));
  });
  setRange("setSize", settings.size, `${settings.size}%`, "sizeVal");
  setRange("setDim", settings.dim, `${settings.dim}%`, "dimVal");
  setRange("setMicDelay", settings.micDelay, `${settings.micDelay} ms`, "micDelayVal");
  if ($("modelSelect").options.length) $("modelSelect").value = settings.model;
  renderModels();
  requestAnimationFrame(measureLine); // size/font/layout changes move the words under the ball
  if ($("previewStage")) renderPreview();
}

function setRange(id, value, label, outId) {
  const el = $(id);
  el.value = value;
  paintRange(el);
  if (outId) $(outId).textContent = label;
}
function paintRange(el) {
  el.style.setProperty("--fill", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
}

document.querySelectorAll(".seg[data-setting], .swatches[data-setting]").forEach((group) => {
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) set(group.dataset.setting, b.dataset.value);
  });
});
document.querySelectorAll("input[type=checkbox][data-setting]").forEach((el) => {
  el.addEventListener("change", () => set(el.dataset.setting, el.checked));
});
$("setSize").addEventListener("input", (e) => set("size", Number(e.target.value)));
$("setDim").addEventListener("input", (e) => set("dim", Number(e.target.value)));
$("setMusic").addEventListener("input", (e) => set("music", Number(e.target.value)));
$("setMicDelay").addEventListener("input", (e) => set("micDelay", Number(e.target.value)));
$("vocVol").addEventListener("input", (e) => { set("vocal", Number(e.target.value)); syncVocals(true); });

// Seek bar: while dragging only preview the time; seek once on release (each seek also moves the video).
let scrubbing = false;
const seekTarget = () => (Number($("seek").value) / 1000) * audio.duration;
$("seek").addEventListener("pointerdown", () => { scrubbing = true; });
$("seek").addEventListener("input", (e) => {
  paintRange(e.target);
  if (isFinite(audio.duration)) $("time").textContent = fmt(seekTarget());
  if (!scrubbing) commitSeek(); // keyboard on the slider
});
$("seek").addEventListener("change", () => { commitSeek(); scrubbing = false; $("seek").blur(); });
function commitSeek() { if (isFinite(audio.duration)) audio.currentTime = seekTarget(); }
$("resetSettings").onclick = () => { settings = { ...DEFAULTS, model: settings.model }; saveSettings(); applySettings(); };
$("modelSelect").addEventListener("change", (e) => set("model", e.target.value));

const player = $("player");
// The settings panel covers the whole window. It lives in <body>, except during real fullscreen,
// where only the fullscreen element is visible, so it moves into the player (listeners come along).
const settingsOpen = () => $("settings").classList.contains("open");
function hostSettings() {
  const drawer = $("settings");
  const host = document.fullscreenElement === player ? player : document.body;
  if (drawer.parentElement !== host) host.append(drawer);
}
const openSettings = (open = !settingsOpen()) => {
  const drawer = $("settings");
  if (open) { hostSettings(); renderPreview(); }
  drawer.classList.toggle("open", open);
  player.classList.toggle("settings-open", open);
  drawer.inert = !open; // keep Tab out of the panel while it's closed
  if (open) { player.classList.remove("idle"); $("closeSettings").focus(); }
  else if (drawer.contains(document.activeElement) || document.activeElement === document.body) {
    ($("playerView").hidden ? $("homeSettings") : $("openSettings")).focus();
  }
};
$("settings").inert = true;
$("openSettings").onclick = () => openSettings();
$("homeSettings").onclick = () => openSettings(true);
$("closeSettings").onclick = () => openSettings(false);

// Live preview at the top of the settings: a sample line in the chosen font, size, colour and
// highlight style, frozen mid-line (two words sung, one being sung), with the ball above it.
const PREVIEW_WORDS = ["Sing", "along", "with", "the", "stage", "lights"];
function renderPreview() {
  const stage = $("previewStage"), cur = $("previewCur");
  stage.className = `preview-stage anim-${settings.anim} font-${settings.font} lines-${settings.lines}`;
  cur.replaceChildren();
  PREVIEW_WORDS.forEach((w, i) => {
    const s = document.createElement("span");
    s.className = "w" + (i < 2 ? " sung" : i === 2 ? " active" : "");
    s.style.setProperty("--p", i < 2 ? 1 : i === 2 ? 0.55 : 0);
    s.textContent = w;
    cur.append(s, i < PREVIEW_WORDS.length - 1 ? " " : "");
  });
  let ball = $("previewBall");
  if (!ball) { ball = document.createElement("i"); ball.id = "previewBall"; }
  stage.append(ball);
  ball.style.display = settings.ball ? "" : "none";
  requestAnimationFrame(() => { // place it over the word being sung, once fonts have laid out
    const w = cur.querySelectorAll(".w")[2];
    if (!w) return;
    const fs = parseFloat(getComputedStyle(cur).fontSize);
    ball.style.fontSize = `${fs}px`; // the ball is sized in em, like the real one over the lyrics
    const x = cur.offsetLeft + w.offsetLeft + w.offsetWidth / 2;
    ball.style.transform = `translate(${x}px, ${cur.offsetTop + w.offsetTop - fs * 0.62}px)`;
  });
}

// ============================================================ separation models

let models = [];
async function loadModels() {
  const data = STATIC
    ? { default: "karaoke", models: [{ key: "karaoke", name: "Karaoke", desc: "Removes the lead vocal, keeps backing vocals.", speed: "Fast" }] }
    : await (await fetch("/api/models")).json();
  models = data.models;
  if (!models.some((m) => m.key === settings.model)) settings.model = data.default;
  $("modelSelect").replaceChildren(...models.map((m) => new Option(`${m.name} · ${m.speed.toLowerCase()}`, m.key)));
  $("modelSelect").value = settings.model;
  renderModels();
}
const modelName = (key) => models.find((m) => m.key === key)?.name || key;

function renderModels() {
  const list = $("modelList");
  if (!models.length) return;
  list.replaceChildren(...models.map((m) => {
    const el = document.createElement("div");
    el.className = `model${m.key === settings.model ? " on" : ""}`;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.innerHTML = `<span class="radio"></span><span class="name"></span><span class="speed ${m.speed.toLowerCase()}"></span>
      <span class="desc"></span><span class="act"></span>`;
    el.querySelector(".name").textContent = m.name;
    el.querySelector(".speed").textContent = m.speed;
    el.querySelector(".desc").textContent = m.desc;
    const act = el.querySelector(".act");
    if (song) {
      if (m.key === currentModel) {
        act.innerHTML = `<span class="playing">● Playing on this song</span>`;
      } else if (song.stems.includes(m.key)) {
        const b = button("Switch to this", "btn ghost", () => switchStems(m.key));
        act.append(b, "ready, instant");
      } else {
        act.append(button("Process this song", "btn ghost", () => start(song.id, m.key)));
      }
    }
    el.onclick = () => set("model", m.key);
    return el;
  }));
}
function button(label, cls, onclick) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

// ============================================================ views & jobs

function show(view) {
  if (settingsOpen()) openSettings(false);
  for (const v of ["home", "processing", "playerView"]) $(v).hidden = v !== view;
  document.body.classList.toggle("singing", view === "playerView");
  if (view !== "playerView") { audio.pause(); exitFullscreen(); }
  window.scrollTo(0, 0);
}
const setArt = (id) => document.documentElement.style.setProperty("--art", id ? `url(${thumb(id)})` : "none");

// One box for both: a YouTube link (or bare video id) is processed, anything else is searched.
const looksLikeLink = (s) => /youtu\.?be|^\s*[A-Za-z0-9_-]{11}\s*$/i.test(s);
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("url").value.trim();
  if (looksLikeLink(q)) start(q, settings.model);
  else searchSongs(q);
});
$("url").addEventListener("input", () => {
  $("go").textContent = looksLikeLink($("url").value) ? "Make it karaoke" : "Search";
});

let pollToken = 0;
let lastRequest = null; // for "Try again"
let procJob = null;     // the song on the processing screen, for "Cancel"
async function start(url, model, { push = true, title = null } = {}) {
  const token = ++pollToken;
  lastRequest = { url, model };
  $("formError").hidden = true;
  const submit = $("form").querySelector("button");
  submit.disabled = true;
  try {
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, model, title }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Something went wrong");
    const { id } = await r.json();
    const target = `?v=${id}&m=${model}`;
    if (push && location.search !== target) history.pushState(null, "", target);
    else history.replaceState(null, "", target);
    submit.disabled = false;
    await poll(id, model, token);
  } catch (err) {
    submit.disabled = false;
    if (token !== pollToken) return;
    if (!$("processing").hidden) showProcError(err.message);
    else { show("home"); $("formError").textContent = err.message; $("formError").hidden = false; }
  }
}
$("url").addEventListener("input", () => { $("formError").hidden = true; });

function showProcError(message) {
  $("procError").replaceChildren(message, document.createElement("br"),
    button("Try again", "btn ghost small", () => start(lastRequest.url, lastRequest.model, { push: false })));
  $("procError").hidden = false;
  $("barFill").classList.remove("indeterminate");
  const active = document.querySelector("#steps li.active");
  active?.classList.replace("active", "failed");
  document.title = "Stagelight Karaoke";
}

const STEP_OF = { starting: "download", download: "download", separate: "separate", encode: "separate", lyrics: "lyrics", transcribe: "lyrics", align: "align" };
const ORDER = ["download", "separate", "lyrics", "align"];

async function poll(id, model, token) {
  let first = true, failures = 0;
  for (;;) {
    if (token !== pollToken) return; // user started something else
    let job;
    try {
      const r = await fetch(`/api/jobs/${id}/${model}`);
      if (r.status === 404) { // server restarted and forgot the job: ask again
        await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: id, model }) });
        continue;
      }
      job = await r.json();
      failures = 0;
    } catch {
      if (++failures > 10) throw new Error("Lost connection to the Stagelight server. Is it still running?");
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (token !== pollToken) return;
    if (job.stage === "done") { document.title = "Stagelight Karaoke"; return load(job.result, model); }
    if (job.stage === "cancelled") { goHome(); return toast("Processing cancelled."); }
    if (job.stage === "error") throw new Error(job.error);
    procJob = { id, model };
    if (first) {
      first = false;
      show("processing");
      setArt(id);
      $("procThumb").src = thumb(id);
      $("procError").hidden = true;
      $("procTitle").textContent = "Fetching video…";
    }
    renderProgress(job, model);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function renderProgress(job, model) {
  if (job.title) $("procTitle").textContent = job.title;
  const step = STEP_OF[job.stage];
  const idx = ORDER.indexOf(step);
  document.querySelectorAll("#steps li").forEach((li, i) => {
    li.classList.remove("failed");
    li.classList.toggle("done", idx > i);
    li.classList.toggle("active", idx === i);
    li.querySelector("small").textContent = "";
  });
  $("procError").hidden = true;
  const p = job.progress;
  // Visible in the browser tab while you do something else during the wait.
  document.title = `${p != null && step === "separate" ? Math.round(p * 100) + "% · " : ""}${
    step ? $(`steps`).querySelector(`[data-step="${step}"] span`).textContent : "Waiting"} · Stagelight`;
  const fill = $("barFill");
  fill.classList.toggle("indeterminate", p == null);
  fill.style.width = `${(p || 0) * 100}%`;

  let note = "";
  $("procStop").disabled = !!job.cancel;
  if (job.cancel) note = "Cancelling…";
  else if (job.stage === "queued") note = job.queuePos ? `Waiting for ${job.queuePos} other song${job.queuePos > 1 ? "s" : ""}…` : "Starting…";
  else if (step === "separate") {
    note = `${modelName(model)} model`;
    if (job.stage === "encode") note = "Saving the instrumental…";
    else if (p != null) {
      const li = document.querySelector('#steps li[data-step="separate"] small');
      li.textContent = `${Math.round(p * 100)}%`;
      const elapsed = job.now - job.stageStarted;
      if (p > 0.04) note += ` · about ${fmtLeft((elapsed / p) * (1 - p))} left`;
    } else note += " · loading model";
  } else if (job.stage === "download" && p != null && p < 1) {
    document.querySelector('#steps li[data-step="download"] small').textContent = `${Math.round(p * 100)}%`;
  } else if (job.stage === "transcribe") note = "No lyrics online, listening for the words with Whisper…";
  $("procNote").textContent = note;
}
const fmtLeft = (s) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`);

// The job keeps running on the server; it shows up in the library when it's ready.
$("procCancel").onclick = $("procClose").onclick = () => { pollToken++; goHome(); };
// Picked the wrong song: stop it on the server (it stops within a second or two) and go back.
$("procStop").onclick = async () => {
  const job = procJob;
  pollToken++;
  goHome();
  if (!job) return;
  await fetch(`/api/jobs/${job.id}/${job.model}`, { method: "DELETE" }).catch(() => {});
  toast("Processing cancelled.");
  refreshQueue();
};
$("back").onclick = () => goHome();
function goHome({ push = true } = {}) {
  if (push && location.search) history.pushState(null, "", "/");
  pollToken++;
  song = null;
  setArt(null);
  document.title = "Stagelight Karaoke";
  show("home");
  loadLibrary();
}
// Browser back/forward moves between the library and songs instead of leaving the app.
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  if (q.get("song")) openBundled(q.get("song"), { push: false });
  else if (q.get("v")) start(q.get("v"), q.get("m") || settings.model, { push: false });
  else goHome({ push: false });
});

// ============================================================ library

let libraryItems = [];
async function loadLibrary() {
  if (STATIC) return;
  try { libraryItems = await (await fetch("/api/library")).json(); } catch { return; }
  $("library").hidden = !libraryItems.length;
  $("libCount").textContent = libraryItems.length ? `· ${libraryItems.length}` : "";
  renderLibrary();
}

// Case- and accent-insensitive: "beyonce" finds "Beyoncé", every word must match title or artist.
const fold = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function renderLibrary() {
  const query = $("libSearch").value.trim();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = libraryItems.filter((it) => words.every((w) => fold(`${it.title} ${it.artist}`).includes(w)));
  $("libEmpty").hidden = !(query && !shown.length);
  $("libEmpty").querySelector("span").textContent = query;
  $("libGrid").replaceChildren(...shown.map((it) => {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `<div class="thumb"></div><div class="meta"><div class="t"></div><div class="a"></div><div class="tags"></div></div>`;
    const th = card.querySelector(".thumb");
    if (it.bundled) {
      // Built-in songs have no YouTube video: a stage-light card with the title instead.
      th.classList.add("bundled");
      th.textContent = it.title;
    } else th.style.backgroundImage = `url(${thumb(it.id)})`;
    card.querySelector(".t").append(...highlight(it.title, words));
    card.querySelector(".a").append(...highlight(it.artist, words));
    card.querySelector(".tags").append(...(it.bundled ? ["Built-in · ready to sing"] : it.stems.map(modelName)).map((label) => {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = label;
      return t;
    }));
    card.onclick = () => it.bundled ? openBundled(it.id)
      : start(it.id, it.stems.includes(settings.model) ? settings.model : it.stems[0]);
    return card;
  }));
}

// Wrap the matched parts of `text` in <mark>, as safe DOM nodes (titles come from YouTube).
function highlight(text, words) {
  if (!words.length) return [text];
  const folded = fold(text);
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    for (let i = folded.indexOf(w); i !== -1; i = folded.indexOf(w, i + 1)) marks.fill(true, i, i + w.length);
  }
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    const part = text.slice(i, j);
    if (marks[i]) { const m = document.createElement("mark"); m.textContent = part; out.push(m); } else out.push(part);
    i = j;
  }
  return out;
}
$("libSearch").addEventListener("input", renderLibrary);
$("libSearch").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("libSearch").value = ""; renderLibrary(); $("libSearch").blur(); }
  if (e.key === "Enter") $("libGrid").querySelector(".card")?.click(); // Enter opens the first match
});
// "/" jumps to the search box from anywhere on the home screen.
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !$("home").hidden && !e.target.matches("input, select, textarea")) {
    e.preventDefault();
    $("libSearch").focus();
  }
});

// ============================================================ player

let song = null;        // result from the API
let currentModel = null;
let lines = [];         // [{t, end, text, words: [{t, end, w}]}]
let offset = 0;         // seconds added to lyric times
let yt = null, ytReady = false, ytOk = true, pendingVideo = null;

function load(result, model) {
  const sameSong = song?.id === result.id;
  song = result;
  offset = result.offset || 0;
  lines = result.lines.map(withWords);
  if (!sameSong) {
    // Nothing from the previous song may linger on screen.
    shownIdx = -2;
    for (const id of ["lPrev", "lCur", "lNext", "countdown"]) $(id).replaceChildren();
    $("dur").textContent = $("time").textContent = "0:00";
  }
  show("playerView");
  setArt(result.id);
  $("nowTitle").textContent = result.title;
  updateSub();
  updateOffset(0);
  if (!lines.length) $("lCur").textContent = "No lyrics found. Enjoy the instrumental 🎶";
  if (!sameSong) setupVideo(result.id);
  switchStems(model, !sameSong);
  if (!sameSong) window.arcade?.songChanged();
}

function updateSub() {
  const src = { lrclib: "Lyrics from LRCLIB", whisper: "Lyrics transcribed by Whisper", demo: "Demo track",
                bundled: `Built-in song · ${song.license || ""}` }[song.source] || "No lyrics";
  $("nowSub").textContent = `${song.artist} · ${src} · ${modelName(currentModel)} model`;
  // Freely licensed built-in songs carry their attribution, shown under the player.
  $("credit").textContent = song.credit || "";
  $("credit").hidden = !song.credit;
}

// Change the instrumental/vocal stems without losing the playback position.
// A second switch while the first is still loading reuses the first one's position.
let pendingSwitch = null;
function switchStems(model, fromStart = false) {
  pendingSwitch?.ctl.abort();
  const resume = fromStart ? { t: 0, playing: false }
    : pendingSwitch ? pendingSwitch.resume : { t: audio.currentTime, playing: !audio.paused };
  const ctl = new AbortController();
  pendingSwitch = { ctl, resume };
  currentModel = model;
  // Only YouTube songs live at ?v=…; built-in songs and the demo keep their own address.
  if (!STATIC && !song.bundled && song.id !== "demo") history.replaceState(null, "", `?v=${song.id}&m=${model}`);
  const base = song.media || `/media/${song.id}/stems/${model}`;
  audio.src = `${base}/instrumental.mp3`;
  vocals.src = `${base}/vocals.mp3`;
  vocals.load();
  audio.addEventListener("loadedmetadata", () => {
    pendingSwitch = null;
    audio.currentTime = resume.t;
    if (resume.playing) safePlay();
  }, { once: true, signal: ctl.signal });
  updateSub();
  renderModels();
}

// play() rejects when a new src interrupts it or autoplay is blocked; show the play button instead.
function safePlay() {
  return audio.play().catch((e) => {
    if (e.name !== "AbortError") { player.classList.add("paused"); setPlayIcon(false); }
  });
}

// LRCLIB only gives line timings, so spread the line across its words by length.
function withWords(line) {
  if (line.words?.length) return line;
  const parts = line.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((s, w) => s + w.length + 1, 0);
  let t = line.t;
  const dur = line.end - line.t;
  const words = parts.map((w) => {
    const d = (dur * (w.length + 1)) / total;
    const word = { t, end: t + d, w };
    t += d;
    return word;
  });
  return { ...line, words };
}

// Where the music video comes from: "local" (picture downloaded with the song, played in sync
// like the vocal), "yt" (YouTube embed, which can ask for sign-in), or "none" (stage lights / cover).
let videoMode = "none", videoPoll = null, videoFetching = false;
const localVideo = () => {
  let v = $("localVideo");
  if (!v) {
    v = document.createElement("video");
    v.id = "localVideo";
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.addEventListener("error", () => { // a codec this browser can't play: back to the embed
      if (videoMode === "local" && song) { song.video = null; setupVideo(song.id); }
    });
    $("video").append(v);
  }
  return v;
};

function setupVideo(id) {
  const box = $("video");
  box.classList.remove("fallback", "local");
  clearInterval(videoPoll);
  videoFetching = false;
  // Demo, built-in songs, or video switched off: animated stage lights instead of YouTube.
  const noVideo = id === "demo" || song?.bundled || !settings.video;
  videoStuckSince = 0;
  box.classList.toggle("demo-bg", !!noVideo);
  box.style.backgroundImage = "";
  $("localVideo")?.removeAttribute("src");
  $("localVideo")?.load();
  if (noVideo) { videoMode = "none"; ytOk = false; yt?.stopVideo?.(); return; }

  if (song?.video) { // downloaded picture: no YouTube player at all
    videoMode = "local";
    ytOk = false; yt?.stopVideo?.();
    box.classList.add("local");
    $("toast")?.classList.remove("show"); // a YouTube complaint from before the download is moot now
    const v = localVideo();
    v.src = `/media/${id}/${song.video}`;
    v.currentTime = audio.currentTime;
    if (!audio.paused) v.play().catch(() => {});
    return;
  }
  // Older songs: fetch the picture in the background and switch over as soon as it's there.
  if (!STATIC && song) {
    fetch(`/api/songs/${id}/video`, { method: "POST" }).catch(() => {});
    let tries = 0;
    videoFetching = true;
    const stop = () => { clearInterval(videoPoll); videoFetching = false; };
    videoPoll = setInterval(async () => {
      if (++tries > 60 || song?.id !== id) return stop();
      try {
        const r = await (await fetch(`/api/songs/${id}/video`)).json();
        if (r.video && song?.id === id) { stop(); song.video = r.video; setupVideo(id); }
        else if (!r.fetching && tries > 2) stop();
      } catch {}
    }, 3000);
  }
  videoMode = "yt";
  ytOk = true;
  pendingVideo = id;
  const create = () => {
    if (yt) { if (ytReady) yt.cueVideoById(id); return; } // not ready yet: onReady cues pendingVideo
    yt = new YT.Player("yt", {
      videoId: id,
      playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, cc_load_policy: 0 },
      events: {
        onReady: () => {
          ytReady = true;
          yt.mute();
          if (yt.getVideoData?.().video_id !== pendingVideo) yt.cueVideoById(pendingVideo);
        },
        // YouTube's own subtitles would duplicate our lyrics; they get re-enabled on each play.
        onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING) yt.unloadModule?.("captions"); },
        // Embedding forbidden by the label, sign-in required, video removed…: cover photo instead.
        onError: () => videoFallback("YouTube won't play this video here, so its cover is the backdrop. The karaoke works the same."),
      },
    });
  };
  if (window.YT?.Player) create(); else window.onYouTubeIframeAPIReady = create;
}

const videoOk = () => videoMode === "yt" && yt && ytReady && ytOk;

// One place to start, pause and seek whichever video is showing.
function videoPlay() {
  if (videoMode === "local") { const v = localVideo(); v.currentTime = audio.currentTime; v.play().catch(() => {}); }
  else if (videoOk()) { seekVideo(); yt.playVideo(); }
}
function videoPause() {
  if (videoMode === "local") localVideo().pause();
  else if (videoOk()) yt.pauseVideo();
}
function videoSeek() {
  if (videoMode === "local") localVideo().currentTime = audio.currentTime;
  else if (videoOk()) seekVideo();
}

const togglePlay = () => (audio.paused ? safePlay() : audio.pause());
const setPlayIcon = (playing) => $("play").querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");

$("play").onclick = togglePlay;
audio.addEventListener("play", () => {
  setPlayIcon(true);
  player.classList.remove("paused");
  syncVocals(true);
  videoPlay();
  armIdle();
});
audio.addEventListener("pause", () => {
  setPlayIcon(false);
  player.classList.add("paused");
  player.classList.remove("idle");
  vocals.pause();
  videoPause();
});
audio.addEventListener("loadedmetadata", () => { $("dur").textContent = fmt(audio.duration); });
audio.addEventListener("seeked", () => { syncVocals(true); videoSeek(); });
audio.addEventListener("ended", () => { audio.pause(); window.arcade?.ended(); });
// If the instrumental stalls to buffer, hold the vocal and the video with it.
audio.addEventListener("waiting", () => { vocals.pause(); videoPause(); });
audio.addEventListener("playing", () => { syncVocals(true); videoPlay(); });

// The downloaded picture follows the instrumental like the vocal does (small drift: nudge the rate).
setInterval(() => {
  if (videoMode !== "local" || audio.paused) return;
  const v = localVideo();
  if (v.seeking || v.readyState < 2) return;
  const drift = v.currentTime - audio.currentTime;
  if (v.ended || audio.currentTime > v.duration) return; // video shorter than the song: hold the last frame
  if (Math.abs(drift) > 0.25) { v.playbackRate = 1; v.currentTime = audio.currentTime; }
  else v.playbackRate = Math.abs(drift) > 0.04 ? 1 - Math.sign(drift) * 0.04 : 1;
  if (v.paused) v.play().catch(() => {});
}, 250);
player.classList.add("paused");

// Single click plays/pauses, double click toggles fullscreen.
let clickTimer;
$("stage").addEventListener("click", () => {
  clearTimeout(clickTimer);
  if (swallowTap) { swallowTap = false; return; }
  clickTimer = setTimeout(togglePlay, 220);
});
$("stage").addEventListener("dblclick", () => { clearTimeout(clickTimer); toggleFullscreen(); });

// The vocal track follows the instrumental. At 0% it stays paused to save CPU.
function syncVocals(force) {
  if (audio.paused || vocals.volume === 0) { vocals.pause(); return; }
  if (vocals.seeking) return; // let a running seek land before judging drift again
  const drift = vocals.currentTime - audio.currentTime;
  if (force || Math.abs(drift) > 0.15 || vocals.readyState < 3) {
    vocals.playbackRate = 1;
    vocals.currentTime = audio.currentTime;
  } else {
    // Small drift: speed up or slow down a touch instead of an audible jump.
    vocals.playbackRate = Math.abs(drift) > 0.03 ? 1 - Math.sign(drift) * 0.03 : 1;
  }
  if (vocals.paused) vocals.play().catch(() => {});
}
setInterval(() => syncVocals(false), 250);

// Audio is the master clock; nudge the video back whenever it drifts.
// getCurrentTime() is coarse and a seek takes a moment to land, so smooth the drift and back off after seeking.
let videoDrift = 0, lastVideoSeek = 0;
function seekVideo() {
  lastVideoSeek = performance.now();
  videoDrift = 0;
  yt.seekTo(audio.currentTime, true);
}
// If YouTube won't play the video here (sign-in or bot check, region lock…), the karaoke doesn't
// need it: after a few seconds of the song playing without the video moving, show the stage lights.
let videoStuckSince = 0;
// YouTube songs get their cover photo (slowly zooming) as the backdrop; anything else the stage lights.
async function videoFallback(message) {
  ytOk = false;
  yt?.stopVideo?.();
  const box = $("video");
  if (song && !song.bundled && song.id !== "demo") {
    box.classList.add("fallback");
    box.style.backgroundImage = `url(${await bestThumb(song.id)})`;
  } else box.classList.add("demo-bg");
  // While the picture is downloading, the cover stands in quietly: the real video arrives shortly.
  if (!message || videoFetching) return;
  // In the desktop app, offer the person's own browser: they're signed in to YouTube there.
  const desktop = window.stagelightDesktop;
  toast(message, desktop && {
    label: "Open in your browser",
    run: () => desktop.openInBrowser(location.pathname + location.search),
  });
}

// maxresdefault (1280×720) only exists for some videos; YouTube answers 120×90 grey when it doesn't.
function bestThumb(id) {
  return new Promise((resolve) => {
    const hd = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 200 ? hd : thumb(id));
    img.onerror = () => resolve(thumb(id));
    img.src = hd;
  });
}

function toast(message, action) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.replaceChildren(message);
  if (action) {
    const b = button(action.label, "btn primary small", () => { action.run(); el.classList.remove("show"); });
    el.append(b);
  }
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), action ? 14000 : 6000);
}

setInterval(() => {
  if (!videoOk() || audio.paused) return;
  const state = yt.getPlayerState();
  if (state === YT.PlayerState.PLAYING) videoStuckSince = 0;
  else if (!videoStuckSince) videoStuckSince = performance.now();
  else if (performance.now() - videoStuckSince > 7000) {
    return videoFallback("YouTube didn't play the video here (it may want you to sign in), so its cover is the backdrop. The karaoke works the same.");
  }
  if (state === YT.PlayerState.ENDED) return; // video shorter than the audio: leave it on its last frame
  if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) yt.playVideo();
  if (state !== YT.PlayerState.PLAYING || performance.now() - lastVideoSeek < 2000) return;
  videoDrift = videoDrift * 0.6 + (yt.getCurrentTime() - audio.currentTime) * 0.4;
  // Every seek flashes YouTube's overlay, so only correct drift you'd actually notice.
  if (Math.abs(videoDrift) > 0.4) seekVideo();
}, 500);

// ============================================================ keyboard

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], input:not([type]), select") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Escape") {
    if (!$("processing").hidden) $("procClose").click();
    else if (settingsOpen()) openSettings(false);
    else exitFullscreen();
    return;
  }
  if (e.code === "KeyS" && !$("home").hidden) { openSettings(); return; }
  if ($("playerView").hidden) return;
  const onRange = e.target.matches("input[type=range]");
  // Space/Enter on a focused button or toggle should press it, not play/pause.
  if (e.code === "Space" && e.target.closest("button, label, [role=button], #settings")) return;
  switch (e.code) {
    case "Space": e.preventDefault(); togglePlay(); break;
    case "KeyF": toggleFullscreen(); break;
    case "KeyS": openSettings(); break;
    case "KeyA": window.arcade?.toggle(); break;
    case "BracketLeft": updateOffset(-0.2); break;
    case "BracketRight": updateOffset(+0.2); break;
    case "ArrowLeft": if (!onRange && isFinite(audio.duration)) audio.currentTime = Math.max(0, audio.currentTime - 5); break;
    case "ArrowRight": if (!onRange && isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); break;
    default: return;
  }
  armIdle();
});

// ============================================================ fullscreen

// Falls back to filling the window when the browser refuses real fullscreen (e.g. inside an embed).
function toggleFullscreen() {
  if (document.fullscreenElement || player.classList.contains("fake-fs")) return exitFullscreen();
  const fake = () => { player.classList.add("fake-fs"); fsChanged(); };
  if (!document.fullscreenEnabled || !player.requestFullscreen) return fake();
  player.requestFullscreen().catch(fake);
  // Some embeds neither grant nor reject the request; don't leave the click doing nothing.
  setTimeout(() => { if (!document.fullscreenElement && !player.classList.contains("fake-fs")) fake(); }, 400);
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  if (player.classList.contains("fake-fs")) { player.classList.remove("fake-fs"); fsChanged(); }
}
const isFull = () => !!document.fullscreenElement || player.classList.contains("fake-fs");
function fsChanged() {
  if (settingsOpen()) hostSettings(); // only the fullscreen element is visible: follow it
  $("fs").querySelector("use").setAttribute("href", isFull() ? "#i-shrink" : "#i-expand");
  shownIdx = -2;
  armIdle();
}
document.addEventListener("fullscreenchange", fsChanged);
$("fs").onclick = toggleFullscreen;

// In fullscreen the controls fade out after a moment without mouse movement.
let idleTimer;
function armIdle() {
  player.classList.remove("idle");
  clearTimeout(idleTimer);
  if (!isFull()) return;
  idleTimer = setTimeout(() => {
    if (!audio.paused && !player.classList.contains("settings-open") && !$("controls").matches(":hover")) {
      player.classList.add("idle");
    }
  }, 2600);
}
player.addEventListener("mousemove", armIdle);
// On touch screens the first tap on a faded-out player only brings the controls back.
player.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" && player.classList.contains("idle")) { e.stopPropagation(); clearTimeout(clickTimer); swallowTap = true; }
  armIdle();
}, true);
let swallowTap = false;

// ============================================================ offset

let saveTimer;
function updateOffset(delta) {
  offset = Math.round((offset + delta) * 10) / 10;
  $("offVal").textContent = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;
  if (delta && song && song.id !== "demo" && !song.bundled) {
    clearTimeout(saveTimer);
    const id = song.id;
    saveTimer = setTimeout(() => fetch(`/api/songs/${id}/offset`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset }),
    }), 800);
  }
}
$("offMinus").onclick = () => updateOffset(-0.2);
$("offPlus").onclick = () => updateOffset(+0.2);

// ============================================================ lyrics render

let shownIdx = -2;
function render() {
  requestAnimationFrame(render);
  if (!song || $("playerView").hidden) return;
  const now = audio.currentTime;
  $("time").textContent = fmt(now);
  if (audio.duration && !scrubbing) {
    $("seek").value = (now / audio.duration) * 1000;
    paintRange($("seek"));
  }
  if (!lines.length) return;

  const t = now - offset; // lyric clock
  let idx = -1;
  for (let i = 0; i < lines.length && lines[i].t <= t; i++) idx = i;

  if (idx !== shownIdx) {
    shownIdx = idx;
    $("lPrev").textContent = lines[idx - 1]?.text || "";
    $("lNext").textContent = lines[idx + 1]?.text || "";
    const cur = $("lCur");
    cur.replaceChildren();
    const line = lines[idx];
    if (line) {
      line.words.forEach((w, i) => {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = w.w;
        cur.append(span, i < line.words.length - 1 ? " " : "");
      });
      const ball = document.createElement("i");
      ball.id = "ball";
      cur.append(ball);
      measureLine();
    } else {
      $("lNext").textContent = lines[0].text;
    }
  }

  const line = lines[idx];
  // Long intro: tell people when the singing starts instead of an empty screen.
  if (idx === -1) {
    const left = lines[0].t - t;
    const msg = left > 6 ? `♪ Lyrics in ${fmt(left)}` : "";
    if ($("lCur").textContent !== msg) { $("lCur").textContent = msg; $("lCur").classList.toggle("intro", !!msg); }
  } else $("lCur").classList.remove("intro");
  // Instrumental break: dim the finished line rather than leaving it lit through a solo.
  const nextLine = lines[idx + 1];
  $("lCur").classList.toggle("resting", !!(line && t > line.end + 1.2 && (!nextLine || nextLine.t - line.end > 4)));

  if (line) {
    const spans = $("lCur").querySelectorAll(".w");
    line.words.forEach((w, i) => {
      const p = Math.min(1, Math.max(0, (t - w.t) / Math.max(0.05, w.end - w.t)));
      const s = spans[i];
      if (!s) return;
      s.style.setProperty("--p", p.toFixed(3));
      s.classList.toggle("active", p > 0 && p < 1);
      s.classList.toggle("sung", p >= 1);
    });
    placeBall(line, t);
  }

  // Countdown dots before a line that follows a long pause.
  const next = lines[idx + 1];
  const gapStart = line ? line.end : 0;
  const until = next ? next.t - t : Infinity;
  const dots = settings.countdown && next && next.t - gapStart > 4 && until > 0 && until <= 3 ? Math.ceil(until) : 0;
  const cd = $("countdown");
  if (cd.childElementCount !== dots) cd.replaceChildren(...Array.from({ length: dots }, () => document.createElement("i")));
}
requestAnimationFrame(render);

// ============================================================ bouncing ball

let wordPos = [], fontPx = 40;
function measureLine() {
  const cur = $("lCur");
  fontPx = parseFloat(getComputedStyle(cur).fontSize);
  wordPos = [...cur.querySelectorAll(".w")].map((s) => ({ x: s.offsetLeft + s.offsetWidth / 2, y: s.offsetTop }));
}
window.addEventListener("resize", () => { shownIdx = -2; });
document.fonts?.addEventListener?.("loadingdone", () => { shownIdx = -2; });

// The ball lands on each word as it starts and arcs over to the next one.
function placeBall(line, t) {
  const ball = $("ball");
  if (!ball || !wordPos.length) return;
  ball.style.display = settings.ball ? "" : "none";
  if (!settings.ball) return;
  const W = line.words;
  let i = 0;
  while (i < W.length - 1 && W[i + 1].t <= t) i++;
  const a = wordPos[i];
  let x = a.x, y = a.y, lift = 0, hop = fontPx * 0.5;
  if (t < W[0].t) {
    lift = 0.25 * Math.abs(Math.sin((t - W[0].t) * Math.PI * 2)); // idle bounce before the line starts
  } else if (i < W.length - 1) {
    const b = wordPos[i + 1];
    const p = Math.min(1, (t - W[i].t) / Math.max(0.05, W[i + 1].t - W[i].t));
    x += (b.x - a.x) * p;
    y += (b.y - a.y) * p;
    lift = Math.sin(Math.PI * p);
    hop = Math.min(fontPx * 0.9, fontPx * 0.3 + Math.abs(b.x - a.x) * 0.35);
  } else {
    const p = (t - W[i].t) / Math.max(0.2, W[i].end - W[i].t);
    lift = p < 1 ? 0.5 * Math.sin(Math.PI * p) : 0;
  }
  ball.classList.toggle("squash", lift < 0.08);
  ball.style.transform = `translate(${x}px, ${y - fontPx * 0.36 - lift * hop}px)`;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ============================================================ search

let lastResults = [], searchToken = 0;
async function searchSongs(q) {
  if (!q) return;
  const token = ++searchToken;
  $("results").hidden = false;
  $("resTitle").textContent = `Results for “${q}”`;
  $("resNote").hidden = true;
  // Placeholder cards while YouTube answers (1–3 s).
  $("resGrid").replaceChildren(...Array.from({ length: 4 }, () => {
    const c = document.createElement("div");
    c.className = "card skeleton";
    c.innerHTML = `<div class="thumb"></div><div class="meta"><div class="t"></div><div class="a"></div></div>`;
    return c;
  }));
  const submit = $("go");
  submit.disabled = true;
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Search failed");
    if (token !== searchToken) return;
    lastResults = await r.json();
    renderResults();
    if (!lastResults.length) { $("resNote").textContent = "Nothing found. Try the artist and song title."; $("resNote").hidden = false; }
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (token !== searchToken) return;
    $("resGrid").replaceChildren();
    $("resNote").textContent = err.message;
    $("resNote").hidden = false;
  } finally {
    submit.disabled = false;
  }
}
$("resClear").onclick = () => { searchToken++; lastResults = []; $("results").hidden = true; $("url").value = ""; $("go").textContent = "Search"; };

function renderResults() {
  if ($("results").hidden) return;
  $("resGrid").replaceChildren(...lastResults.map((it) => {
    const card = document.createElement("div");
    card.className = "card result";
    card.innerHTML = `<div class="thumb"></div><div class="meta"><div class="t"></div><div class="a"></div><div class="slot"></div></div>`;
    const th = card.querySelector(".thumb");
    th.style.backgroundImage = `url(${thumb(it.id)})`;
    if (it.duration) th.insertAdjacentHTML("beforeend", `<span class="dur">${fmt(it.duration)}</span>`);
    if (it.stems.length) th.insertAdjacentHTML("beforeend", `<span class="badge-in">In library</span>`);
    card.querySelector(".t").textContent = it.title;
    card.querySelector(".t").title = it.title;
    card.querySelector(".a").textContent = it.channel;
    card.querySelector(".slot").append(resultAction(it));
    return card;
  }));
}

// What a result card offers depends on whether it's ready, queued or new.
function resultAction(it) {
  const job = queueJobs.find((j) => j.id === it.id && !["error", "cancelled"].includes(j.stage));
  const ready = it.stems.length || job?.stage === "done";
  const box = document.createElement("div");
  if (ready) {
    box.className = "actions";
    const model = it.stems.includes(settings.model) ? settings.model : (it.stems[0] || job.model);
    box.append(button("▶ Sing now", "btn primary", () => start(it.id, model)));
  } else if (job) {
    box.className = "state";
    box.innerHTML = `<span></span><span class="mini-bar"><i></i></span>`;
    box.firstChild.textContent = jobStatus(job).text;
    box.querySelector("i").style.width = `${Math.round(jobStatus(job).progress * 100)}%`;
  } else {
    box.className = "actions";
    box.append(
      button("▶ Sing", "btn primary", () => start(it.id, settings.model, { title: it.title })),
      button("+ Queue", "btn ghost", () => enqueue(it)),
    );
  }
  return box;
}

async function enqueue(it) {
  await fetch("/api/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: it.id, model: settings.model, title: it.title }),
  });
  $("queue").classList.remove("collapsed");
  await refreshQueue();
}

// ============================================================ queue

let queueJobs = [], queueNow = 0, queueWasBusy = false;
async function refreshQueue() {
  if (STATIC) return;
  try {
    const data = await (await fetch("/api/jobs")).json();
    queueJobs = data.jobs;
    queueNow = data.now;
  } catch { return; }
  const busy = queueJobs.some((j) => !["done", "error", "cancelled"].includes(j.stage));
  if (queueWasBusy && queueJobs.some((j) => j.stage === "done")) loadLibrary(); // something just finished
  queueWasBusy = busy;
  renderQueue(busy);
  renderResults();
}

function jobStatus(j) {
  const p = j.progress || 0;
  if (j.cancel) return { text: "Cancelling…", progress: p };
  switch (j.stage) {
    case "queued": {
      const ahead = queueJobs.filter((o) => !["done", "error", "cancelled"].includes(o.stage)
        && o !== j && (o.stage !== "queued" || o.seq < j.seq)).length;
      return { text: ahead ? `Waiting · ${ahead} ahead` : "Up next", progress: 0 };
    }
    case "starting": case "download": return { text: "Downloading…", progress: 0.02 };
    case "separate": {
      let text = `Removing vocals ${Math.round(p * 100)}%`;
      const elapsed = queueNow - j.stageStarted;
      if (p > 0.04) text += ` · ${fmtLeft((elapsed / p) * (1 - p))} left`;
      return { text, progress: 0.05 + p * 0.85 };
    }
    case "encode": return { text: "Saving…", progress: 0.92 };
    case "lyrics": case "align": return { text: "Finding lyrics…", progress: 0.95 };
    case "transcribe": return { text: "Transcribing lyrics…", progress: 0.96 };
    case "done": return { text: "Ready to sing", progress: 1 };
    case "cancelled": return { text: "Removed", progress: 0 };
    default: return { text: j.error || "Failed", progress: 0 };
  }
}

function renderQueue(busy) {
  const items = queueJobs.filter((j) => j.stage !== "cancelled");
  $("queue").hidden = !items.length;
  if (!items.length) return;
  $("queue").classList.toggle("busy", busy);
  const waiting = items.filter((j) => !["done", "error"].includes(j.stage)).length;
  $("queueLabel").textContent = waiting ? `Processing · ${waiting}` : "Queue · all done";
  $("queueList").replaceChildren(...items.map((j) => {
    const st = jobStatus(j);
    const li = document.createElement("li");
    li.className = `q-item${j.stage === "done" ? " ready" : ""}${j.stage === "error" ? " failed" : ""}`;
    li.innerHTML = `<img alt=""><div><div class="q-title"></div><div class="q-status"></div><div class="q-bar"><i></i></div></div><span class="q-act"></span>`;
    li.querySelector("img").src = thumb(j.id);
    li.querySelector(".q-title").textContent = j.title || "Fetching title…";
    li.querySelector(".q-status").textContent = st.text;
    li.querySelector(".q-status").title = st.text;
    li.querySelector(".q-bar i").style.width = `${Math.round(st.progress * 100)}%`;
    if (j.stage === "done" || j.stage === "error") li.querySelector(".q-bar").remove();
    const act = li.querySelector(".q-act");
    if (j.stage === "done") act.append(button("▶ Sing", "btn primary", () => start(j.id, j.model)));
    else if (j.stage === "error") act.append(button("Retry", "btn ghost", () => start(j.id, j.model, { title: j.title })));
    else if (j.stage !== "queued") act.append(button("View", "btn ghost", () => start(j.id, j.model)));
    if (!j.cancel) {
      const x = button("✕", "x", async () => {
        await fetch(`/api/jobs/${j.id}/${j.model}`, { method: "DELETE" });
        refreshQueue();
      });
      x.title = j.stage === "queued" ? "Remove from queue" : ["done", "error"].includes(j.stage) ? "Clear" : "Cancel processing";
      act.append(x);
    }
    return li;
  }));
}
$("queueHead").onclick = () => {
  const collapsed = $("queue").classList.toggle("collapsed");
  $("queue").classList.toggle("expanded-in-player", !collapsed);
  $("queueHead").setAttribute("aria-expanded", String(!collapsed));
};
setInterval(refreshQueue, 2000);
refreshQueue();

// ============================================================ boot

applySettings();
loadModels().then(() => {
  loadLibrary();
  const q = new URLSearchParams(location.search);
  if (STATIC || q.has("demo")) openDemo();
  else if (q.get("song")) openBundled(q.get("song"), { push: false });
  else if (q.get("v")) start(q.get("v"), q.get("m") || settings.model);
});

// Built-in songs (freely licensed, already separated and synced, in static/songs/<slug>/): they
// open instantly, with no server work. Paths are relative so the same files work at "/" in the
// app and at "/demo/" on the website.
const DEMO_SONG = "crazy-glue";
async function openBundled(slug, { push = true } = {}) {
  pollToken++;
  const r = await fetch(`songs/${slug}/song.json`);
  if (!r.ok) throw new Error(`Built-in song ${slug} not found`);
  const result = await r.json();
  load(result, result.stems[0]);
  if (!STATIC) {
    const target = `?song=${slug}`;
    if (push && location.search !== target) history.pushState(null, "", target); else history.replaceState(null, "", target);
  }
  setArt(null);
}

// "Try the demo": the built-in song, or the tiny synth demo (original lyrics) if it's missing.
async function openDemo() {
  try { return await openBundled(DEMO_SONG, { push: false }); } catch {}
  const result = await (await fetch("demo/demo.json")).json();
  load(result, "karaoke");
  if (!STATIC) history.replaceState(null, "", "?demo");
  setArt(null);
}

if (STATIC) {
  // Nothing to search or process on the website: "back" returns to the landing page, and
  // per-song model switching (which needs the server) is hidden.
  $("back").onclick = () => { location.href = "../"; };
  $("modelList").closest("section").hidden = true;
  const cta = document.createElement("a");
  cta.className = "static-cta";
  cta.href = "../#download";
  cta.innerHTML = "Like it? <b>Get Stagelight</b> and sing any song →";
  // Below the player, in the page flow: a floating banner would cover the controls on short screens.
  $("playerView").append(cta);
}
$("demoLink")?.addEventListener("click", (e) => { e.preventDefault(); history.pushState(null, "", "?demo"); openDemo(); });
