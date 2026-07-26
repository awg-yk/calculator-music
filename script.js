(() => {
  "use strict";

  const display = document.getElementById("display");
  const iconNote = document.getElementById("icon-note");

  const SOLFEGE = { C: "ド", D: "レ", E: "ミ", F: "ファ", G: "ソ", A: "ラ", B: "シ" };

  // The real unit is tuned to Db major, not C major: the note under "1" is
  // Db4, not C4. Every entry below (including the octave-shift range) is
  // shifted up a half step accordingly, so flats are first-class notes here.
  const NOTE_FREQ = {
    C3: 130.81, Db3: 138.59, D3: 146.83, Eb3: 155.56, E3: 164.81, F3: 174.61,
    Gb3: 185.0, G3: 196.0, Ab3: 207.65, A3: 220.0, Bb3: 233.08, B3: 246.94,
    C4: 261.63, Db4: 277.18, D4: 293.66, Eb4: 311.13, E4: 329.63, F4: 349.23,
    Gb4: 369.99, G4: 392.0, Ab4: 415.3, A4: 440.0, Bb4: 466.16, B4: 493.88,
    C5: 523.25, Db5: 554.37, D5: 587.33, Eb5: 622.25, E5: 659.25, F5: 698.46,
    Gb5: 739.99, G5: 783.99, Ab5: 830.61, A5: 880.0, Bb5: 932.33, B5: 987.77,
    C6: 1046.5, Db6: 1108.73, D6: 1174.66, Eb6: 1244.51, E6: 1318.51, F6: 1396.91,
    Gb6: 1479.98, G6: 1567.98, Ab6: 1661.22, A6: 1760.0, Bb6: 1864.66, B6: 1975.53,
  };

  const NOTE_RE = /^([A-G])(b?)(\d)$/;

  function noteLabel(note) {
    const [, letter, flat, octaveStr] = note.match(NOTE_RE);
    const octave = parseInt(octaveStr, 10);
    const sol = SOLFEGE[letter] + (flat ? "♭" : "");
    if (octave <= 3) return sol + "˛";
    if (octave === 5) return sol + "'";
    if (octave >= 6) return sol + "''";
    return sol;
  }

  // Add small solfège labels onto the note keys.
  document.querySelectorAll(".key[data-note]").forEach((btn) => {
    const label = document.createElement("span");
    label.className = "note-label";
    label.textContent = noteLabel(btn.dataset.note);
    btn.appendChild(label);
  });

  // ---------- Volume (5 discrete steps, shown on the LCD) ----------
  const VOLUME_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];
  let volumeIndex = 2;

  function renderVolume() {
    const level = volumeIndex + 1;
    display.textContent = "音量 " + "■".repeat(level) + "□".repeat(VOLUME_LEVELS.length - level);
  }

  function setVolume(index) {
    volumeIndex = Math.max(0, Math.min(VOLUME_LEVELS.length - 1, index));
    syncFilters();
    renderVolume();
  }

  renderVolume();

  // ---------- Audio ----------
  // Additive engine ported from the AR7778 tone workbench: odd harmonics
  // with amplitude 1/(n+1)^tilt, each one slowly amplitude-modulated at
  // n/2 * rate Hz (that wobble is what gives the tone its gritty, alive
  // character), then run through a fixed dip -> resonance -> lowpass chain
  // approximating the measured piezo response. Tone is fixed to the "blend"
  // preset - the tuning panel used to expose these as sliders.
  const TONE = { tilt: 1.15, depth: 0.85, rate: 1.0 };
  const FILTER_SETTINGS = { resF: 1450, resG: 5, lp: 3200, decayDb: 12 };

  let audioCtx = null;
  let dipFilter = null;
  let resFilter = null;
  let lpFilter = null;
  let masterGain = null;

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      dipFilter = audioCtx.createBiquadFilter();
      dipFilter.type = "peaking";
      dipFilter.frequency.value = 820;
      dipFilter.Q.value = 1.4;
      dipFilter.gain.value = -4;

      resFilter = audioCtx.createBiquadFilter();
      resFilter.type = "peaking";
      resFilter.Q.value = 1.6;

      lpFilter = audioCtx.createBiquadFilter();
      lpFilter.type = "lowpass";
      lpFilter.Q.value = 0.7;

      masterGain = audioCtx.createGain();

      dipFilter.connect(resFilter);
      resFilter.connect(lpFilter);
      lpFilter.connect(masterGain);
      masterGain.connect(audioCtx.destination);
      syncFilters();
      warmUpBuffers();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function syncFilters() {
    if (!audioCtx) return;
    resFilter.frequency.value = FILTER_SETTINGS.resF;
    resFilter.gain.value = FILTER_SETTINGS.resG;
    lpFilter.frequency.value = FILTER_SETTINGS.lp;
    masterGain.gain.value = VOLUME_LEVELS[volumeIndex];
  }

  let octaveShift = 0; // -1, 0, +1 semitone-octave shift, not currently exposed in the UI

  function shiftNote(note) {
    if (octaveShift === 0) return note;
    const [, letter, flat, octaveStr] = note.match(NOTE_RE);
    const octave = parseInt(octaveStr, 10) + octaveShift;
    const shifted = letter + flat + octave;
    return NOTE_FREQ[shifted] ? shifted : note;
  }

  // The workbench renders a one-shot buffer, but here a key can be held
  // indefinitely, so the buffer has to loop cleanly. Every partial and every
  // modulator frequency is snapped to a multiple of 1/BUFFER_SEC, which makes
  // the whole buffer exactly periodic over its own length - so looping it is
  // seamless. The snap moves pitches by well under a cent (inaudible).
  const BUFFER_SEC = 2;
  const MAX_PARTIAL_HZ = 12000;
  const bufferCache = new Map();

  function buildBuffer(ctx, freq) {
    const { tilt, depth, rate } = TONE;
    const key = `${freq}|${tilt}|${depth}|${rate}`;
    const cached = bufferCache.get(key);
    if (cached) return cached;

    const sr = ctx.sampleRate;
    const N = Math.round(BUFFER_SEC * sr);
    const buffer = ctx.createBuffer(1, N, sr);
    const data = buffer.getChannelData(0);
    const nyquist = Math.min(sr / 2 * 0.94, MAX_PARTIAL_HZ);
    const TWO_PI_OVER_N = (2 * Math.PI) / N;

    for (let n = 1; n * freq < nyquist; n += 2) {
      const amp = 1 / Math.pow(n + 1, tilt);
      // cycles-per-buffer for this partial and for its modulator, rounded to
      // integers so both close the loop exactly at the buffer boundary
      const kPartial = Math.max(1, Math.round(n * freq * BUFFER_SEC));
      const kMod = Math.round((n * rate / 2) * BUFFER_SEC);
      const wp = TWO_PI_OVER_N * kPartial;
      const wm = TWO_PI_OVER_N * kMod;
      for (let i = 0; i < N; i++) {
        data[i] += amp * Math.sin(wp * i) * (1 - depth + depth * Math.cos(wm * i));
      }
    }

    let peak = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    if (peak > 0) {
      const g = 0.92 / peak;
      for (let i = 0; i < N; i++) data[i] *= g;
    }

    if (bufferCache.size > 48) bufferCache.clear();
    bufferCache.set(key, buffer);
    return buffer;
  }

  // Active notes, keyed by the button element currently sounding it, so a
  // key can be held (sustained) and multiple keys can sound at once.
  const activeVoices = new Map();

  function startVoice(voiceId, note) {
    if (activeVoices.has(voiceId)) return;
    const ctx = getCtx();
    const actualNote = shiftNote(note);
    const freq = NOTE_FREQ[actualNote];
    if (!freq) return;

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buildBuffer(ctx, freq);
    src.loop = true;

    // Fast attack, then a decay toward the level implied by the "decay in dB
    // over 350ms" setting, which is where it stays for as long as the key is
    // held (the real unit keeps sounding, just quieter).
    const gain = ctx.createGain();
    const tail = Math.pow(10, -FILTER_SETTINGS.decayDb / 20);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(Math.max(tail, 0.0015), now + 0.35);

    src.connect(gain);
    gain.connect(dipFilter);
    src.start(now);

    activeVoices.set(voiceId, { src, gain });

    iconNote.textContent = noteLabel(actualNote) + " (" + actualNote + ")";
    iconNote.classList.add("active");
  }

  function stopVoice(voiceId) {
    const voice = activeVoices.get(voiceId);
    if (!voice) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    const RELEASE_SEC = 0.5;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE_SEC);
    voice.src.stop(now + RELEASE_SEC + 0.03);
    activeVoices.delete(voiceId);
    if (activeVoices.size === 0) iconNote.classList.remove("active");
  }

  function stopAllVoices() {
    activeVoices.forEach((_voice, voiceId) => stopVoice(voiceId));
  }

  function playClick() {
    // "0" has no assigned pitch on the real unit; give it a short neutral click.
    const ctx = getCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 180;
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(gain).connect(dipFilter);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  // Rendering a 2s additive buffer takes tens of milliseconds, which would be
  // an audible hitch on the first press of each key. Build them ahead of time
  // in small chunks once the audio context is running, so playing stays responsive.
  function warmUpBuffers() {
    const ctx = audioCtx;
    const notes = Array.from(document.querySelectorAll(".key[data-note]"))
      .map((btn) => NOTE_FREQ[shiftNote(btn.dataset.note)])
      .filter(Boolean);
    let i = 0;
    const step = () => {
      if (i >= notes.length) return;
      buildBuffer(ctx, notes[i++]);
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  // ---------- Key press handling (mouse / touch / pen) ----------
  function pressVisual(btn) {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
  }

  // Key-down: starts a sustained note, a one-shot click, or a volume step.
  function handleKeyDown(btn) {
    pressVisual(btn);

    if (btn.dataset.note) {
      startVoice(btn, btn.dataset.note);
    } else if (btn.dataset.digit === "0") {
      playClick();
    } else if (btn.dataset.vol === "down") {
      setVolume(volumeIndex - 1);
    } else if (btn.dataset.vol === "up") {
      setVolume(volumeIndex + 1);
    }
  }

  // Key-up: only matters for sustained notes, to stop them.
  function handleKeyUp(btn) {
    if (btn.dataset.note) stopVoice(btn);
  }

  document.querySelectorAll(".key").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      getCtx();
      handleKeyDown(btn);
    });
    btn.addEventListener("pointerup", () => handleKeyUp(btn));
    btn.addEventListener("pointercancel", () => handleKeyUp(btn));
  });

  // If the tab loses focus while a key is physically held, the pointerup
  // may never arrive - stop everything rather than leave a note droning.
  window.addEventListener("blur", stopAllVoices);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAllVoices();
  });

  // ---------- PC keyboard support ----------
  const KEYMAP = {};
  document.querySelectorAll(".key").forEach((btn) => {
    if (btn.dataset.digit !== undefined && btn.dataset.digit.length === 1) {
      KEYMAP[btn.dataset.digit] = btn;
    }
  });
  const OP_KEYMAP = {
    "/": document.querySelector('[data-op="÷"]'),
    "*": document.querySelector('[data-op="×"]'),
    "-": document.querySelector('[data-op="−"]'),
    "+": document.querySelector('[data-op="+"]'),
    "=": document.querySelector('[data-eq="="]'),
    Enter: document.querySelector('[data-eq="="]'),
  };

  const heldKeys = new Set();
  window.addEventListener("keydown", (e) => {
    if (heldKeys.has(e.key)) return; // ignore OS key-repeat
    const btn = KEYMAP[e.key] || OP_KEYMAP[e.key];
    if (!btn) return;
    heldKeys.add(e.key);
    e.preventDefault();
    getCtx();
    handleKeyDown(btn);
  });
  window.addEventListener("keyup", (e) => {
    heldKeys.delete(e.key);
    const btn = KEYMAP[e.key] || OP_KEYMAP[e.key];
    if (btn) handleKeyUp(btn);
  });
})();
