/* ==========================================================================
   Turntable player
   --------------------------------------------------------------------------
   Drives the SVG drawing in index.html and controls a Spotify embed through
   the Spotify iFrame API. No login or API keys needed.

   Playlist source, in priority order:
     1. ?playlist=<spotify link | uri | id> in the page URL
     2. the last playlist pasted into the form (kept in localStorage)
     3. CONFIG.playlist below
   ========================================================================== */
(() => {
  'use strict';

  const CONFIG = {
    // Put your playlist link here to make it the default, e.g.
    // 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'
    playlist: 'https://open.spotify.com/playlist/5uEW8SUsj1IxND6UVWnyDQ',
    embedHeight: 152,
  };

  /* ---------- geometry (must match index.html) ---------- */
  const C = { x: 380, y: 380 };    // platter centre
  const P = { x: 820, y: 175 };    // tonearm pivot
  const L = 450;                   // pivot → stylus
  const REST = 6;                  // arm angle on the rest, degrees
  const R_OUT = 266;               // lead-in groove radius
  const R_IN = 106;                // run-out groove radius

  const $ = (s) => document.querySelector(s);
  const svg = $('#tt');
  const els = {
    platterRot: $('#platter-rot'),
    arm: $('#arm'),
    grooves: $('#grooves'),
    sweep: $('#sweep'),
    sweepProgress: $('#sweep-progress'),
    start: $('#btn-start'),
    b33: $('#btn-33'),
    b45: $('#btn-45'),
    knob: $('#pitch-knob'),
    hit: $('#platter-hit'),
    status: $('#status'),
    time: $('#time'),
    dur: $('#dur'),
    rpm: $('#rpm'),
    pitchVal: $('#pitch-val'),
    src: $('#src'),
    host: $('#spotify-host'),
    empty: $('#spotify-empty'),
    form: $('#playlist-form'),
    input: $('#playlist-input'),
    hint: $('#hint'),
  };

  /* ---------- grooves ---------- */
  (function drawGrooves() {
    const NS = 'http://www.w3.org/2000/svg';
    const gaps = [228, 186, 150];           // track bands
    const frag = document.createDocumentFragment();
    for (let r = R_OUT + 2; r >= R_IN - 2; r -= 2.4) {
      const c = document.createElementNS(NS, 'circle');
      const nearGap = gaps.some((g) => Math.abs(r - g) < 1.3);
      c.setAttribute('cx', C.x);
      c.setAttribute('cy', C.y);
      c.setAttribute('r', r.toFixed(1));
      c.setAttribute('class', 'groove');
      c.setAttribute('stroke-width', nearGap ? '1.4' : '0.45');
      c.setAttribute('opacity', nearGap ? '0.55' : (0.16 + 0.12 * Math.sin(r * 0.9)).toFixed(2));
      frag.appendChild(c);
    }
    els.grooves.appendChild(frag);
  })();

  /* ---------- tonearm maths ---------- */
  const rad = (d) => (d * Math.PI) / 180;
  const stylusAt = (deg) => ({ x: P.x - L * Math.sin(rad(deg)), y: P.y + L * Math.cos(rad(deg)) });
  const distToC = (pt) => Math.hypot(pt.x - C.x, pt.y - C.y);
  // closest approach to the spindle is where the arm points straight at it
  const TH_MAX = (Math.atan2(-(C.x - P.x), C.y - P.y) * 180) / Math.PI;

  function angleForRadius(r) {
    let lo = REST, hi = TH_MAX;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (distToC(stylusAt(mid)) > r) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const TH_OUT = angleForRadius(R_OUT);
  const TH_IN = angleForRadius(R_IN);

  function arcPath(a0, a1) {
    const s = stylusAt(a0), e = stylusAt(a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M${s.x.toFixed(2)},${s.y.toFixed(2)} A${L},${L} 0 ${large} 1 ${e.x.toFixed(2)},${e.y.toFixed(2)}`;
  }
  els.sweep.setAttribute('d', arcPath(TH_OUT, TH_IN));

  /* ---------- state ---------- */
  const state = {
    playing: false,
    buffering: false,
    position: 0,         // ms, at posStamp
    duration: 0,         // ms
    posStamp: performance.now(),
    rpm: 100 / 3,
    pitch: 0,            // percent
    controller: null,
    api: null,
    uri: '',
    pendingToggle: 0,
  };

  const DEMO_DURATION = 3 * 60 * 1000;

  function livePosition() {
    if (!state.duration) return 0;
    const p = state.position + (state.playing ? performance.now() - state.posStamp : 0);
    return Math.min(p, state.duration);
  }

  /* ---------- playback control ---------- */
  function toggle() {
    if (state.controller) {
      state.controller.togglePlay();
      // Some browsers only allow audio after a click inside the Spotify frame.
      const before = state.playing;
      clearTimeout(state.pendingToggle);
      state.pendingToggle = setTimeout(() => {
        if (state.playing === before && !before) {
          hint('If nothing plays, press play once in the Spotify player. After that the deck controls it.');
        }
      }, 1800);
      return;
    }
    // demo mode: no audio
    state.position = livePosition();
    state.posStamp = performance.now();
    if (!state.duration) state.duration = DEMO_DURATION;
    state.playing = !state.playing;
    render();
  }

  function setSpeed(rpm) {
    state.rpm = rpm;
    const is45 = rpm === 45;
    els.b33.classList.toggle('is-active', !is45);
    els.b45.classList.toggle('is-active', is45);
    els.b33.setAttribute('aria-pressed', String(!is45));
    els.b45.setAttribute('aria-pressed', String(is45));
    render();
  }

  /* ---------- pitch slider ---------- */
  const PITCH_Y0 = 410, PITCH_Y1 = 630, PITCH_MID = 520;
  function setPitch(pct) {
    state.pitch = Math.max(-8, Math.min(8, Math.round(pct * 10) / 10));
    const dy = (-state.pitch / 8) * (PITCH_MID - PITCH_Y0);
    els.knob.setAttribute('transform', `translate(0 ${dy.toFixed(2)})`);
    els.knob.setAttribute('aria-valuenow', String(state.pitch));
    render();
  }
  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  els.knob.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    els.knob.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const y = Math.max(PITCH_Y0, Math.min(PITCH_Y1, svgPoint(ev).y));
      setPitch(((PITCH_MID - y) / (PITCH_MID - PITCH_Y0)) * 8);
    };
    const up = () => {
      els.knob.removeEventListener('pointermove', move);
      els.knob.removeEventListener('pointerup', up);
      els.knob.removeEventListener('pointercancel', up);
    };
    els.knob.addEventListener('pointermove', move);
    els.knob.addEventListener('pointerup', up);
    els.knob.addEventListener('pointercancel', up);
  });
  els.knob.addEventListener('dblclick', () => setPitch(0));
  els.knob.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setPitch(state.pitch + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setPitch(state.pitch - step); e.preventDefault(); }
    if (e.key === 'Home' || e.key === '0') { setPitch(0); e.preventDefault(); }
  });

  /* ---------- buttons ---------- */
  function asButton(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }
  asButton(els.start, toggle);
  asButton(els.hit, toggle);
  asButton(els.arm, toggle);
  asButton(els.b33, () => setSpeed(100 / 3));
  asButton(els.b45, () => setSpeed(45));

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target;
    if (t && (t.closest('input, textarea, button, [role="button"], [role="slider"]'))) return;
    e.preventDefault();
    toggle();
  });

  /* ---------- readouts ---------- */
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  function hint(msg) { els.hint.textContent = msg || ''; }

  function render() {
    const lifted = !state.playing && state.duration > 0 && livePosition() > 0;
    svg.classList.toggle('is-playing', state.playing);
    svg.classList.toggle('is-lifted', lifted);
    els.status.textContent = state.buffering ? 'Cueing' : state.playing ? 'Playing' : lifted ? 'Paused · cued' : 'Standby';
    els.dur.textContent = state.duration ? fmt(state.duration) : '--:--';
    els.rpm.textContent = state.rpm === 45 ? '45' : '33⅓';
    els.pitchVal.textContent = (state.pitch > 0 ? '+' : state.pitch < 0 ? '−' : '±') + Math.abs(state.pitch).toFixed(1);
    els.src.textContent = state.uri ? state.uri : 'Demo (no audio)';
  }

  /* ---------- animation loop ---------- */
  let last = performance.now();
  let rot = 0, omega = 0, armAngle = REST;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // platter: eases up to speed, coasts down
    const target = state.playing ? state.rpm * 6 * (1 + state.pitch / 100) : 0; // deg/s
    const k = state.playing ? 2.4 : 1.1;
    omega += (target - omega) * (1 - Math.exp(-k * dt));
    if (!reduceMotion) {
      rot = (rot + omega * dt) % 360;
      els.platterRot.setAttribute('transform', `rotate(${rot.toFixed(3)} ${C.x} ${C.y})`);
    }

    // arm: follows track progress; stays cued while paused; parks on stop
    const pos = livePosition();
    const progress = state.duration ? pos / state.duration : 0;
    const onRecord = state.playing || (state.duration > 0 && pos > 0);
    const armTarget = onRecord ? TH_OUT + (TH_IN - TH_OUT) * progress : REST;
    armAngle += (armTarget - armAngle) * (1 - Math.exp(-(reduceMotion ? 50 : 3.2) * dt));
    els.arm.setAttribute('transform', `rotate(${armAngle.toFixed(3)} ${P.x} ${P.y})`);

    els.sweepProgress.setAttribute('d', onRecord && progress > 0.001 ? arcPath(TH_OUT, TH_OUT + (TH_IN - TH_OUT) * progress) : '');
    els.time.textContent = fmt(pos);

    // demo mode loops the fake track
    if (!state.controller && state.playing && pos >= state.duration) {
      state.position = 0;
      state.posStamp = now;
    }

    requestAnimationFrame(frame);
  }

  /* ---------- Spotify ---------- */
  function toUri(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    let m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|episode|show|artist)\/([A-Za-z0-9]+)/i);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    m = s.match(/^spotify:(playlist|album|track|episode|show|artist):([A-Za-z0-9]+)$/i);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    if (/^[A-Za-z0-9]{22}$/.test(s)) return `spotify:playlist:${s}`;
    return null;
  }

  const store = {
    get() { try { return localStorage.getItem('sd-turntable-playlist') || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem('sd-turntable-playlist', v); } catch { /* ignore */ } },
  };

  function mount(uri) {
    state.uri = uri;
    render();
    if (!state.api) return; // mounted once the API script reports ready
    if (state.controller) { state.controller.loadUri(uri); return; }

    els.empty.hidden = true;
    const slot = document.createElement('div');
    els.host.appendChild(slot);
    state.api.createController(slot, { uri, width: '100%', height: CONFIG.embedHeight }, (controller) => {
      state.controller = controller;
      // leaving demo mode: reset the deck
      state.playing = false;
      state.position = 0;
      state.duration = 0;
      render();

      controller.addListener('playback_update', (e) => {
        const d = e.data || {};
        const wasPlaying = state.playing;
        state.playing = !d.isPaused;
        state.buffering = !!d.isBuffering;
        state.duration = d.duration || 0;
        state.position = d.position || 0;
        state.posStamp = performance.now();
        if (state.playing !== wasPlaying) { clearTimeout(state.pendingToggle); hint(''); }
        render();
      });
    });
  }

  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    state.api = IFrameAPI;
    if (state.uri) mount(state.uri);
  };

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const uri = toUri(els.input.value);
    if (uri === null) { hint('That doesn’t look like a Spotify link. Paste the link from Share › Copy link.'); return; }
    if (!uri) return;
    hint('');
    store.set(uri);
    mount(uri);
  });

  /* ---------- boot ---------- */
  const fromQuery = toUri(new URLSearchParams(location.search).get('playlist'));
  const initial = fromQuery || store.get() || toUri(CONFIG.playlist) || '';
  if (initial) { els.input.value = initial; mount(initial); }

  setPitch(0);
  render();
  requestAnimationFrame(frame);
})();
