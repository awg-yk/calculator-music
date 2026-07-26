(() => {
  "use strict";

  const display = document.getElementById("display");
  const calc = document.getElementById("calc");
  const modeToggle = document.getElementById("modeToggle");
  const iconMusic = document.getElementById("icon-music");
  const iconNote = document.getElementById("icon-note");
  const volumeRange = document.getElementById("volumeRange");
  const tiltRange = document.getElementById("tiltRange");
  const depthRange = document.getElementById("depthRange");
  const rateRange = document.getElementById("rateRange");
  const resFRange = document.getElementById("resFRange");
  const resGRange = document.getElementById("resGRange");
  const lpRange = document.getElementById("lpRange");
  const decayRange = document.getElementById("decayRange");
  const copySettingsBtn = document.getElementById("copySettings");
  const copyFeedback = document.getElementById("copyFeedback");
  const settingsText = document.getElementById("settingsText");

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

  // Add small solfège labels onto the note keys (visible only in music mode).
  document.querySelectorAll(".key[data-note]").forEach((btn) => {
    const label = document.createElement("span");
    label.className = "note-label";
    label.textContent = noteLabel(btn.dataset.note);
    btn.appendChild(label);
  });

  // ---------- Audio ----------
  // Additive engine ported from the AR7778 tone workbench: odd harmonics
  // with amplitude 1/(n+1)^tilt, each one slowly amplitude-modulated at
  // n/2 * rate Hz (that wobble is what gives the tone its gritty, alive
  // character), then run through a fixed dip -> resonance -> lowpass chain
  // approximating the measured piezo response.
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
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function syncFilters() {
    if (!audioCtx) return;
    resFilter.frequency.value = parseFloat(resFRange.value);
    resFilter.gain.value = parseFloat(resGRange.value);
    lpFilter.frequency.value = parseFloat(lpRange.value);
    masterGain.gain.value = parseFloat(volumeRange.value);
  }

  let octaveShift = 0; // -1, 0, +1 semitone-octave shift, cycled by CE-like control (here: long behavior not needed, kept simple)

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

  function toneParams() {
    return {
      tilt: parseFloat(tiltRange.value),
      depth: parseFloat(depthRange.value),
      rate: parseFloat(rateRange.value),
    };
  }

  function buildBuffer(ctx, freq) {
    const { tilt, depth, rate } = toneParams();
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
    // over 350ms" control, which is where it stays for as long as the key is
    // held (the real unit keeps sounding, just quieter).
    const gain = ctx.createGain();
    const tail = Math.pow(10, -parseFloat(decayRange.value) / 20);
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

  // ---------- Calculator logic ----------
  let acc = null;
  let pendingOp = null;
  let current = "0";
  // true when the next digit press should start a brand-new number
  // instead of appending to `current` (right after an operator or "=").
  let freshEntry = true;
  let memory = 0;

  function render() {
    display.textContent = current;
  }

  function inputDigit(d) {
    if (freshEntry) {
      current = "0";
      freshEntry = false;
    }
    if (d === ".") {
      if (!current.includes(".")) current += ".";
    } else if (d === "00") {
      current = current === "0" ? "0" : current + "00";
    } else {
      current = current === "0" ? d : current + d;
    }
    render();
  }

  function applyOp(a, b, op) {
    switch (op) {
      case "÷": return b === 0 ? 0 : a / b;
      case "×": return a * b;
      case "−": return a - b;
      case "+": return a + b;
      default: return b;
    }
  }

  function inputOp(op) {
    const val = parseFloat(current);
    if (acc === null) {
      acc = val;
    } else if (!freshEntry) {
      acc = applyOp(acc, val, pendingOp);
    }
    pendingOp = op;
    current = String(acc);
    freshEntry = true;
    render();
  }

  function evaluate() {
    if (pendingOp === null) return;
    const val = parseFloat(current);
    acc = applyOp(acc, val, pendingOp);
    current = String(acc);
    pendingOp = null;
    freshEntry = true;
    render();
  }

  function clearAll() {
    acc = null;
    pendingOp = null;
    current = "0";
    freshEntry = true;
    render();
  }

  function percent() {
    current = String(parseFloat(current) / 100);
    freshEntry = true;
    render();
  }

  function sqrt() {
    const v = parseFloat(current);
    current = v < 0 ? "0" : String(Math.sqrt(v));
    freshEntry = true;
    render();
  }

  function memPlus() {
    memory += parseFloat(current);
    freshEntry = true;
  }
  function memMinus() {
    memory -= parseFloat(current);
    freshEntry = true;
  }
  function memRecall() {
    current = String(memory);
    freshEntry = true;
    render();
  }

  render();

  // ---------- Mode switching ----------
  let musicMode = false;

  function setMusicMode(on) {
    musicMode = on;
    calc.classList.toggle("music-mode", musicMode);
    modeToggle.classList.toggle("active", musicMode);
    iconMusic.classList.toggle("active", musicMode);
    if (musicMode) {
      display.textContent = "Play me!";
      warmUpBuffers();
    } else {
      clearAll();
    }
  }

  // Rendering a 2s additive buffer takes tens of milliseconds, which would be
  // an audible hitch on the first press of each key. Build them ahead of time
  // in small chunks once music mode is on, so playing stays responsive.
  let warmUpTimer = null;
  function warmUpBuffers() {
    clearTimeout(warmUpTimer);
    // Resolve the context here, while still inside the click that toggled
    // music mode, so it starts running rather than suspended.
    const ctx = getCtx();
    const notes = Array.from(document.querySelectorAll(".key[data-note]"))
      .map((btn) => NOTE_FREQ[shiftNote(btn.dataset.note)])
      .filter(Boolean);
    let i = 0;
    const step = () => {
      if (!musicMode || i >= notes.length) return;
      buildBuffer(ctx, notes[i++]);
      warmUpTimer = setTimeout(step, 0);
    };
    warmUpTimer = setTimeout(step, 0);
  }

  modeToggle.addEventListener("click", () => setMusicMode(!musicMode));

  // ---------- Key press handling (mouse / touch / pen) ----------
  function pressVisual(btn) {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
  }

  // Key-down: in music mode this starts a sustained note (or a one-shot
  // click / calculator function); in calculator mode it's the usual
  // one-shot digit/operator entry.
  function handleKeyDown(btn) {
    pressVisual(btn);

    if (musicMode) {
      if (btn.dataset.note) {
        startVoice(btn, btn.dataset.note);
      } else if (btn.dataset.digit === "0") {
        playClick();
      }
      // function row (AC, %, √, MRC, M-, M+) stays inert in music mode
      // except AC, which always works so you can get back to "0".
      if (btn.dataset.fn === "ac") clearAll();
      return;
    }

    if (btn.dataset.digit !== undefined) inputDigit(btn.dataset.digit);
    else if (btn.dataset.op) inputOp(btn.dataset.op);
    else if (btn.dataset.eq) evaluate();
    else if (btn.dataset.fn) {
      switch (btn.dataset.fn) {
        case "ac": clearAll(); break;
        case "percent": percent(); break;
        case "sqrt": sqrt(); break;
        case "mplus": memPlus(); break;
        case "mminus": memMinus(); break;
        case "mrc": memRecall(); break;
      }
    }
  }

  // Key-up: only matters in music mode, to stop a sustained note.
  function handleKeyUp(btn) {
    if (musicMode && btn.dataset.note) stopVoice(btn);
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

  // ---------- Tone tuning panel ----------
  // tilt/depth/rate feed the wavetable (buildBuffer caches per value set),
  // the rest drive the shared filter chain live.
  const TUNE_SLIDERS = [
    [tiltRange, "tiltOut", 2],
    [depthRange, "depthOut", 2],
    [rateRange, "rateOut", 2],
    [resFRange, "resFOut", 0],
    [resGRange, "resGOut", 1],
    [lpRange, "lpOut", 0],
    [decayRange, "decayOut", 1],
  ];
  TUNE_SLIDERS.forEach(([slider, outId, decimals]) => {
    const out = document.getElementById(outId);
    const update = () => {
      out.textContent = parseFloat(slider.value).toFixed(decimals);
      syncFilters();
    };
    slider.addEventListener("input", update);
    update();
  });
  volumeRange.addEventListener("input", syncFilters);

  const PRESETS = {
    hw:  { tilt: 1.05,  depth: 0.22, rate: 0.8, resF: 1450, resG: 6.5, lp: 3000,  decay: 12 },
    syn: { tilt: 1.151, depth: 1.00, rate: 1.0, resF: 1450, resG: 0,   lp: 12000, decay: 0 },
    mix: { tilt: 1.15,  depth: 0.85, rate: 1.0, resF: 1450, resG: 5,   lp: 3200,  decay: 12 },
  };
  const PRESET_INPUTS = {
    tilt: tiltRange, depth: depthRange, rate: rateRange,
    resF: resFRange, resG: resGRange, lp: lpRange, decay: decayRange,
  };
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS[btn.dataset.preset];
      Object.keys(preset).forEach((k) => {
        PRESET_INPUTS[k].value = preset[k];
        PRESET_INPUTS[k].dispatchEvent(new Event("input"));
      });
      document.querySelectorAll("[data-preset]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  function currentSettingsText() {
    return (
      `tilt=${tiltRange.value} depth=${depthRange.value} rate=${rateRange.value}Hz ` +
      `resF=${resFRange.value}Hz resG=${resGRange.value}dB ` +
      `lp=${lpRange.value}Hz decay=${decayRange.value}dB`
    );
  }

  copySettingsBtn.addEventListener("click", async () => {
    const text = currentSettingsText();
    settingsText.value = text;
    try {
      await navigator.clipboard.writeText(text);
      copyFeedback.textContent = "コピーしました!";
    } catch {
      settingsText.select();
      copyFeedback.textContent = "自動コピーできなかったので、下の欄から手動でコピーしてください。";
    }
    clearTimeout(copySettingsBtn._t);
    copySettingsBtn._t = setTimeout(() => { copyFeedback.textContent = ""; }, 4000);
  });
})();
