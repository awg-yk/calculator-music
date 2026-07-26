(() => {
  "use strict";

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

  // Each calculator gets its own volume and transpose state (and, further
  // down, its own audio nodes) - they used to share one, which linked the
  // two calculators' controls together.
  const CALC_ELS = Array.from(document.querySelectorAll(".calc"));
  const calcState = new Map(); // calc element -> { volumeIndex, semitoneShift }
  CALC_ELS.forEach((calcEl) => calcState.set(calcEl, { volumeIndex: 2, semitoneShift: 0 }));

  function noteLabel(note) {
    const [, letter, flat, octaveStr] = note.match(NOTE_RE);
    const octave = parseInt(octaveStr, 10);
    const sol = SOLFEGE[letter] + (flat ? "♭" : "");
    if (octave <= 3) return sol + "˛";
    if (octave === 5) return sol + "'";
    if (octave >= 6) return sol + "''";
    return sol;
  }

  // Add small solfège labels onto the note keys. The text itself depends on
  // the semitone transpose, so it's (re)computed by refreshNoteLabels() once
  // shiftNote() is available below - here we just create the empty spans.
  const noteLabelEntries = [];
  document.querySelectorAll(".key[data-note]").forEach((btn) => {
    const label = document.createElement("span");
    label.className = "note-label";
    btn.appendChild(label);
    noteLabelEntries.push({ btn, label });
  });

  // Add small keyboard-letter hints onto any key with a non-obvious keyboard
  // binding (all of the second calculator's keys, plus the first
  // calculator's M-/M+/▼/▲/= utility keys).
  document.querySelectorAll(".key[data-letter]").forEach((btn) => {
    const hint = document.createElement("span");
    hint.className = "key-hint";
    const v = btn.dataset.letter;
    hint.textContent = v.length === 1 ? v.toUpperCase() : v;
    btn.appendChild(hint);
  });

  // ---------- Volume (5 discrete steps, shown small in each screen's corner) ----------
  const VOLUME_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];

  function renderVolume(calcEl) {
    const level = calcState.get(calcEl).volumeIndex + 1;
    const text = "音量 " + "■".repeat(level) + "□".repeat(VOLUME_LEVELS.length - level);
    calcEl.querySelector(".volume-badge").textContent = text;
  }

  function setVolume(calcEl, index) {
    const state = calcState.get(calcEl);
    state.volumeIndex = Math.max(0, Math.min(VOLUME_LEVELS.length - 1, index));
    syncFilters(calcEl);
    renderVolume(calcEl);
  }

  CALC_ELS.forEach(renderVolume);

  // ---------- Digit display (cosmetic echo of the last digits typed) ----------
  // Each calculator has its own display, echoing only what was typed on it.
  const MAX_TYPED_LEN = 20;
  const typedDigits = new Map(); // calc element -> string

  function appendDigit(btn, d) {
    const calcEl = btn.closest(".calc");
    const current = typedDigits.get(calcEl) || "0";
    const next = current === "0" ? d : (current + d).slice(-MAX_TYPED_LEN);
    typedDigits.set(calcEl, next);
    calcEl.querySelector(".display").textContent = next;
  }

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
  // Each calculator gets its own dip -> resonance -> lowpass -> gain chain
  // (same fixed tone settings, independent nodes) so its volume knob only
  // affects its own output.
  const calcAudioNodes = new Map(); // calc element -> { dipFilter, resFilter, lpFilter, masterGain }

  function createCalcAudioChain(ctx) {
    const dipFilter = ctx.createBiquadFilter();
    dipFilter.type = "peaking";
    dipFilter.frequency.value = 820;
    dipFilter.Q.value = 1.4;
    dipFilter.gain.value = -4;

    const resFilter = ctx.createBiquadFilter();
    resFilter.type = "peaking";
    resFilter.Q.value = 1.6;
    resFilter.frequency.value = FILTER_SETTINGS.resF;
    resFilter.gain.value = FILTER_SETTINGS.resG;

    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.Q.value = 0.7;
    lpFilter.frequency.value = FILTER_SETTINGS.lp;

    const masterGain = ctx.createGain();

    dipFilter.connect(resFilter);
    resFilter.connect(lpFilter);
    lpFilter.connect(masterGain);
    masterGain.connect(ctx.destination);

    return { dipFilter, resFilter, lpFilter, masterGain };
  }

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      CALC_ELS.forEach((calcEl) => {
        calcAudioNodes.set(calcEl, createCalcAudioChain(audioCtx));
        syncFilters(calcEl);
      });
      warmUpBuffers();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function syncFilters(calcEl) {
    const nodes = calcAudioNodes.get(calcEl);
    if (!nodes) return;
    nodes.masterGain.gain.value = VOLUME_LEVELS[calcState.get(calcEl).volumeIndex];
  }

  // Fine pitch adjustment via the ▼/▲ keys, in semitones (not whole octaves).
  // Each calculator has its own transpose, applied only to its own notes.
  const CHROMATIC = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const MAX_SEMITONE_SHIFT = 2;

  function setSemitoneShift(calcEl, value) {
    const state = calcState.get(calcEl);
    state.semitoneShift = Math.max(-MAX_SEMITONE_SHIFT, Math.min(MAX_SEMITONE_SHIFT, value));
    refreshNoteLabels(calcEl);
  }

  function shiftNote(calcEl, note) {
    const shift = calcState.get(calcEl).semitoneShift;
    if (shift === 0) return note;
    const [, letter, flat, octaveStr] = note.match(NOTE_RE);
    let idx = CHROMATIC.indexOf(letter + flat) + shift;
    let octave = parseInt(octaveStr, 10) + Math.floor(idx / 12);
    idx = ((idx % 12) + 12) % 12;
    const shifted = CHROMATIC[idx] + octave;
    return NOTE_FREQ[shifted] ? shifted : note;
  }

  // The on-key solfège label always reflects the currently sounding
  // (transposed) note, not just the button's base note.
  function refreshNoteLabels(calcEl) {
    noteLabelEntries.forEach(({ btn, label }) => {
      if (btn.closest(".calc") !== calcEl) return;
      label.textContent = noteLabel(shiftNote(calcEl, btn.dataset.note));
    });
  }
  CALC_ELS.forEach(refreshNoteLabels);

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
    const calcEl = voiceId.closest(".calc");
    const ctx = getCtx();
    const actualNote = shiftNote(calcEl, note);
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
    gain.connect(calcAudioNodes.get(calcEl).dipFilter);
    src.start(now);

    // Safety backstop: if a release is ever missed (seen occasionally on the
    // second calculator, likely a lost pointer-capture event), force the
    // note off soon rather than let it loop indefinitely. Kept short since a
    // normal release only takes ~0.5s (RELEASE_SEC below) - this only exists
    // to bound the worst case.
    const MAX_HOLD_MS = 2000;
    const safetyTimer = setTimeout(() => stopVoice(voiceId), MAX_HOLD_MS);

    activeVoices.set(voiceId, { src, gain, safetyTimer });

    const iconNote = calcEl.querySelector(".note-name");
    iconNote.textContent = noteLabel(actualNote) + " (" + actualNote + ")";
    iconNote.classList.add("active");
  }

  function stopVoice(voiceId) {
    const voice = activeVoices.get(voiceId);
    if (!voice) return;
    clearTimeout(voice.safetyTimer);
    const ctx = getCtx();
    const now = ctx.currentTime;
    const RELEASE_SEC = 0.5;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE_SEC);
    voice.src.stop(now + RELEASE_SEC + 0.03);
    activeVoices.delete(voiceId);

    const calcEl = voiceId.closest(".calc");
    const stillPlaying = Array.from(activeVoices.keys()).some((b) => b.closest(".calc") === calcEl);
    if (!stillPlaying) calcEl.querySelector(".note-name").classList.remove("active");
  }

  function stopAllVoices() {
    activeVoices.forEach((_voice, voiceId) => stopVoice(voiceId));
  }

  // Rendering a 2s additive buffer takes tens of milliseconds, which would be
  // an audible hitch on the first press of each key. Build them ahead of time
  // in small chunks once the audio context is running, so playing stays responsive.
  function warmUpBuffers() {
    const ctx = audioCtx;
    const notes = Array.from(document.querySelectorAll(".key[data-note]"))
      .map((btn) => NOTE_FREQ[shiftNote(btn.closest(".calc"), btn.dataset.note)])
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

  // Key-down: starts a sustained note, a volume/transpose step, and/or
  // echoes a pressed digit to the display (these are independent of each
  // other - a note key like "1" both plays and echoes). "0" is purely
  // decorative: it does not echo, and it makes no sound.
  function handleKeyDown(btn) {
    pressVisual(btn);

    if (btn.dataset.digit !== undefined && btn.dataset.digit !== "0") {
      appendDigit(btn, btn.dataset.digit);
    }

    if (btn.dataset.note) {
      startVoice(btn, btn.dataset.note);
      return;
    }

    const calcEl = btn.closest(".calc");
    if (btn.dataset.vol === "down") {
      setVolume(calcEl, calcState.get(calcEl).volumeIndex - 1);
    } else if (btn.dataset.vol === "up") {
      setVolume(calcEl, calcState.get(calcEl).volumeIndex + 1);
    } else if (btn.dataset.transpose === "down") {
      setSemitoneShift(calcEl, calcState.get(calcEl).semitoneShift - 1);
    } else if (btn.dataset.transpose === "up") {
      setSemitoneShift(calcEl, calcState.get(calcEl).semitoneShift + 1);
    }
  }

  // Key-up: only matters for sustained notes, to stop them.
  function handleKeyUp(btn) {
    if (btn.dataset.note) stopVoice(btn);
  }

  // Tracks which button each active pointer is sounding, so a release can
  // still be resolved even if the browser delivers it somewhere other than
  // the originally captured element (see the window-level fallback below).
  const pointerVoices = new Map(); // pointerId -> btn

  document.querySelectorAll(".key").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      pointerVoices.set(e.pointerId, btn);
      getCtx();
      handleKeyDown(btn);
    });
    btn.addEventListener("pointerup", () => handleKeyUp(btn));
    btn.addEventListener("pointercancel", () => handleKeyUp(btn));
    // Belt-and-braces: fires whenever capture ends for any reason, in case a
    // pointerup/pointercancel is ever swallowed (see MAX_HOLD_MS above too).
    btn.addEventListener("lostpointercapture", () => handleKeyUp(btn));
    // Some mobile browsers have historically been more reliable with touch
    // events than the pointer events they're supposed to unify with.
    btn.addEventListener("touchend", () => handleKeyUp(btn), { passive: true });
    btn.addEventListener("touchcancel", () => handleKeyUp(btn), { passive: true });
  });

  // Window-level fallback: if a release event never reaches the button
  // itself for any reason, this still catches it via the pointerId.
  function releasePointerVoice(e) {
    const btn = pointerVoices.get(e.pointerId);
    if (!btn) return;
    pointerVoices.delete(e.pointerId);
    handleKeyUp(btn);
  }
  window.addEventListener("pointerup", releasePointerVoice);
  window.addEventListener("pointercancel", releasePointerVoice);

  // If the tab loses focus while a key is physically held, the pointerup
  // may never arrive - stop everything rather than leave a note droning.
  window.addEventListener("blur", stopAllVoices);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAllVoices();
  });

  // ---------- Second calculator (left hand, QWERTY row) ----------
  // Off by default: two calculators only make sense once you're playing with
  // both hands on a physical keyboard, so it's opt-in via the toggle button.
  const calc2 = document.getElementById("calc2");
  const calcCountToggle = document.getElementById("calcCountToggle");
  let calc2Enabled = false;

  calcCountToggle.addEventListener("click", () => {
    calc2Enabled = !calc2Enabled;
    calc2.hidden = !calc2Enabled;
    calcCountToggle.textContent = calc2Enabled
      ? "電卓を1台にする"
      : "電卓を2台にする(左手用を追加)";
  });

  // ---------- PC keyboard support ----------
  // Number-row/numpad and +-*/= are scoped to the first calculator only -
  // the second calculator reuses the same digit/symbol labels (per the
  // "same appearance" requirement), so its note/operator keys are played
  // exclusively via CALC2_KEYMAP to avoid the two calculators fighting over
  // a key. CALC1_KEYMAP covers the first calculator's M-/M+/▼/▲/= keys,
  // whose bindings (I/O/K/L/Enter) don't match their printed symbol.
  const KEYMAP = {};
  document.querySelectorAll("#calc .key[data-digit]").forEach((btn) => {
    if (btn.dataset.digit.length === 1) KEYMAP[btn.dataset.digit] = btn;
  });
  const OP_KEYMAP = {
    "/": document.querySelector('#calc [data-op="÷"]'),
    "*": document.querySelector('#calc [data-op="×"]'),
    "-": document.querySelector('#calc [data-op="−"]'),
    "+": document.querySelector('#calc [data-op="+"]'),
    "=": document.querySelector('#calc [data-eq="="]'),
    Enter: document.querySelector('#calc [data-eq="="]'),
  };

  // Normalizes a KeyboardEvent.key to the same form used in data-letter:
  // lowercase for single characters, "Space" for the space bar, and
  // multi-character key names (like "Enter") passed through unchanged.
  function normalizeKey(rawKey) {
    if (rawKey === " ") return "Space";
    return rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
  }

  const CALC1_KEYMAP = {};
  document.querySelectorAll("#calc .key[data-letter]").forEach((btn) => {
    CALC1_KEYMAP[btn.dataset.letter] = btn;
  });
  const CALC2_KEYMAP = {};
  document.querySelectorAll("#calc2 .key[data-letter]").forEach((btn) => {
    CALC2_KEYMAP[btn.dataset.letter] = btn;
  });

  // Tracked by normalized token (not raw e.key) so a keyup reported with
  // different casing than its keydown (seen with some layouts/modifiers)
  // still clears correctly instead of leaving the key stuck as "held".
  const heldKeys = new Set();
  window.addEventListener("keydown", (e) => {
    const token = normalizeKey(e.key);
    if (heldKeys.has(token)) return; // ignore OS key-repeat
    const btn = KEYMAP[e.key] || OP_KEYMAP[e.key] || CALC1_KEYMAP[token] ||
      (calc2Enabled ? CALC2_KEYMAP[token] : undefined);
    if (!btn) return;
    heldKeys.add(token);
    e.preventDefault();
    getCtx();
    handleKeyDown(btn);
  });
  window.addEventListener("keyup", (e) => {
    const token = normalizeKey(e.key);
    heldKeys.delete(token);
    const btn = KEYMAP[e.key] || OP_KEYMAP[e.key] || CALC1_KEYMAP[token] || CALC2_KEYMAP[token];
    if (btn) handleKeyUp(btn);
  });
})();
