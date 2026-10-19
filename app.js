(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const PEAK_RATE = 100;      // waveform resolution: peaks per second
  const WINDOW_SECS = 6;      // seconds of music visible in the waveform
  const PLAYHEAD_AT = 0.3;    // playhead position (fraction of width)

  // ── Storage (IndexedDB: songs, notes & video takes live on her phone) ───
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('mays-studio', 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes', { keyPath: 'id' }).createIndex('song', 'songId');
          // One choreo (reference) video per song
          if (!db.objectStoreNames.contains('refs')) db.createObjectStore('refs', { keyPath: 'songId' });
        };
        req.onsuccess = () => {
          this.db = req.result;
          // An older copy of the app open elsewhere shouldn't block upgrades
          this.db.onversionchange = () => { this.db.close(); this.db = null; };
          resolve(this.db);
        };
        req.onerror = () => reject(req.error);
      });
    },
    async tx(name, mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(name, mode);
        const req = fn(t.objectStore(name));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    },
    all() { return this.tx('songs', 'readonly', (s) => s.getAll()); },
    get(id) { return this.tx('songs', 'readonly', (s) => s.get(id)); },
    put(rec) { return this.tx('songs', 'readwrite', (s) => s.put(rec)); },
    del(id) { return this.tx('songs', 'readwrite', (s) => s.delete(id)); },
    takesFor(songId) { return this.tx('takes', 'readonly', (s) => s.index('song').getAll(songId)); },
    putTake(rec) { return this.tx('takes', 'readwrite', (s) => s.put(rec)); },
    delTake(id) { return this.tx('takes', 'readwrite', (s) => s.delete(id)); },
    getRef(songId) { return this.tx('refs', 'readonly', (s) => s.get(songId)); },
    putRef(rec) { return this.tx('refs', 'readwrite', (s) => s.put(rec)); },
    delRef(songId) { return this.tx('refs', 'readwrite', (s) => s.delete(songId)); },
    async delTakesFor(songId) {
      for (const t of await this.takesFor(songId)) await this.delTake(t.id);
    },
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ── State ───────────────────────────────────────────────────────────────
  const audio = new Audio();
  audio.preload = 'auto';
  let song = null;        // current song record
  let objectURL = null;
  let sel = null;         // selected 8-counts: { from, to } (0-based)
  let looping = false;
  let taps = [];
  let drag = null;        // waveform scrub state
  let lastBeat = null, lastEight = null;
  let colors = {};
  let saveTimer = null;
  let clock = { a: 0, w: 0 };

  // audio.currentTime only advances in coarse steps on some browsers, so between
  // updates we extrapolate with the precise wall clock for smooth counts & loops.
  function songTime() {
    const a = audio.currentTime, w = performance.now() / 1000;
    if (audio.paused || a !== clock.a) { clock = { a, w }; return a; }
    return a + (w - clock.w) * audio.playbackRate;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isHipHop = () => document.documentElement.dataset.mode === 'hiphop';
  const eightWord = () => (isHipHop() ? '8-count' : 'phrase');

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function show(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
    window.scrollTo(0, 0);
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => song && DB.put(song), 400);
  }

  // ── Beat math ───────────────────────────────────────────────────────────
  const beatLen = () => (song && song.bpm ? 60 / song.bpm : null);
  const beatAt = (t) => Math.floor((t - song.offset) / beatLen() + 1e-4);
  const eightStart = (n) => song.offset + n * 8 * beatLen();
  const eightTotal = () => {
    const b = beatLen();
    return b ? Math.max(0, Math.ceil((song.duration - song.offset) / (8 * b) - 1e-4)) : 0;
  };

  // ── Audio analysis ──────────────────────────────────────────────────────
  async function analyse(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const data = await blob.arrayBuffer();
    // Older Safari only supports the callback form
    const buf = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(data, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(buf.sampleRate / PEAK_RATE));
    const peaks = new Float32Array(Math.floor(ch.length / step));
    let max = 0;
    for (let i = 0; i < peaks.length; i++) {
      let m = 0;
      for (let j = i * step, e = j + step; j < e; j += 4) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
      peaks[i] = m;
      if (m > max) max = m;
    }
    if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    if (ctx.close) ctx.close();
    return { peaks, duration: buf.duration };
  }

  async function addSong(blob, name, extra = {}) {
    toast('Reading the music…');
    let info;
    try {
      info = await analyse(blob);
    } catch (e) {
      toast("Couldn't read that file. Try an MP3, M4A or WAV.");
      return;
    }
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, blob, peaks: info.peaks, duration: info.duration,
      bpm: null, offset: 0, oneSet: false, notes: {}, added: Date.now(),
      ...extra,
    };
    await DB.put(rec);
    openSong(rec.id);
  }

  // ── Library ─────────────────────────────────────────────────────────────
  async function renderLibrary() {
    const songs = (await DB.all()).sort((a, b) => b.added - a.added);
    $('#empty').classList.toggle('hidden', songs.length > 0);
    $('#song-list').innerHTML = songs.map((s) => {
      const notes = Object.keys(s.notes || {}).length;
      const meta = [fmt(s.duration), s.bpm ? `${Math.round(s.bpm)} BPM` : 'tap to set the beat', notes ? `${notes} note${notes > 1 ? 's' : ''}` : '']
        .filter(Boolean).join(' · ');
      return `<button class="song" data-id="${s.id}">
        <span class="song-art">${esc((s.name.trim()[0] || '♪').toUpperCase())}</span>
        <span class="song-body"><div class="song-name">${esc(s.name)}</div><div class="song-meta">${meta}</div></span>
      </button>`;
    }).join('');
  }

  $('#song-list').addEventListener('click', (e) => {
    const b = e.target.closest('.song');
    if (b) openSong(b.dataset.id);
  });

  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    // Copy into a plain Blob — some Safari versions won't store File objects
    const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'audio/mpeg' });
    addSong(blob, f.name.replace(/\.[^.]+$/, ''));
  });

  $('#demo-btn').addEventListener('click', () => {
    addSong(makePracticeBeat(95), 'Practice beat', { bpm: 95, offset: 0, oneSet: true });
  });

  // ── Player ──────────────────────────────────────────────────────────────
  async function openSong(id) {
    song = await DB.get(id);
    if (!song) return;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(song.blob);
    audio.src = objectURL;
    setRate(1);
    sel = null; looping = false; taps = []; lastBeat = lastEight = undefined;
    $('#song-title').textContent = song.name;
    $('#t-dur').textContent = fmt(song.duration);
    $('#bpm').value = song.bpm ? song.bpm.toFixed(1) : '';
    $('#wave-loading').classList.add('hidden');
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.name, artist: "May's Studio" });
    }
    renderEights();
    renderSelection();
    refreshTakeCount();
    loadRef();
    show('view-player');
  }

  function closeSong() {
    closeTakeView();
    closeMirror();
    closeLearn();
    ref = null;
    $('#takes').classList.add('hidden');
    audio.pause();
    if (song) DB.put(song);
    song = null;
    renderLibrary();
    show('view-library');
  }
  $('#back').addEventListener('click', closeSong);

  $('#delete-song').addEventListener('click', async () => {
    if (!song || !confirm(`Remove “${song.name}” with its notes and video takes?`)) return;
    audio.pause();
    await DB.del(song.id);
    await DB.delTakesFor(song.id);
    await DB.delRef(song.id);
    song = null;
    renderLibrary();
    show('view-library');
  });

  // Transport
  const playBtn = $('#play');
  const play = () => audio.play().catch(() => toast("Couldn't play this song"));
  playBtn.addEventListener('click', () => (audio.paused ? play() : audio.pause()));
  audio.addEventListener('play', () => (playBtn.textContent = '❚❚'));
  audio.addEventListener('pause', () => (playBtn.textContent = '▶'));
  audio.addEventListener('ended', () => {
    if (take) return stopTake();
    if (looping && sel) { seek(loopBounds()[0]); play(); }
  });

  function seek(t) { audio.currentTime = clamp(t, 0, song.duration - 0.05); }

  // Loop region in song seconds; the last 8-count may run past the end of the song
  const loopBounds = () => [eightStart(sel.from), Math.min(eightStart(sel.to + 1), song.duration - 0.08)];

  function jumpEight(dir) {
    const t = audio.currentTime;
    if (!beatLen()) return seek(t + dir * 5);
    const cur = Math.floor(beatAt(t) / 8);
    const intoEight = t - eightStart(cur);
    // "back" from mid-phrase restarts this phrase first, like a music player
    const target = dir < 0 && intoEight > 0.6 ? cur : cur + dir;
    seek(Math.max(0, eightStart(target)));
  }
  $('#back8').addEventListener('click', () => jumpEight(-1));
  $('#fwd8').addEventListener('click', () => jumpEight(1));

  function setRate(r) {
    audio.playbackRate = r;
    audio.defaultPlaybackRate = r;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    document.querySelectorAll('.speed button').forEach((b) => b.classList.toggle('on', +b.dataset.rate === r));
  }
  document.querySelectorAll('.speed button').forEach((b) =>
    b.addEventListener('click', () => setRate(+b.dataset.rate)));

  // ── Finding the beat ────────────────────────────────────────────────────
  $('#tap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!song) return;
    if (audio.paused) return toast('Press play, then tap along on every beat');
    const btn = e.currentTarget;
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 90);

    // audio.currentTime only updates in coarse steps, so time the taps with the
    // precise wall clock (scaled by playback speed) and use the audio clock just
    // to anchor where in the song they landed.
    const w = performance.now() / 1000, a = audio.currentTime, rate = audio.playbackRate;
    const last = taps[taps.length - 1];
    if (last && (w - last.w > 2.5 || a < last.a - 0.5 || rate !== last.rate)) taps = [];
    taps.push({ w, a, rate });
    if (taps.length > 16) taps.shift();   // follow her latest taps if she corrects herself
    if (taps.length < 4) return toast(`keep tapping… ${4 - taps.length}`);

    // Least-squares fit of tap k → offset + k * beat (in song seconds)
    const ys = taps.map((tp) => (tp.w - taps[0].w) * rate);
    const n = ys.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    ys.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    // Averaging the audio-clock anchors cancels out its jitter
    const anchor = taps.reduce((s, tp, k) => s + tp.a - ys[k], 0) / n;
    const o = anchor + (sy - b * sx) / n;
    const bpm = Math.round((60 / b) * 10) / 10;
    if (bpm < 40 || bpm > 220) return;
    song.bpm = bpm;
    if (!song.oneSet) song.offset = o;   // her first tap counts as "1"
    $('#bpm').value = bpm.toFixed(1);
    gridChanged();
    saveSoon();
  });

  $('#bpm').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!song || !(v >= 40 && v <= 220)) return;
    song.bpm = v;
    gridChanged();
    saveSoon();
  });

  $('#set-one').addEventListener('click', () => {
    if (!song) return;
    song.offset = audio.currentTime;
    song.oneSet = true;
    toast(song.bpm ? 'Counting starts here' : 'Got the “1”. Now tap along to set the tempo');
    gridChanged();
    saveSoon();
  });

  const nudge = (d) => {
    if (!song) return;
    song.offset = Math.max(0, song.offset + d);
    song.oneSet = true;
    toast(d < 0 ? 'Counts moved a touch earlier' : 'Counts moved a touch later');
    gridChanged();
    saveSoon();
  };
  $('#nudge-l').addEventListener('click', () => nudge(-0.02));
  $('#nudge-r').addEventListener('click', () => nudge(0.02));

  // Beat grid moved: drop a selection that no longer exists, then redraw
  function gridChanged() {
    if (sel && sel.to >= eightTotal()) { sel = null; looping = false; }
    renderEights();
    renderSelection();
  }

  // ── 8-counts, loops & notes ─────────────────────────────────────────────
  function renderEights() {
    const el = $('#eights');
    const n = eightTotal();
    if (!n) {
      el.innerHTML = `<div class="eights-empty">Tap along to the beat and your ${eightWord()}s will appear here.</div>`;
      return;
    }
    let html = '';
    for (let i = 0; i < n; i++) {
      const cls = ['eight'];
      if (song.notes[i + 1]) cls.push('has-note');
      if (sel && i >= sel.from && i <= sel.to) cls.push('sel');
      html += `<button class="${cls.join(' ')}" data-i="${i}"><b>${i + 1}</b><small>${fmt(eightStart(i))}</small></button>`;
    }
    el.innerHTML = html;
    lastEight = lastBeat = undefined;
  }

  function renderSelection() {
    document.querySelectorAll('.eight').forEach((b) => {
      const i = +b.dataset.i;
      b.classList.toggle('sel', !!sel && i >= sel.from && i <= sel.to);
    });
    $('#extend').disabled = !sel;
    $('#loop').disabled = !sel;
    $('#loop').classList.toggle('on', looping);
    const box = $('#note-box');
    box.classList.toggle('hidden', !sel);
    if (sel) {
      const range = sel.to > sel.from ? ` (looping ${sel.from + 1}–${sel.to + 1})` : '';
      $('#note-label').textContent = `Notes for ${eightWord()} ${sel.from + 1}${range}`;
      $('#note').value = song.notes[sel.from + 1] || '';
    }
  }

  $('#eights').addEventListener('click', (e) => {
    const b = e.target.closest('.eight');
    if (!b) return;
    const i = +b.dataset.i;
    if (sel && sel.from === i && sel.to === i) {
      sel = null;
      looping = false;
    } else {
      sel = { from: i, to: i };
      seek(eightStart(i));
    }
    renderSelection();
  });

  $('#extend').addEventListener('click', () => {
    if (!sel) return;
    sel.to = Math.min(eightTotal() - 1, sel.to + 1);
    renderSelection();
  });

  $('#loop').addEventListener('click', () => {
    if (!sel) return;
    looping = !looping;
    if (looping) {
      const [s, e] = loopBounds();
      if (audio.currentTime < s || audio.currentTime >= e) seek(s);
    }
    renderSelection();
  });

  $('#note').addEventListener('input', (e) => {
    if (!sel) return;
    const key = sel.from + 1;
    const v = e.target.value;
    if (v.trim()) song.notes[key] = v; else delete song.notes[key];
    const chip = document.querySelector(`.eight[data-i="${sel.from}"]`);
    if (chip) chip.classList.toggle('has-note', !!v.trim());
    saveSoon();
  });

  // ── Live counter ────────────────────────────────────────────────────────
  $('#counts').innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="count">${i + 1}</div>`).join('');
  const countEls = [...document.querySelectorAll('.count')];

  function updateCounter(t) {
    const b = beatLen();
    const beat = b ? beatAt(t) : null;
    if (beat === lastBeat) return;
    lastBeat = beat;
    const label = $('#eight-label');
    if (beat === null) {
      label.textContent = 'find the beat ↓';
      countEls.forEach((c) => { c.classList.remove('lit'); c.classList.add('off'); });
      return;
    }
    countEls.forEach((c) => c.classList.remove('off'));
    if (beat < 0) {
      label.textContent = 'intro';
      countEls.forEach((c) => c.classList.remove('lit'));
      return;
    }
    const eight = Math.floor(beat / 8);
    label.textContent = `${eightWord()} ${eight + 1}`;
    countEls.forEach((c, i) => c.classList.toggle('lit', i === beat % 8));

    if (eight !== lastEight) {
      lastEight = eight;
      document.querySelectorAll('.eight.now').forEach((c) => c.classList.remove('now'));
      const chip = document.querySelector(`.eight[data-i="${eight}"]`);
      if (chip) chip.classList.add('now');
    }
  }

  // ── Waveform ────────────────────────────────────────────────────────────
  const canvas = $('#wave');
  const g = canvas.getContext('2d');

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = { wave: v('--wave'), past: v('--wave-past'), text: v('--text'), muted: v('--muted'), accent: v('--accent'), line: v('--line') };
  }

  function draw(t) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);

    const pps = w / WINDOW_SECS;
    const x0 = w * PLAYHEAD_AT;
    const tStart = t - x0 / pps;
    const tEnd = tStart + WINDOW_SECS;
    const X = (time) => (time - tStart) * pps;
    const b = beatLen();

    // Selected / looping region
    if (sel && b) {
      g.globalAlpha = looping ? 0.22 : 0.1;
      g.fillStyle = colors.accent;
      const a = X(eightStart(sel.from)), z = X(eightStart(sel.to + 1));
      g.fillRect(a, 0, z - a, h);
      g.globalAlpha = 1;
    }

    // Beat grid: strong line + number on every "1"
    if (b) {
      g.font = `600 ${11 * dpr}px Inter, system-ui, sans-serif`;
      for (let i = Math.ceil((tStart - song.offset) / b); song.offset + i * b < tEnd; i++) {
        const x = X(song.offset + i * b);
        if (i % 8 === 0) {
          g.fillStyle = colors.accent;
          g.globalAlpha = i < 0 ? 0.3 : 0.9;
          g.fillRect(x - dpr / 2, 0, dpr * 1.5, h);
          if (i >= 0) g.fillText(String(i / 8 + 1), x + 4 * dpr, 13 * dpr);
        } else {
          g.fillStyle = colors.muted;
          g.globalAlpha = 0.35;
          const tick = i % 2 === 0 ? 0.18 : 0.1;
          g.fillRect(x - dpr / 2, 0, dpr, h * tick);
          g.fillRect(x - dpr / 2, h * (1 - tick), dpr, h * tick);
        }
      }
      g.globalAlpha = 1;
    }

    // Peaks
    const peaks = song.peaks;
    const barW = 2 * dpr, stepPx = 3 * dpr;
    const span = Math.max(1, Math.round((stepPx / pps) * PEAK_RATE));
    for (let x = 0; x < w; x += stepPx) {
      const time = tStart + x / pps;
      const idx = Math.floor(time * PEAK_RATE);
      if (idx < 0 || idx >= peaks.length) continue;
      let m = 0;
      for (let k = idx; k < idx + span && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
      const bh = Math.max(2 * dpr, m * h * 0.72);
      g.fillStyle = time < t ? colors.past : colors.wave;
      g.fillRect(x, (h - bh) / 2, barW, bh);
    }

    // Playhead
    g.fillStyle = colors.text;
    g.fillRect(x0 - dpr, 0, 2 * dpr, h);
  }

  // Swipe the waveform to scrub
  const wrap = $('.wave-wrap');
  wrap.addEventListener('pointerdown', (e) => {
    if (!song) return;
    wrap.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, t0: audio.currentTime, t: audio.currentTime, wasPlaying: !audio.paused, moved: false };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4 && !drag.moved) { drag.moved = true; audio.pause(); }
    if (drag.moved) drag.t = clamp(drag.t0 - dx / (wrap.clientWidth / WINDOW_SECS), 0, song.duration - 0.05);
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) {
      seek(drag.t);
      if (drag.wasPlaying) play();
    }
    drag = null;
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // ── Mirror & takes ──────────────────────────────────────────────────────
  // The camera records video only: turning the mic on makes iPhones play music
  // quietly through the earpiece. When she watches a take, the app plays the
  // song in sync instead, so the music is always clean.
  const cam = $('#cam');
  const RATES = [0.5, 0.75, 0.9, 1];
  const READY_SECS = [0, 5, 10];
  let mirrorOpen = false, camStream = null, facing = 'user', wakeLock = null;
  let armed = null;       // waiting to record: { start, phase: 'ready' | 'countin' | 'preroll' }
  let take = null;        // recording in progress
  let viewing = null;     // take being watched
  let readySecs = parseInt(store.get('readySecs') ?? '5', 10);
  if (!READY_SECS.includes(readySecs)) readySecs = 5;

  $('#m-counts').innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="mcount">${i + 1}</div>`).join('');
  const mCountEls = [...document.querySelectorAll('#m-counts .mcount')];
  let mLastBeat;

  function mirrorMsg(html) {
    $('#m-msg').innerHTML = html || '';
    $('#m-msg').classList.toggle('hidden', !html);
  }

  async function startCam() {
    stopCam();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      mirrorMsg("This browser can't use the camera.<small>Open May's Studio in Safari.</small>");
      return false;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      mirrorMsg('The camera is turned off for this app.<small>Allow it in the Settings app under Safari → Camera, then open the mirror again.</small>');
      return false;
    }
    if (!mirrorOpen) { stopCam(); return false; }   // closed while the permission prompt was up
    cam.srcObject = camStream;
    cam.classList.toggle('mirrored', facing === 'user');
    cam.play().catch(() => {});
    mirrorMsg('');
    return true;
  }

  function stopCam() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    cam.srcObject = null;
  }

  async function openMirror() {
    if (!song) return;
    mirrorOpen = true;
    store.set('mirrorSeen', '1');
    $('#mirror-new').classList.add('hidden');
    $('#mirror').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    mLastBeat = undefined;
    renderMirrorBar();
    refreshTakeCount();
    try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch { wakeLock = null; }
    await startCam();
  }

  function closeMirror() {
    if (!mirrorOpen) return;
    if (take) stopTake();
    disarm();
    mirrorOpen = false;
    stopCam();
    $('#mirror').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // Where a take starts: the selected 8-count, else the start of the current one
  function takeStart() {
    if (sel && beatLen()) return eightStart(sel.from);
    const t = audio.currentTime;
    if (beatLen() && beatAt(t) >= 0) return eightStart(Math.floor(beatAt(t) / 8));
    return t;
  }

  function sectionText(from, to) {
    const w = eightWord();
    return to > from ? `${w}s ${from + 1}–${to + 1}` : `${w} ${from + 1}`;
  }

  function renderMirrorBar() {
    $('#m-info').textContent = sel && beatLen()
      ? `Records ${sectionText(sel.from, sel.to)}, then stops by itself`
      : 'Records from here until you tap stop';
    $('#m-speed').textContent = `${audio.playbackRate}×`;
    $('#m-ready').textContent = readySecs ? `⏱ ${readySecs}s` : '⏱ off';
    $('#m-play').textContent = audio.paused ? '▶' : '❚❚';
  }

  function updateMirror(t) {
    const b = beatLen();
    if (armed && armed.phase === 'preroll' && b) {
      // The music is already playing: count her in on the 4 beats before the "1"
      if (t >= armed.start - 0.02) beginRecording();
      else showCountIn(String(clamp(8 - Math.ceil((armed.start - t) / b - 1e-3) + 1, 5, 8)), '', 'count');
    }
    if (take) $('#m-rectime span').textContent = fmt((performance.now() - take.t0) / 1000);

    const beat = b ? beatAt(t) : null;
    if (beat === mLastBeat) return;
    mLastBeat = beat;
    $('#m-counts').classList.toggle('off', beat === null);
    if (beat === null) {
      $('#m-label').textContent = 'set the beat on the song page to see counts';
      return;
    }
    $('#m-label').textContent = beat < 0 ? 'intro' : `${eightWord()} ${Math.floor(beat / 8) + 1}`;
    mCountEls.forEach((c, i) => c.classList.toggle('lit', beat >= 0 && i === beat % 8));
  }

  let lastCountIn = '';
  function showCountIn(big, small, cls) {
    const key = big + small;
    if (key === lastCountIn) return;
    lastCountIn = key;
    const el = $('#m-countin');
    el.className = 'm-countin';
    void el.offsetWidth;   // restart the pop animation
    el.className = `m-countin ${cls} pop`;
    el.innerHTML = `<b>${big}</b>${small ? `<small>${small}</small>` : ''}`;
  }
  function hideCountIn() { lastCountIn = ''; $('#m-countin').className = 'm-countin hidden'; }

  // Cancellable pause used while counting down
  let waitTimer = null, waitDone = null;
  const wait = (ms) => new Promise((resolve) => {
    waitDone = resolve;
    waitTimer = setTimeout(() => { waitDone = null; resolve(!!armed); }, ms);
  });

  function disarm() {
    clearTimeout(waitTimer);
    if (waitDone) { waitDone(false); waitDone = null; }
    if (armed && armed.phase === 'preroll') audio.pause();
    armed = null;
    hideCountIn();
    $('#mirror').classList.remove('arming');
  }

  const pickMime = () => ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';

  async function armTake() {
    if (take || armed) return;
    if (!camStream) return toast('The camera needs to be on to record');
    if (!window.MediaRecorder) return toast("This iPhone can't record here yet. Updating iOS should fix it.");
    const start = takeStart();
    audio.pause();
    seek(start);
    armed = { start, phase: 'ready' };
    $('#mirror').classList.add('arming');
    for (let s = readySecs; s > 0; s--) {
      showCountIn('Get in place', String(s), 'ready');
      if (!(await wait(1000))) return;
    }
    const b = beatLen();
    if (b && start - 4 * b >= 0) {
      // Start the music 4 beats early so the 5-6-7-8 is the real music
      armed.phase = 'preroll';
      seek(start - 4 * b);
      await startMusic();
      return;   // updateMirror() starts the recording on the "1"
    }
    armed.phase = 'countin';
    const beatMs = b ? (b / audio.playbackRate) * 1000 : 1000;
    for (const w of b ? ['5', '6', '7', '8'] : ['3', '2', '1']) {
      showCountIn(w, '', 'count');
      if (!(await wait(beatMs))) return;
    }
    if (!(await startMusic())) return;
    beginRecording();
  }

  async function startMusic() {
    audio.muted = false;
    try {
      await audio.play();
      return !!armed;
    } catch (e) {
      disarm();
      renderMirrorBar();
      toast('The music didn’t start. Tap ▶ once, then try again.');
      return false;
    }
  }

  function beginRecording() {
    if (!armed || !camStream) return;
    hideCountIn();
    const mime = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      disarm();
      audio.pause();
      return toast("Couldn't start recording");
    }
    const chunks = [];
    take = {
      recorder, chunks, songId: song.id, mime: recorder.mimeType || mime || 'video/mp4',
      rate: audio.playbackRate, from: sel ? sel.from : null, to: sel ? sel.to : null,
      mirrored: facing === 'user', t0: performance.now(), songAt0: songTime(),
    };
    armed = null;
    $('#mirror').classList.remove('arming');
    $('#mirror').classList.add('recording');
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstart = () => { if (take && take.recorder === recorder) { take.t0 = performance.now(); take.songAt0 = songTime(); } };
    recorder.start(1000);
  }

  function stopTake() {
    if (!take) return;
    const t = take;
    take = null;
    t.duration = (performance.now() - t.t0) / 1000;
    $('#mirror').classList.remove('recording');
    audio.pause();
    renderMirrorBar();
    t.recorder.onstop = async () => {
      const blob = new Blob(t.chunks, { type: t.mime.split(';')[0] });
      if (!blob.size || t.duration < 0.5) return toast("That take was too short to save");
      const n = (await DB.takesFor(t.songId)).reduce((m, x) => Math.max(m, x.n), 0) + 1;
      await DB.putTake({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        songId: t.songId, n, blob, mime: blob.type, songAt0: t.songAt0, rate: t.rate,
        from: t.from, to: t.to, mirrored: t.mirrored, duration: t.duration, added: Date.now(),
      });
      toast(`Take ${n} saved`);
      refreshTakeCount();
    };
    if (t.recorder.state !== 'inactive') t.recorder.stop();
  }

  $('#open-mirror').addEventListener('click', openMirror);
  $('#m-close').addEventListener('click', closeMirror);
  $('#m-flip').addEventListener('click', () => {
    if (take || armed) return;
    facing = facing === 'user' ? 'environment' : 'user';
    startCam();
  });
  // iPhones only let audio start from a tap. The music for a take starts after
  // the countdown, so "unlock" it by starting it silently during the tap itself.
  function unlockAudio() {
    if (!audio.paused) return;
    audio.muted = true;
    const p = audio.play();
    const unmute = () => { audio.muted = false; };
    if (p && p.then) p.then(unmute, unmute); else unmute();
  }

  $('#m-rec').addEventListener('click', () => {
    if (take) stopTake();
    else if (armed) { disarm(); audio.pause(); renderMirrorBar(); }
    else { unlockAudio(); armTake(); }
  });
  $('#m-play').addEventListener('click', () => {
    if (take || armed) return;
    audio.paused ? play() : audio.pause();
  });
  $('#m-speed').addEventListener('click', () => {
    setRate(RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length]);
    renderMirrorBar();
  });
  $('#m-ready').addEventListener('click', () => {
    readySecs = READY_SECS[(READY_SECS.indexOf(readySecs) + 1) % READY_SECS.length];
    store.set('readySecs', String(readySecs));
    renderMirrorBar();
  });
  audio.addEventListener('play', () => mirrorOpen && renderMirrorBar());
  audio.addEventListener('pause', () => mirrorOpen && renderMirrorBar());

  document.addEventListener('visibilitychange', () => {
    if (!mirrorOpen) return;
    if (document.hidden) {
      // iOS turns the camera off in the background; save what we have
      if (take) stopTake();
      disarm();
      stopCam();
    } else {
      startCam();
    }
  });

  // Takes list
  async function refreshTakeCount() {
    if (!song) return;
    const n = (await DB.takesFor(song.id)).length;
    $('#m-takes-n').textContent = n || '';
    $('#takes-n').textContent = n || '';
  }

  let takesShown = [];
  async function openTakes() {
    if (!song) return;
    const list = (await DB.takesFor(song.id)).sort((a, b) => b.added - a.added);
    takesShown = list;
    $('#takes-list').innerHTML = list.length ? list.map((t) => {
      const what = t.from !== null && t.from !== undefined ? sectionText(t.from, t.to) : `from ${fmt(t.songAt0)}`;
      const when = new Date(t.added).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `<div class="take" data-id="${t.id}">
        <button class="take-play" data-act="play" aria-label="Watch take ${t.n}">▶</button>
        <div class="take-body"><b>Take ${t.n}</b><small>${esc(what)} · ${t.rate}× · ${fmt(t.duration)} · ${esc(when)}</small></div>
        <button class="icon-btn" data-act="save" aria-label="Save take ${t.n}">⤓</button>
        <button class="icon-btn" data-act="del" aria-label="Delete take ${t.n}">✕</button>
      </div>`;
    }).join('') : '<p class="takes-empty">No takes yet. Open the mirror and tap the red button to record one.</p>';
    $('#takes').classList.remove('hidden');
  }

  $('#open-takes').addEventListener('click', openTakes);
  $('#m-takes').addEventListener('click', () => { if (!take && !armed) openTakes(); });
  $('#takes-close').addEventListener('click', () => $('#takes').classList.add('hidden'));
  $('#takes-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.take').dataset.id;
    // No awaiting before play/share: iPhones need them to happen right in the tap
    const t = takesShown.find((x) => x.id === id);
    if (!t) return;
    if (btn.dataset.act === 'play') openTakeView(t);
    if (btn.dataset.act === 'save') saveTakeFile(t);
    if (btn.dataset.act === 'del' && confirm(`Delete take ${t.n}?`)) {
      await DB.delTake(t.id);
      refreshTakeCount();
      openTakes();
    }
  });

  async function saveTakeFile(t) {
    const ext = t.mime.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([t.blob], `${song.name} - take ${t.n}.${ext}`, { type: t.mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { /* she closed the share sheet */ }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Watching a take, with the song playing in sync
  const takeVideo = $('#take-video');
  const takeAudio = new Audio();
  takeAudio.preload = 'auto';
  let viewURL = null;

  function openTakeView(t) {
    viewing = t;
    audio.pause();
    viewURL = URL.createObjectURL(t.blob);
    takeVideo.src = viewURL;
    takeVideo.classList.toggle('mirrored', !!t.mirrored);
    takeAudio.src = objectURL;
    takeAudio.defaultPlaybackRate = takeAudio.playbackRate = t.rate;
    takeAudio.preservesPitch = takeAudio.webkitPreservesPitch = true;
    $('#tv-title').textContent = `Take ${t.n}`;
    $('#tv-count').textContent = '';
    $('#take-view').classList.remove('hidden');
    compareStart(t);
    // Start both inside the tap so iOS allows the sound
    takeAudio.currentTime = t.songAt0;
    takeVideo.play().catch(() => {});
    takeAudio.play().catch(() => {});
  }

  function closeTakeView() {
    if (!viewing) return;
    viewing = null;
    takeVideo.pause();
    takeAudio.pause();
    takeVideo.removeAttribute('src');
    takeVideo.load();
    URL.revokeObjectURL(viewURL);
    compareStop();
    $('#take-view').classList.add('hidden');
  }

  function tickTakeView() {
    const v = takeVideo;
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : viewing.duration;
    $('#tv-play').textContent = v.paused ? '▶' : '❚❚';
    $('#tv-time').textContent = fmt(v.currentTime);
    if (!seekingTake) $('#tv-seek').value = String(Math.round((v.currentTime / dur) * 1000) || 0);
    const target = takeTarget();
    if (v.paused || v.ended) {
      if (!takeAudio.paused) takeAudio.pause();
    } else if (takeAudio.paused) {
      takeAudio.currentTime = target;
      takeAudio.play().catch(() => {});
    } else if (Math.abs(takeAudio.currentTime - target) > 0.25) {
      takeAudio.currentTime = target;
    }
    tickCompare(target, !v.paused && !v.ended);
    if (beatLen()) {
      const beat = beatAt(target);
      $('#tv-count').textContent = beat >= 0 ? `${eightWord()} ${Math.floor(beat / 8) + 1} · ${(beat % 8) + 1}` : 'intro';
    }
  }

  // Keep the music locked to the video even if the frame loop is paused
  const takeTarget = () => viewing.songAt0 + takeVideo.currentTime * viewing.rate;
  ['pause', 'ended', 'waiting'].forEach((ev) => takeVideo.addEventListener(ev, () => { takeAudio.pause(); tvRef.pause(); }));
  ['playing', 'seeked'].forEach((ev) => takeVideo.addEventListener(ev, () => {
    if (!viewing) return;
    takeAudio.currentTime = takeTarget();
    if (!takeVideo.paused) takeAudio.play().catch(() => {});
  }));

  let seekingTake = false;
  $('#tv-close').addEventListener('click', closeTakeView);
  $('#tv-flip').addEventListener('click', () => takeVideo.classList.toggle('mirrored'));
  $('#tv-play').addEventListener('click', () => {
    if (takeVideo.ended) takeVideo.currentTime = 0;
    if (takeVideo.paused) { takeVideo.play().catch(() => {}); takeAudio.play().catch(() => {}); }
    else takeVideo.pause();
  });
  takeVideo.addEventListener('click', () => $('#tv-play').click());
  $('#tv-seek').addEventListener('input', (e) => {
    seekingTake = true;
    const dur = isFinite(takeVideo.duration) && takeVideo.duration > 0 ? takeVideo.duration : viewing.duration;
    takeVideo.currentTime = (e.target.value / 1000) * dur;
    takeAudio.currentTime = takeTarget();
  });
  $('#tv-seek').addEventListener('change', () => (seekingTake = false));

  // ── Learn mode: go through a choreo video count by count ────────────────
  // The video keeps its own sound. Its counts use the song's BPM, starting from
  // the "1" she marks in the video (song.refOffset, in video seconds).
  const refVideo = $('#ref-video');
  const lCam = $('#l-cam');
  const L_RATES = [0.25, 0.5, 0.75, 1];
  let ref = null;             // { songId, blob, name } for the open song
  let refURL = null;
  let learnOpen = false, lCamStream = null, lWake = null;
  let stepUntil = null;       // video time to freeze at after "count ▶"
  let lLoop = null;           // [start, end] of the 8-count being looped
  let lSeeking = false, lLastBeat;
  $('#l-counts').innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="mcount">${i + 1}</div>`).join('');
  const lCountEls = [...document.querySelectorAll('#l-counts .mcount')];

  const hasOne = () => !!song && song.refOffset !== null && song.refOffset !== undefined;
  const vBeatAt = (vt) => Math.floor((vt - song.refOffset) / beatLen() + 1e-4);
  // Start of count k in the video; without a beat grid, steps are half a second
  const vCountStart = (k) => (beatLen() && hasOne() ? song.refOffset + k * beatLen() : k * 0.5);
  const vCountAt = (vt) => (beatLen() && hasOne() ? vBeatAt(vt) : Math.floor(vt / 0.5 + 1e-4));

  async function loadRef() {
    const id = song && song.id;
    const r = id ? await DB.getRef(id) : null;
    if (!song || song.id !== id) return;   // she switched songs meanwhile
    ref = r || null;
    $('#learn-empty').classList.toggle('hidden', !!ref);
    $('#learn-has').classList.toggle('hidden', !ref);
    $('#ref-name').textContent = ref ? ref.name : '';
    $('#learn-new').classList.toggle('hidden', !!store.get('learnSeen'));
  }

  async function addRef(f) {
    if (!f || !song) return;
    if (!(f.type || '').startsWith('video/') && !/\.(mov|mp4|m4v|webm)$/i.test(f.name)) return toast('That isn’t a video file');
    toast('Saving the video…');
    try {
      // slice() keeps it as a file reference instead of loading it all into memory
      await DB.putRef({ songId: song.id, blob: f.slice(0, f.size, f.type || 'video/mp4'), name: f.name.replace(/\.[^.]+$/, ''), added: Date.now() });
    } catch (e) {
      return toast('Not enough space on your phone for this video');
    }
    song.refOffset = null;   // a new video needs its own "1"
    saveSoon();
    await loadRef();
    toast('Choreo video added');
  }
  ['#ref-input', '#ref-replace'].forEach((sel) => $(sel).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    addRef(f);
  }));
  $('#ref-remove').addEventListener('click', async () => {
    if (!song || !confirm('Remove the choreo video from this song?')) return;
    await DB.delRef(song.id);
    song.refOffset = null;
    saveSoon();
    loadRef();
  });

  function learnMsg(html) {
    $('#l-msg').innerHTML = html || '';
    $('#l-msg').classList.toggle('hidden', !html);
  }
  function learnHint() {
    if (!beatLen()) learnMsg('Find the beat on the song page first (play it and tap along), so the video can be counted. Until then, the step buttons move half a second.');
    else if (!hasOne()) learnMsg('Play or scrub to the very first move of the dance, pause, then tap <b>Set “1”</b>.');
    else learnMsg('');
  }
  $('#l-msg').addEventListener('click', () => learnMsg(''));

  function setLRate(r) {
    refVideo.playbackRate = r;
    refVideo.defaultPlaybackRate = r;
    refVideo.preservesPitch = refVideo.webkitPreservesPitch = true;
    document.querySelectorAll('[data-lrate]').forEach((b) => b.classList.toggle('on', +b.dataset.lrate === r));
  }

  async function openLearn() {
    if (!ref || !song) return;
    store.set('learnSeen', '1');
    $('#learn-new').classList.add('hidden');
    audio.pause();
    learnOpen = true;
    refURL = URL.createObjectURL(ref.blob);
    refVideo.src = refURL;
    refVideo.classList.toggle('mirrored', !!song.refMirrored);
    $('#l-flip').classList.toggle('on', !!song.refMirrored);
    setLRate(1);
    stepUntil = null;
    lLoop = null;
    lLastBeat = undefined;
    $('#l-loop').classList.remove('on');
    $('#learn').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    learnHint();
    try { lWake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch { lWake = null; }
  }

  function closeLearn() {
    if (!learnOpen) return;
    learnOpen = false;
    refVideo.pause();
    stopLCam();
    refVideo.removeAttribute('src');
    refVideo.load();
    if (refURL) URL.revokeObjectURL(refURL);
    refURL = null;
    $('#learn').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (lWake) { lWake.release().catch(() => {}); lWake = null; }
  }

  // "count ▶": play to the end of this count, then freeze on the pose
  function stepNext() {
    const vt = refVideo.currentTime;
    const dur = refVideo.duration || Infinity;
    let target = vCountStart(vCountAt(vt) + 1);
    if (target - vt < 0.05) target = vCountStart(vCountAt(vt) + 2);
    if (target > dur - 0.05) target = dur - 0.05;
    if (target <= vt) return;
    stepUntil = target;
    refVideo.play().catch(() => {});
    // Backup in case animation frames stutter: freeze on time regardless
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => freezeStep(target), ((target - vt) / refVideo.playbackRate) * 1000 + 60);
  }
  let stepTimer = null;
  function freezeStep(target) {
    if (stepUntil !== target) return;
    refVideo.pause();
    refVideo.currentTime = target + 0.02;   // just inside the count, so the frame shows its pose
    stepUntil = null;
  }
  // "◀ count": back to the start of the previous count (so ▶ replays it)
  function stepPrev() {
    stepUntil = null;
    refVideo.pause();
    const vt = refVideo.currentTime;
    let target = vCountStart(vCountAt(vt));
    if (vt - target < 0.15) target = vCountStart(vCountAt(vt) - 1);
    refVideo.currentTime = Math.max(0, target);
  }

  function tickLearn() {
    const v = refVideo;
    const vt = v.currentTime;
    if (stepUntil !== null && !v.paused && vt >= stepUntil - 0.03) freezeStep(stepUntil);
    if (lLoop && !v.paused && stepUntil === null && (vt >= lLoop[1] - 0.03 || vt < lLoop[0] - 0.3)) v.currentTime = lLoop[0];
    $('#l-play').textContent = v.paused ? '▶' : '❚❚';
    const dur = v.duration;
    if (!lSeeking && isFinite(dur) && dur > 0) $('#l-seek').value = String(Math.round((vt / dur) * 1000));

    const beat = beatLen() && hasOne() ? vBeatAt(vt) : null;
    if (beat === lLastBeat) return;
    lLastBeat = beat;
    $('#l-counts').classList.toggle('off', beat === null || beat < 0);
    if (beat === null) {
      $('#l-label').textContent = beatLen() ? 'tap Set “1” on the first move' : 'set the beat on the song page';
      $('#l-big').textContent = '';
    } else if (beat < 0) {
      $('#l-label').textContent = 'before the dance';
      $('#l-big').textContent = '';
    } else {
      $('#l-label').textContent = `${eightWord()} ${Math.floor(beat / 8) + 1}`;
      $('#l-big').textContent = String((beat % 8) + 1);
      lCountEls.forEach((c, i) => c.classList.toggle('lit', i === beat % 8));
    }
  }

  async function startLCam() {
    stopLCam();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast("This browser can't use the camera");
    try {
      lCamStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      $('#l-me').classList.remove('on');
      return toast('The camera is off for this app. Allow it in Settings → Safari → Camera.');
    }
    if (!learnOpen || !$('#l-me').classList.contains('on')) return stopLCam();
    lCam.srcObject = lCamStream;
    lCam.play().catch(() => {});
    $('#l-cam-pane').classList.remove('hidden');
  }
  function stopLCam() {
    if (lCamStream) lCamStream.getTracks().forEach((t) => t.stop());
    lCamStream = null;
    lCam.srcObject = null;
    $('#l-cam-pane').classList.add('hidden');
  }

  $('#open-learn').addEventListener('click', openLearn);
  $('#l-close').addEventListener('click', closeLearn);
  $('#l-play').addEventListener('click', () => {
    stepUntil = null;
    if (refVideo.paused) refVideo.play().catch(() => {}); else refVideo.pause();
  });
  $('#l-next').addEventListener('click', stepNext);
  $('#l-prev').addEventListener('click', stepPrev);
  document.querySelectorAll('[data-lrate]').forEach((b) => b.addEventListener('click', () => setLRate(+b.dataset.lrate)));
  $('#l-flip').addEventListener('click', () => {
    song.refMirrored = !song.refMirrored;
    refVideo.classList.toggle('mirrored', song.refMirrored);
    $('#l-flip').classList.toggle('on', song.refMirrored);
    saveSoon();
  });
  $('#l-me').addEventListener('click', () => {
    const on = !$('#l-me').classList.contains('on');
    $('#l-me').classList.toggle('on', on);
    if (on) startLCam(); else stopLCam();
  });
  $('#l-one').addEventListener('click', () => {
    if (!beatLen()) return toast('Find the beat on the song page first');
    refVideo.pause();
    stepUntil = null;
    song.refOffset = refVideo.currentTime;
    saveSoon();
    lLastBeat = undefined;
    lLoop = null;
    $('#l-loop').classList.remove('on');
    learnHint();
    toast('Got it, counting starts here');
  });
  $('#l-loop').addEventListener('click', () => {
    if (lLoop) { lLoop = null; $('#l-loop').classList.remove('on'); return; }
    if (!beatLen() || !hasOne()) return toast('Tap Set “1” on the first move first');
    const eight = Math.max(0, Math.floor(vBeatAt(refVideo.currentTime) / 8));
    // The last 8-count can run past the end of the video
    lLoop = [vCountStart(eight * 8), Math.min(vCountStart(eight * 8 + 8), (refVideo.duration || Infinity) - 0.08)];
    $('#l-loop').classList.add('on');
    stepUntil = null;
    refVideo.currentTime = lLoop[0];
    refVideo.play().catch(() => {});
  });
  $('#l-seek').addEventListener('input', (e) => {
    lSeeking = true;
    stepUntil = null;
    if (isFinite(refVideo.duration)) refVideo.currentTime = (e.target.value / 1000) * refVideo.duration;
  });
  $('#l-seek').addEventListener('change', () => (lSeeking = false));
  // Refresh the count display on pauses & jumps too, not just animation frames
  ['pause', 'seeked'].forEach((ev) => refVideo.addEventListener(ev, () => learnOpen && tickLearn()));
  refVideo.addEventListener('ended', () => {
    stepUntil = null;
    if (lLoop) { refVideo.currentTime = lLoop[0]; refVideo.play().catch(() => {}); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!learnOpen) return;
    if (document.hidden) { refVideo.pause(); stopLCam(); }
    else if ($('#l-me').classList.contains('on')) startLCam();
  });

  // ── Comparing a take with the choreo video ──────────────────────────────
  const tvRef = $('#tv-ref');
  let compareOn = store.get('compareOn') === '1';
  let compareURL = null;
  const canCompare = () => !!ref && !!beatLen() && hasOne();

  function setCompare(on, remember = true) {
    compareOn = on;
    if (remember) store.set('compareOn', on ? '1' : '0');
    $('#tv-compare').classList.toggle('on', on);
    $('.tv-ref').classList.toggle('hidden', !on);
    $('.tv-you').classList.toggle('hidden', !on);
    if (on && !compareURL) {
      compareURL = URL.createObjectURL(ref.blob);
      tvRef.src = compareURL;
      tvRef.classList.toggle('mirrored', !!song.refMirrored);
    }
    if (!on) tvRef.pause();
  }
  function compareStart(t) {
    $('#tv-compare').classList.toggle('hidden', !ref);
    if (ref && canCompare()) {
      tvRef.playbackRate = tvRef.defaultPlaybackRate = t.rate;
      setCompare(store.get('compareOn') === '1', false);
    } else {
      setCompare(false, false);
    }
  }
  function compareStop() {
    tvRef.pause();
    tvRef.removeAttribute('src');
    tvRef.load();
    if (compareURL) URL.revokeObjectURL(compareURL);
    compareURL = null;
    $('.tv-ref').classList.add('hidden');
    $('.tv-you').classList.add('hidden');
  }
  // Keep the choreo video on the same count as the take
  function tickCompare(songT, playing) {
    if (!compareOn || !compareURL) return;
    const target = song.refOffset + (songT - song.offset);
    const dur = tvRef.duration;
    if (!playing || target < 0 || (isFinite(dur) && target > dur)) {
      if (!tvRef.paused) tvRef.pause();
      // While paused, show the matching pose (without re-seeking every frame)
      if (!playing && Math.abs(tvRef.currentTime - Math.max(0, target)) > 0.05) tvRef.currentTime = Math.max(0, target);
      return;
    }
    if (Math.abs(tvRef.currentTime - target) > 0.15) tvRef.currentTime = target;
    if (tvRef.paused) tvRef.play().catch(() => {});
  }
  $('#tv-compare').addEventListener('click', () => {
    if (!canCompare()) return toast('Open Learn mode and tap Set “1” on the first move first');
    setCompare(!compareOn);
  });

  // ── Practice tips & what's new ──────────────────────────────────────────
  const openTips = () => $('#tips').classList.remove('hidden');
  const hideWhatsNew = () => { $('#whatsnew').classList.add('hidden'); store.set('wnLearn', '1'); };
  $('#tips-btn').addEventListener('click', openTips);
  $('#tips-close').addEventListener('click', () => $('#tips').classList.add('hidden'));
  $('#wn-tips').addEventListener('click', () => { hideWhatsNew(); openTips(); });
  $('#wn-close').addEventListener('click', hideWhatsNew);

  // ── Frame loop ──────────────────────────────────────────────────────────
  function frame() {
    if (song && $('#view-player').classList.contains('active')) {
      let t = drag && drag.moved ? drag.t : songTime();
      if (take && sel && beatLen() && t >= loopBounds()[1] - 0.01) {
        // A take records one run-through of the selected section, then stops by itself
        stopTake();
      } else if (looping && sel && beatLen() && !drag && !armed) {
        const [s, e] = loopBounds();
        if (t >= e - 0.01 || t < s - 0.3) { seek(s); t = s; }
      }
      draw(t);
      updateCounter(t);
      $('#t-now').textContent = fmt(t);
      if (mirrorOpen) updateMirror(t);
    }
    if (viewing) tickTakeView();
    if (learnOpen) tickLearn();
    requestAnimationFrame(frame);
  }

  // ── Style toggle ────────────────────────────────────────────────────────
  function setMode(m) {
    document.documentElement.dataset.mode = m;
    store.set('mode', m);
    document.querySelector('meta[name="theme-color"]').content = m === 'hiphop' ? '#0b0b0c' : '#1b1420';
    readColors();
    if (song) { renderEights(); renderSelection(); lastBeat = undefined; }
  }
  $('#mode-toggle').addEventListener('click', () => setMode(isHipHop() ? 'contemporary' : 'hiphop'));

  // ── The secret: tap the heart three times ───────────────────────────────
  let heartTaps = 0, heartTimer;
  $('#heart').addEventListener('click', (e) => {
    const h = e.currentTarget;
    h.classList.add('beat');
    setTimeout(() => h.classList.remove('beat'), 180);
    heartTaps++;
    clearTimeout(heartTimer);
    heartTimer = setTimeout(() => (heartTaps = 0), 1500);
    if (heartTaps >= 3) { heartTaps = 0; openSoundtrack(); }
  });

  function openSoundtrack() {
    const st = window.SOUNDTRACK || { songs: [] };
    $('#st-content').innerHTML = `
      <div class="st-hero"><h1>${esc(st.title || 'Our Soundtrack')}</h1><p>${esc(st.intro)}</p></div>
      <div class="st-list">
        ${(st.songs || []).map((s, i) => `
          <article class="st-entry" style="animation-delay:${i * 90}ms">
            <div class="st-date">${esc(s.date)}</div>
            <div class="st-song">${esc(s.song)}</div>
            <div class="st-artist">${esc(s.artist)}</div>
            ${s.note ? `<p class="st-note">${esc(s.note)}</p>` : ''}
            ${s.photo ? `<img class="st-photo" src="${esc(s.photo)}" alt="" loading="lazy">` : ''}
            ${s.link ? `<a class="st-link" href="${esc(s.link)}" target="_blank" rel="noopener">▶ listen</a>` : ''}
          </article>`).join('')}
      </div>
      ${st.signoff ? `<p class="st-sign">${esc(st.signoff)}</p>` : ''}`;
    show('view-soundtrack');
  }
  $('#st-back').addEventListener('click', () => show('view-library'));

  // ── How-to tour (first launch, and the ? buttons) ───────────────────────
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const introSteps = () => [
    {
      art: `<img class="ia-icon" src="icons/icon-180.png" alt="">`,
      title: 'Hi May ♥',
      text: "This is your studio, a notebook for your choreography. Here's a quick tour.",
    },
    {
      art: `<span class="btn primary ia-mock">＋ Add a song</span>`,
      title: 'Add a song',
      text: 'Pick any song saved in your <b>Files</b> app (MP3, M4A or WAV). Tip: record class music with <b>Voice Memos</b>, then Share → Save to Files. Apple Music and Spotify songs are locked, so they won’t show up.',
    },
    {
      art: `<div class="ia-row ia-mock"><span class="btn primary ia-tap">TAP</span><span class="ia-bpm">95</span></div>`,
      title: 'Find the beat',
      text: 'Press play and tap <b>TAP</b> on every beat (4 taps is enough). The song splits into numbered 8-counts. If the count starts in the wrong place, press <b>Set “1” here</b> on the downbeat, then use <b>◀ ▶</b> to fine-tune.',
    },
    {
      art: `<div class="ia-counts ia-mock">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<div class="count" style="animation-delay:${(n - 1) * 0.5}s">${n}</div>`).join('')}</div>`,
      title: 'Follow the count',
      text: 'The big numbers light up 1 to 8 as the music plays. <b>Swipe the waveform</b> to scrub, and use <b>⏮ ⏭</b> to jump a whole 8-count.',
    },
    {
      art: `<div class="ia-row ia-mock"><span class="eight"><b>1</b></span><span class="eight sel"><b>2</b></span><span class="eight sel"><b>3</b></span><span class="btn small-btn on">⟲ Loop</span><span class="btn small-btn">0.5×</span></div>`,
      title: 'Drill the hard part',
      text: 'Tap an 8-count to jump there. <b>＋ next</b> makes the section longer and <b>⟲ Loop</b> repeats it. Slow it down to <b>0.5×</b> or <b>0.75×</b> and the pitch stays the same.',
    },
    {
      art: `<div class="ia-mirror ia-mock"><div class="mini">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<i style="animation-delay:${i * 0.5}s"></i>`).join('')}</div><span class="dot"></span></div>`,
      title: 'Dance in the mirror',
      text: 'Tap <b>Mirror & record</b> to see yourself with the counts on screen. Prop your phone up, tap the <b>red button</b>, get in place, and you’re counted in with a 5-6-7-8. Pick an 8-count first and it records just that part. Watch your takes back with the music, or save them to Photos.',
    },
    {
      art: `<div class="ia-learn ia-mock"><div><b>5</b></div><div></div><span class="ia-step">count ▶</span></div>`,
      title: 'Learn the choreo',
      text: 'Add a dance video under <b>Learn the choreo</b>. Pause on the first move and tap <b>Set “1”</b>, then <b>count ▶</b> plays one move at a time. Mirror it, slow it to ¼×, or tap <b>Me</b> to dance side by side with it.',
    },
    {
      art: `<div class="ia-note ia-mock"><small>Notes for ${eightWord()} 2</small>hit on 5, melt down 6-7, roll out on 8</div>`,
      title: 'Write it down',
      text: 'Every 8-count gets its own notes, and a little dot shows which ones have them. Everything saves by itself, right on your phone.',
    },
    {
      art: `<span class="pill ia-mock">${isHipHop() ? 'Hip Hop' : 'Contemporary'}</span>`,
      title: 'Make it yours',
      text: 'Switch between <b>Contemporary</b> and <b>Hip Hop</b> styles at the top whenever you like.' +
        (standalone ? '' : ' To keep it on your home screen, tap <b>Share</b> → <b>Add to Home Screen</b>.') +
        ' More ideas are in <b>✦ Practice tips</b> on the home screen.<br><br>P.S. little hearts like being tapped ♥',
    },
  ];
  let introAt = 0;

  function renderIntro() {
    const steps = introSteps();
    const s = steps[introAt];
    $('#intro-art').innerHTML = s.art;
    $('#intro-title').textContent = s.title;
    $('#intro-text').innerHTML = s.text;
    $('#intro-dots').innerHTML = steps.map((_, i) => `<span class="${i === introAt ? 'on' : ''}"></span>`).join('');
    $('#intro-prev').hidden = introAt === 0;
    $('#intro-next').textContent = introAt === steps.length - 1 ? "Let's dance" : 'Next';
    $('#intro-skip').hidden = introAt === steps.length - 1;
  }
  function openIntro() { introAt = 0; renderIntro(); $('#intro').classList.remove('hidden'); }
  function closeIntro() { $('#intro').classList.add('hidden'); store.set('introSeen', '1'); }
  function stepIntro(d) {
    const next = introAt + d;
    if (next >= introSteps().length) return closeIntro();
    introAt = clamp(next, 0, introSteps().length - 1);
    renderIntro();
  }
  $('#intro-next').addEventListener('click', () => stepIntro(1));
  $('#intro-prev').addEventListener('click', () => stepIntro(-1));
  $('#intro-skip').addEventListener('click', closeIntro);
  document.querySelectorAll('[data-help]').forEach((b) => b.addEventListener('click', openIntro));
  // Swipe left / right between steps
  let introX = null;
  $('.intro-card').addEventListener('pointerdown', (e) => (introX = e.clientX));
  $('.intro-card').addEventListener('pointerup', (e) => {
    if (introX === null) return;
    const dx = e.clientX - introX;
    introX = null;
    if (Math.abs(dx) > 50) stepIntro(dx < 0 ? 1 : -1);
  });

  // ── Practice beat (synthesised, so there's something to try instantly) ─
  function makePracticeBeat(bpm) {
    const sr = 22050, bars = 16, beat = 60 / bpm;
    const len = Math.ceil(sr * (bars * 4 * beat + 1));
    const out = new Float32Array(len);
    const add = (t0, dur, fn) => {
      const s0 = Math.floor(t0 * sr);
      for (let i = 0; i < dur * sr && s0 + i < len; i++) out[s0 + i] += fn(i / sr);
    };
    const kick = (t0) => { let ph = 0; add(t0, 0.35, (t) => { ph += (2 * Math.PI * (45 + 90 * Math.exp(-t * 30))) / sr; return Math.sin(ph) * Math.exp(-t * 9) * 0.9; }); };
    const snare = (t0) => add(t0, 0.25, (t) => ((Math.random() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18));
    let prev = 0;
    const hat = (t0, v) => add(t0, 0.06, (t) => { const n = Math.random() * 2 - 1; const hp = n - prev; prev = n; return hp * Math.exp(-t * 70) * v; });
    for (let bar = 0; bar < bars; bar++) {
      const b0 = bar * 4 * beat;
      kick(b0); kick(b0 + 1.5 * beat); kick(b0 + 2.5 * beat);
      snare(b0 + beat); snare(b0 + 3 * beat);
      for (let k = 0; k < 8; k++) hat(b0 + k * beat / 2, k % 2 ? 0.12 : 0.22);
    }
    // 16-bit mono WAV
    const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) v.setInt16(44 + i * 2, clamp(out[i], -1, 1) * 0x7fff, true);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  setMode(store.get('mode') || 'contemporary');
  renderLibrary();
  requestAnimationFrame(frame);
  if (!store.get('introSeen')) openIntro();
  if (!store.get('mirrorSeen')) $('#mirror-new').classList.remove('hidden');
  if (!store.get('introSeen')) store.set('wnLearn', '1');   // new users get the tour instead
  if (!store.get('wnLearn')) $('#whatsnew').classList.remove('hidden');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && song) DB.put(song); });
})();
