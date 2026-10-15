(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const PEAK_RATE = 100;      // waveform resolution: peaks per second
  const WINDOW_SECS = 6;      // seconds of music visible in the waveform
  const PLAYHEAD_AT = 0.3;    // playhead position (fraction of width)

  // ── Storage (IndexedDB: songs + their notes live on her phone) ──────────
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('mays-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
        req.onsuccess = () => resolve((this.db = req.result));
        req.onerror = () => reject(req.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('songs', mode);
        const req = fn(t.objectStore('songs'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    },
    all() { return this.tx('readonly', (s) => s.getAll()); },
    get(id) { return this.tx('readonly', (s) => s.get(id)); },
    put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
    del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
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
    show('view-player');
  }

  function closeSong() {
    audio.pause();
    if (song) DB.put(song);
    song = null;
    renderLibrary();
    show('view-library');
  }
  $('#back').addEventListener('click', closeSong);

  $('#delete-song').addEventListener('click', async () => {
    if (!song || !confirm(`Remove “${song.name}” and its notes?`)) return;
    audio.pause();
    await DB.del(song.id);
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

  // ── Frame loop ──────────────────────────────────────────────────────────
  function frame() {
    if (song && $('#view-player').classList.contains('active')) {
      let t = drag && drag.moved ? drag.t : songTime();
      if (looping && sel && beatLen() && !drag) {
        const [s, e] = loopBounds();
        if (t >= e - 0.01 || t < s - 0.3) { seek(s); t = s; }
      }
      draw(t);
      updateCounter(t);
      $('#t-now').textContent = fmt(t);
    }
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
      art: `<div class="ia-note ia-mock"><small>Notes for ${eightWord()} 2</small>hit on 5, melt down 6-7, roll out on 8</div>`,
      title: 'Write it down',
      text: 'Every 8-count gets its own notes, and a little dot shows which ones have them. Everything saves by itself, right on your phone.',
    },
    {
      art: `<span class="pill ia-mock">${isHipHop() ? 'Hip Hop' : 'Contemporary'}</span>`,
      title: 'Make it yours',
      text: 'Switch between <b>Contemporary</b> and <b>Hip Hop</b> styles at the top whenever you like.' +
        (standalone ? '' : ' To keep it on your home screen, tap <b>Share</b> → <b>Add to Home Screen</b>.') +
        '<br><br>P.S. little hearts like being tapped ♥',
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
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && song) DB.put(song); });
})();
