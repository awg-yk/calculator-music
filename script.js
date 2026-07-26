(() => {
  "use strict";

  const display = document.getElementById("display");
  const calc = document.getElementById("calc");
  const modeToggle = document.getElementById("modeToggle");
  const iconMusic = document.getElementById("icon-music");
  const iconNote = document.getElementById("icon-note");
  const waveSelect = document.getElementById("waveSelect");
  const volumeRange = document.getElementById("volumeRange");
  const softnessRange = document.getElementById("softnessRange");
  const highpassRange = document.getElementById("highpassRange");
  const peakFreqRange = document.getElementById("peakFreqRange");
  const peakQRange = document.getElementById("peakQRange");
  const peakGainRange = document.getElementById("peakGainRange");
  const lowpassRange = document.getElementById("lowpassRange");
  const attackRange = document.getElementById("attackRange");
  const decayRange = document.getElementById("decayRange");
  const sustainRange = document.getElementById("sustainRange");
  const releaseRange = document.getElementById("releaseRange");
  const clickRange = document.getElementById("clickRange");
  const copySettingsBtn = document.getElementById("copySettings");
  const copyFeedback = document.getElementById("copyFeedback");
  const settingsText = document.getElementById("settingsText");

  const SOLFEGE = { C: "ド", D: "レ", E: "ミ", F: "ファ", G: "ソ", A: "ラ", B: "シ" };

  const NOTE_FREQ = {
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
    // extra range so the octave-shift control can reach roughly C4-B6, as the real unit does
    C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
    C6: 1046.5, D6: 1174.66, E6: 1318.51, F6: 1396.91, G6: 1567.98, A6: 1760.0, B6: 1975.53,
  };

  function noteLabel(note) {
    const letter = note[0];
    const octave = parseInt(note.slice(1), 10);
    const sol = SOLFEGE[letter];
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
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  let octaveShift = 0; // -1, 0, +1 semitone-octave shift, cycled by CE-like control (here: long behavior not needed, kept simple)

  function shiftNote(note) {
    if (octaveShift === 0) return note;
    const letter = note[0];
    const octave = parseInt(note.slice(1), 10) + octaveShift;
    const shifted = letter + octave;
    return NOTE_FREQ[shifted] ? shifted : note;
  }

  // Measured across 15 recorded notes: even harmonics sit at ~6.6% of the
  // odd ones, i.e. the drive signal is a clean 50%-duty square. So the wave
  // is built from odd harmonics only. What varies is how fast they fall off:
  // 1/n is a textbook square (bright, buzzy), while larger exponents shed
  // the upper harmonics for a rounder, softer tone. `softness` is that
  // exponent, exposed as the main timbre control.
  let piezoWave = null;
  let piezoWaveSoftness = null;
  function getPiezoWave(ctx) {
    const softness = parseFloat(softnessRange.value);
    if (piezoWave && piezoWaveSoftness === softness) return piezoWave;
    const N = 40;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 1; n < N; n += 2) {
      imag[n] = (2 / Math.PI) / Math.pow(n, softness);
    }
    piezoWave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    piezoWaveSoftness = softness;
    return piezoWave;
  }

  function applyWaveform(osc, ctx) {
    const val = waveSelect.value;
    if (val === "piezo") osc.setPeriodicWave(getPiezoWave(ctx));
    else osc.type = val;
  }

  // A real piezo disc gets driven by an abrupt voltage step, which excites
  // its own mechanical resonance for an instant before settling into the
  // steady tone - that's the little "tick" audible at the start of a real
  // recording that a plain synthesized tone lacks. Approximate it with a
  // short burst of filtered noise layered under the note's attack.
  function playClickTransient(ctx, now) {
    const amount = parseFloat(clickRange.value);
    if (amount <= 0) return;

    const bufferLen = Math.ceil(ctx.sampleRate * 0.02);
    const buffer = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = parseFloat(peakFreqRange.value);
    bandpass.Q.value = 2.5;

    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(amount * parseFloat(volumeRange.value), now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.006);

    noise.connect(bandpass).connect(clickGain).connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.02);
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
    const osc = ctx.createOscillator();
    applyWaveform(osc, ctx);
    osc.frequency.value = freq;

    // The cleanly-measured notes show a smooth harmonic rolloff with no
    // resonant peak, and a fundamental that dominates everything else - so
    // the peak filter defaults to 0dB (off, kept only as a manual control)
    // and the highpass sits well below the lowest fundamental instead of
    // clipping into it. Shaping is left mostly to the waveform itself.
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = parseFloat(highpassRange.value);

    const peak_filter = ctx.createBiquadFilter();
    peak_filter.type = "peaking";
    peak_filter.frequency.value = parseFloat(peakFreqRange.value);
    peak_filter.Q.value = parseFloat(peakQRange.value);
    peak_filter.gain.value = parseFloat(peakGainRange.value);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = parseFloat(lowpassRange.value);
    lowpass.Q.value = 0.7;

    const gain = ctx.createGain();
    const peak = parseFloat(volumeRange.value);
    const attackSec = parseFloat(attackRange.value) / 1000;
    const decaySec = parseFloat(decayRange.value) / 1000;
    const sustainFloor = peak * (parseFloat(sustainRange.value) / 100);
    gain.gain.setValueAtTime(0, now);
    // Near-instant attack: a real buzzer just gets switched on.
    gain.gain.linearRampToValueAtTime(peak, now + attackSec);
    // A real recording keeps fading even while the key is held (closer to a
    // struck/plucked envelope than a flat organ-like sustain) - measured
    // from an actual sample: ~5ms attack, then decaying toward roughly 30%
    // of peak over a couple hundred ms.
    gain.gain.setTargetAtTime(sustainFloor, now + attackSec, decaySec);

    osc.connect(highpass).connect(peak_filter).connect(lowpass).connect(gain).connect(ctx.destination);
    osc.start(now);
    playClickTransient(ctx, now);

    activeVoices.set(voiceId, { osc, gain });

    iconNote.textContent = noteLabel(actualNote) + " (" + actualNote + ")";
    iconNote.classList.add("active");
  }

  function stopVoice(voiceId) {
    const voice = activeVoices.get(voiceId);
    if (!voice) return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    const releaseSec = parseFloat(releaseRange.value) / 1000;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    // Short release so the cutoff isn't an audible click, but still snappy.
    voice.gain.gain.linearRampToValueAtTime(0, now + releaseSec);
    voice.osc.stop(now + releaseSec + 0.01);
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
    gain.gain.setValueAtTime(parseFloat(volumeRange.value) * 0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(gain).connect(ctx.destination);
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
    } else {
      clearAll();
    }
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
  const TUNE_SLIDERS = [
    [softnessRange, "softnessOut", 2],
    [highpassRange, "highpassOut", 0],
    [peakFreqRange, "peakFreqOut", 0],
    [peakQRange, "peakQOut", 1],
    [peakGainRange, "peakGainOut", 1],
    [lowpassRange, "lowpassOut", 0],
    [attackRange, "attackOut", 0],
    [decayRange, "decayOut", 0],
    [sustainRange, "sustainOut", 0],
    [releaseRange, "releaseOut", 0],
    [clickRange, "clickOut", 2],
  ];
  TUNE_SLIDERS.forEach(([slider, outId, decimals]) => {
    const out = document.getElementById(outId);
    const update = () => { out.textContent = parseFloat(slider.value).toFixed(decimals); };
    slider.addEventListener("input", update);
    update();
  });

  function currentSettingsText() {
    return (
      `wave=${waveSelect.value} softness=${softnessRange.value} ` +
      `highpass=${highpassRange.value}Hz peakFreq=${peakFreqRange.value}Hz ` +
      `peakQ=${peakQRange.value} peakGain=${peakGainRange.value}dB ` +
      `lowpass=${lowpassRange.value}Hz ` +
      `attack=${attackRange.value}ms decay=${decayRange.value}ms ` +
      `sustain=${sustainRange.value}% release=${releaseRange.value}ms ` +
      `click=${clickRange.value}`
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
