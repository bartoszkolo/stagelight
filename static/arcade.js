// Arcade mode: sing into the microphone and score points against the original singer's melody.
//
// The melody comes from the separated vocal stem (pipeline.melody: a MIDI note every 20 ms). The
// microphone is pitch-tracked here with YIN, ~60 times a second, entirely in the browser. Notes are
// compared regardless of octave, so anyone can sing any song. Each lyric line gets a rating
// (Perfect / Great / Good / Miss) from the share of its sung frames you hit; good lines build a combo.
// Uses app.js globals: $, audio, song, lines, offset, settings, toast, player.
(() => {
  const TOLERANCE = { easy: 2, normal: 1.2, hard: 0.6 }; // semitones
  const RATINGS = [[0.62, "Perfect"], [0.42, "Great"], [0.22, "Good"], [0, "Miss"]];
  const STARS = [0.15, 0.3, 0.45, 0.6, 0.75]; // share of the song's notes hit, for 1..5 stars
  const melodies = new Map();

  let on = false, melody = null, center = 60;
  let ctx = null, stream = null, analyser = null, buf = null;
  let stats = new Map(); // line index -> { targets, hits, done }
  let score = 0, combo = 0, bestCombo = 0, perfect = 0, totalTargets = 0, totalHits = 0;
  const trail = []; // recent mic pitches: { t, midi, hit }

  const lane = $("lane"), g = lane.getContext("2d");

  // ---------------------------------------------------------------- on / off

  async function enable() {
    if (!song || song.id === "demo") return toast("Arcade needs a real song. Try the built-in one or anything from your library.");
    if (!navigator.mediaDevices?.getUserMedia) return toast("This browser can't use the microphone here.");
    try {
      // Echo cancellation keeps the music from the speakers out of the mic as much as it can.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return toast("Arcade needs your microphone. Allow it for Stagelight in your browser or system settings, then try again.");
    }
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    buf = new Float32Array(analyser.fftSize);

    melody = await loadMelody(song);
    if (!melody) { disable(); return; }
    reset();
    on = true;
    $("arcadeBtn").classList.add("on");
    $("arcadeBtn").setAttribute("aria-pressed", "true");
    lane.hidden = $("arcadeHud").hidden = false;
    player.classList.add("arcade");
    toast("Arcade on: sing along and hit the notes! Headphones give the most accurate score.");
  }

  function disable() {
    on = false;
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    stream = ctx = analyser = null;
    $("arcadeBtn").classList.remove("on");
    $("arcadeBtn").setAttribute("aria-pressed", "false");
    lane.hidden = $("arcadeHud").hidden = true;
    player.classList.remove("arcade");
  }

  async function loadMelody(s) {
    if (melodies.has(s.id)) return melodies.get(s.id);
    if (!s.bundled) toast("Getting the melody ready. The first time takes about half a minute…");
    try {
      const r = await fetch(s.bundled ? `songs/${s.id}/melody.json` : `/api/songs/${s.id}/melody`);
      if (!r.ok) throw new Error();
      const m = await r.json();
      const pitches = m.notes.map((n) => n[2]).sort((a, b) => a - b);
      m.center = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 60;
      melodies.set(s.id, m);
      return m;
    } catch {
      toast("Couldn't get the melody for this song, so arcade isn't available for it.");
      return null;
    }
  }

  function reset() {
    stats = new Map();
    score = combo = bestCombo = perfect = totalTargets = totalHits = 0;
    trail.length = 0;
    center = melody?.center ?? 60;
    $("score").textContent = "0";
    $("combo").textContent = "";
  }

  // ---------------------------------------------------------------- pitch detection (YIN)

  // Returns the sung pitch as a MIDI number, or null for silence / no clear pitch.
  function detect() {
    analyser.getFloatTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / buf.length) < 0.012) return null;
    // Halve the rate: plenty for a voice (up to ~1 kHz) and 4x less work.
    const sr = ctx.sampleRate / 2, n = buf.length / 2, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = buf[i * 2];
    const w = n >> 1, minT = Math.floor(sr / 1000), maxT = Math.min(w - 1, Math.ceil(sr / 70));
    const d = new Float32Array(maxT + 1);
    let running = 0;
    for (let tau = 1; tau <= maxT; tau++) {
      let s = 0;
      for (let j = 0; j < w; j++) { const v = x[j] - x[j + tau]; s += v * v; }
      running += s;
      d[tau] = running ? (s * tau) / running : 1; // cumulative mean normalized difference
    }
    for (let tau = minT; tau <= maxT; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 <= maxT && d[tau + 1] < d[tau]) tau++;
        const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b;
        const shift = (a - 2 * b + c) ? (a - c) / (2 * (a - 2 * b + c)) : 0; // parabolic peak
        const f = sr / (tau + shift);
        return 69 + 12 * Math.log2(f / 440);
      }
    }
    return null;
  }

  const semitoneDistance = (a, b) => Math.abs(((a - b) % 12 + 18) % 12 - 6); // octave-free

  // ---------------------------------------------------------------- scoring

  function lineAt(t) { // index of the lyric line being sung at audio time t
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].t + offset <= t) return t <= lines[i].end + offset + 0.25 ? i : -1;
    return -1;
  }

  function tick() {
    const now = audio.currentTime;
    const t = now - settings.micDelay / 1000; // what you're singing now belongs to slightly earlier audio
    const mic = detect();
    const target = melody.frames[Math.round(t / melody.hop)];
    let hit = false;
    if (target != null) {
      const li = lineAt(t);
      if (li >= 0) {
        const st = stats.get(li) || { targets: 0, hits: 0, done: false };
        if (!st.done) {
          st.targets++;
          hit = mic != null && semitoneDistance(mic, target) <= TOLERANCE[settings.difficulty];
          if (hit) st.hits++;
          stats.set(li, st);
        }
      }
    }
    if (mic != null) trail.push({ t: now, midi: mic, hit });
    while (trail.length && trail[0].t < now - 1.5) trail.shift();
    finishLines(t);
  }

  function finishLines(t) {
    for (const [li, st] of stats) {
      if (st.done || t <= lines[li].end + offset + 0.3) continue;
      st.done = true;
      if (st.targets < 8) continue; // barely any melody detected for this line: don't judge it
      const ratio = st.hits / st.targets;
      const label = RATINGS.find(([min]) => ratio >= min)[1];
      totalTargets += st.targets;
      totalHits += st.hits;
      combo = label === "Miss" ? 0 : combo + 1;
      bestCombo = Math.max(bestCombo, combo);
      if (label === "Perfect") perfect++;
      score += Math.round(ratio * 1000 * (1 + 0.1 * Math.min(combo, 10)));
      showRating(label);
    }
    $("score").textContent = score.toLocaleString("en");
    $("combo").textContent = combo >= 2 ? `${combo}× combo` : "";
  }

  function showRating(label) {
    const el = $("rating");
    el.textContent = label === "Miss" ? "Miss" : `${label}!`;
    el.className = `show r-${label.toLowerCase()}`;
    clearTimeout(showRating.timer);
    showRating.timer = setTimeout(() => (el.className = ""), 900);
  }

  // Seeking back lets you sing those lines again.
  audio.addEventListener("seeked", () => {
    if (!on) return;
    const t = audio.currentTime;
    for (const [li] of stats) if (lines[li].t + offset >= t - 0.5) stats.delete(li);
    trail.length = 0;
  });

  // ---------------------------------------------------------------- results

  function showResults() {
    finishLines(Infinity);
    const acc = totalTargets ? totalHits / totalTargets : 0;
    const stars = STARS.filter((s) => acc >= s).length;
    const key = `stagelight.best.${song.id}`;
    let best = 0;
    try { best = Number(localStorage.getItem(key)) || 0; } catch {}
    const record = score > best;
    if (record) try { localStorage.setItem(key, String(score)); } catch {}
    $("resSong").textContent = song.title;
    $("resStars").textContent = "★".repeat(stars) + "☆".repeat(5 - stars);
    $("resScore").textContent = score.toLocaleString("en");
    $("resBest").textContent = record ? (best ? "New best!" : "First score!") : `Best: ${best.toLocaleString("en")}`;
    $("resAcc").textContent = `${Math.round(acc * 100)}%`;
    $("resCombo").textContent = String(bestCombo);
    $("resPerfect").textContent = String(perfect);
    $("results").hidden = false;
  }
  $("resAgain").onclick = () => { $("results").hidden = true; reset(); audio.currentTime = 0; audio.play(); };
  $("resClose").onclick = () => { $("results").hidden = true; };

  // ---------------------------------------------------------------- note lane

  const PAST = 1.2, AHEAD = 3; // seconds shown left and right of "now"
  function draw() {
    const dpr = devicePixelRatio || 1, w = lane.clientWidth, h = lane.clientHeight;
    if (lane.width !== Math.round(w * dpr) || lane.height !== Math.round(h * dpr)) {
      lane.width = Math.round(w * dpr); lane.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const now = audio.currentTime, xNow = w * 0.22, pxPerSec = (w - xNow) / AHEAD;
    const xOf = (t) => xNow + (t - now) * pxPerSec;
    const span = 20; // semitones shown
    const fold = (m) => { while (m > center + span / 2) m -= 12; while (m < center - span / 2) m += 12; return m; };
    const yOf = (m) => h * 0.9 - ((fold(m) - (center - span / 2)) / span) * h * 0.8;
    const hl = getComputedStyle(document.documentElement).getPropertyValue("--hl").trim() || "#ffd447";

    g.fillStyle = "rgba(0,0,0,.35)";
    g.beginPath(); g.roundRect(0, 0, w, h, 14); g.fill();
    const barH = Math.max(6, h / 22);
    for (const [t0, t1, m] of melody.notes) {
      if (t1 < now - PAST || t0 > now + AHEAD) continue;
      const x0 = Math.max(4, xOf(t0)), x1 = Math.min(w - 4, xOf(t1));
      if (x1 <= x0) continue;
      const live = t0 <= now && t1 >= now;
      g.globalAlpha = t1 < now ? 0.35 : 1;
      g.fillStyle = live ? hl : "rgba(255,255,255,.55)";
      if (live) { g.shadowColor = hl; g.shadowBlur = 12; }
      g.beginPath(); g.roundRect(x0, yOf(m) - barH / 2, x1 - x0, barH, barH / 2); g.fill();
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    // "now" line, then your voice: hits glow in the highlight colour
    g.fillStyle = "rgba(255,255,255,.6)";
    g.fillRect(xNow - 1, 6, 2, h - 12);
    for (const p of trail) {
      g.fillStyle = p.hit ? hl : "rgba(255,120,150,.8)";
      g.beginPath(); g.arc(xOf(p.t), yOf(p.midi), p.t > now - 0.05 ? 6 : 3, 0, Math.PI * 2); g.fill();
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!on || !melody) return;
    if (!audio.paused && ctx) tick();
    draw();
  }
  requestAnimationFrame(loop);

  // ---------------------------------------------------------------- hooks used by app.js

  window.arcade = {
    toggle: () => (on ? disable() : enable()),
    get on() { return on; },
    // New song while arcade is on: fetch its melody and start a fresh score.
    async songChanged() {
      $("results").hidden = true;
      if (!on) return;
      melody = await loadMelody(song);
      if (!melody) return disable();
      reset();
    },
    ended() { if (on) showResults(); },
    // For tests and curious people: what the mic hears right now and the running totals.
    get debug() { return { lastMidi: trail.at(-1)?.midi ?? null, heard: trail.length, totalTargets, totalHits, score }; },
  };
  $("arcadeBtn").onclick = () => window.arcade.toggle();
})();
