(() => {
  "use strict";

  const display = document.getElementById("display");
  const calc = document.getElementById("calc");
  const modeToggle = document.getElementById("modeToggle");
  const iconMusic = document.getElementById("icon-music");
  const iconNote = document.getElementById("icon-note");
  const waveSelect = document.getElementById("waveSelect");
  const volumeRange = document.getElementById("volumeRange");

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

  function playNote(note) {
    const ctx = getCtx();
    const actualNote = shiftNote(note);
    const freq = NOTE_FREQ[actualNote];
    if (!freq) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveSelect.value;
    osc.frequency.value = freq;

    const peak = parseFloat(volumeRange.value);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008);
    gain.gain.setValueAtTime(peak, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);

    iconNote.textContent = noteLabel(actualNote) + " (" + actualNote + ")";
    iconNote.classList.add("active");
    clearTimeout(playNote._t);
    playNote._t = setTimeout(() => iconNote.classList.remove("active"), 500);
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

  function handleKeyActivate(btn) {
    pressVisual(btn);

    if (musicMode) {
      if (btn.dataset.note) {
        playNote(btn.dataset.note);
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

  document.querySelectorAll(".key").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      getCtx();
      handleKeyActivate(btn);
    });
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
    handleKeyActivate(btn);
  });
  window.addEventListener("keyup", (e) => heldKeys.delete(e.key));
})();
