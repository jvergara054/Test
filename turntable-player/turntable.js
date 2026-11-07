/* ==========================================================================
   Turntable player
   --------------------------------------------------------------------------
   Drives the SVG drawing and plays a Spotify playlist through the Spotify
   iFrame API, which needs no login or API keys. The Spotify player stays
   hidden. The turntable shows only what's playing: the song's cover art
   spins on the record label, and the strip under the deck shows the title
   and progress.

   Playlist: ?playlist=<link | uri | id> in the URL, otherwise CONFIG.playlist.
   ========================================================================== */
(() => {
  'use strict';

  const CONFIG = {
    playlist: 'https://open.spotify.com/playlist/5uEW8SUsj1IxND6UVWnyDQ',
    fallbackTitle: 'Sunday Drv',
  };

  /* ---------- geometry (must match index.html) ---------- */
  const C = { x: 380, y: 380 };    // platter centre
  const P = { x: 820, y: 175 };    // tonearm pivot
  const L = 450;                   // pivot → stylus
  const REST = 6;                  // arm angle on the rest, degrees
  const R_OUT = 266;               // lead-in groove radius
  const R_IN = 106;                // run-out groove radius
  const VIEW_FULL = '-90 -70 1240 900';
  const VIEW_COMPACT = '26 16 948 718';

  const $ = (s) => document.querySelector(s);
  const svg = $('#tt');
  const deck = $('#deck');
  const els = {
    platterRot: $('#platter-rot'),
    arm: $('#arm'),
    grooves: $('#grooves'),
    sweep: $('#sweep'),
    sweepProgress: $('#sweep-progress'),
    start: $('#btn-start'),
    startLabel: $('#btn-start .ctl__label'),
    b33: $('#btn-33'),
    b45: $('#btn-45'),
    knob: $('#pitch-knob'),
    hit: $('#platter-hit'),
    labelDefault: $('#label-default'),
    labelArt: $('#label-art'),
    labelImg: $('#label-img'),
    npState: $('#np-state'),
    npTitle: $('#np-title'),
    npSub: $('#np-sub'),
    npTime: $('#np-time'),
    npCover: $('#np-cover'),
    npLink: $('#np-link'),
    npBar: $('#np-bar'),
    dock: $('#spotify-dock'),
    host: $('#spotify-host'),
  };

  /* ---------- grooves ---------- */
  (function drawGrooves() {
    const NS = 'http://www.w3.org/2000/svg';
    const gaps = [228, 186, 150];
    const frag = document.createDocumentFragment();
    for (let r = R_OUT + 2; r >= R_IN - 2; r -= 2.4) {
      const c = document.createElementNS(NS, 'circle');
      const nearGap = gaps.some((g) => Math.abs(r - g) < 1.3);
      c.setAttribute('cx', C.x);
      c.setAttribute('cy', C.y);
      c.setAttribute('r', r.toFixed(1));
      c.setAttribute('class', 'groove');
      c.setAttribute('stroke-width', nearGap ? '1.4' : '0.45');
      c.setAttribute('opacity', nearGap ? '0.55' : (0.14 + 0.1 * Math.sin(r * 0.9)).toFixed(2));
      frag.appendChild(c);
    }
    els.grooves.appendChild(frag);
  })();

  /* ---------- responsive crop ---------- */
  function fit() {
    const compact = deck.clientWidth < 640;
    svg.classList.toggle('is-compact', compact);
    svg.setAttribute('viewBox', compact ? VIEW_COMPACT : VIEW_FULL);
  }
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(deck);
  else window.addEventListener('resize', fit);
  fit();

  /* ---------- tonearm maths ---------- */
  const rad = (d) => (d * Math.PI) / 180;
  const stylusAt = (deg) => ({ x: P.x - L * Math.sin(rad(deg)), y: P.y + L * Math.cos(rad(deg)) });
  const distToC = (pt) => Math.hypot(pt.x - C.x, pt.y - C.y);
  const TH_MAX = (Math.atan2(-(C.x - P.x), C.y - P.y) * 180) / Math.PI; // arm pointing at spindle

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
    return `M${s.x.toFixed(2)},${s.y.toFixed(2)} A${L},${L} 0 0 1 ${e.x.toFixed(2)},${e.y.toFixed(2)}`;
  }
  els.sweep.setAttribute('d', arcPath(TH_OUT, TH_IN));

  /* ---------- state ---------- */
  const state = {
    playing: false,
    buffering: false,
    position: 0,
    duration: 0,
    posStamp: performance.now(),
    rpm: 100 / 3,
    pitch: 0,
    api: null,
    controller: null,
    uri: '',
    playlist: null,      // { title, image, url }
    track: null,         // { title, image, url }
    trackUri: '',
    wantPlay: false,     // pressed start before the player was ready
    connectTimer: 0,
  };
  const DEMO_DURATION = 3 * 60 * 1000;

  function livePosition() {
    if (!state.duration) return 0;
    const p = state.position + (state.playing ? performance.now() - state.posStamp : 0);
    return Math.min(p, state.duration);
  }

  /* ---------- Spotify metadata (public oEmbed endpoint, no auth) ---------- */
  const metaCache = new Map();
  function uriToUrl(uri) {
    const [, type, id] = uri.split(':');
    return `https://open.spotify.com/${type}/${id}`;
  }
  function fetchMeta(uri) {
    if (!metaCache.has(uri)) {
      const url = uriToUrl(uri);
      metaCache.set(uri, fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j ? { title: j.title || '', image: j.thumbnail_url || '', url } : { title: '', image: '', url }))
        .catch(() => ({ title: '', image: '', url })));
    }
    return metaCache.get(uri);
  }

  function setArtwork(src) {
    if (src) {
      els.labelImg.setAttribute('href', src);
      els.labelArt.removeAttribute('hidden');
      els.labelDefault.setAttribute('hidden', '');
      els.npCover.src = src;
      els.npCover.hidden = false;
    } else {
      els.labelArt.setAttribute('hidden', '');
      els.labelDefault.removeAttribute('hidden');
      els.npCover.hidden = true;
    }
  }

  function showMeta() {
    const t = state.track, p = state.playlist;
    els.npTitle.textContent = (t && t.title) || (p && p.title) || CONFIG.fallbackTitle;
    els.npSub.textContent = p && p.title && t && t.title ? p.title : state.uri ? 'Spotify playlist' : 'Demo, no audio';
    setArtwork((t && t.image) || (p && p.image) || '');
    els.npLink.href = (t && t.url) || (p && p.url) || 'https://open.spotify.com';
  }

  async function onTrackChange(uri) {
    state.trackUri = uri;
    const m = await fetchMeta(uri);
    if (state.trackUri !== uri) return;      // skipped again meanwhile
    state.track = m;
    showMeta();
  }

  /* ---------- playback control ---------- */
  function openDock(open) {
    els.dock.classList.toggle('is-open', open);
  }

  function toggle() {
    if (state.controller) {
      state.controller.togglePlay();
      const before = state.playing;
      clearTimeout(state.connectTimer);
      // Some browsers (iOS Safari) only allow audio after a tap inside the Spotify frame.
      state.connectTimer = setTimeout(() => {
        if (!before && !state.playing) openDock(true);
      }, 1800);
      return;
    }
    if (state.uri) {                          // player still loading
      state.wantPlay = !state.wantPlay;
      render();
      return;
    }
    // demo mode
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
  }

  /* ---------- pitch slider ---------- */
  const PITCH_Y0 = 410, PITCH_Y1 = 630, PITCH_MID = 520;
  function setPitch(pct) {
    state.pitch = Math.max(-8, Math.min(8, Math.round(pct * 10) / 10));
    const dy = (-state.pitch / 8) * (PITCH_MID - PITCH_Y0);
    els.knob.setAttribute('transform', `translate(0 ${dy.toFixed(2)})`);
    els.knob.setAttribute('aria-valuenow', String(state.pitch));
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
    if (e.target && e.target.closest && e.target.closest('input, textarea, button, a, [role="button"], [role="slider"]')) return;
    e.preventDefault();
    toggle();
  });

  /* ---------- readouts ---------- */
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function render() {
    const lifted = !state.playing && state.duration > 0 && livePosition() > 0;
    for (const el of [svg, deck]) el.classList.toggle('is-playing', state.playing);
    svg.classList.toggle('is-lifted', lifted);
    els.startLabel.textContent = state.playing ? 'STOP' : 'START';
    els.npState.textContent =
      state.buffering || (state.wantPlay && !state.controller) ? 'Cueing…'
      : state.playing ? 'Now playing'
      : lifted ? 'Paused'
      : 'Standby';
  }

  /* ---------- animation loop ---------- */
  let last = performance.now();
  let rot = 0, omega = 0, armAngle = REST;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const target = state.playing ? state.rpm * 6 * (1 + state.pitch / 100) : 0; // deg/s
    omega += (target - omega) * (1 - Math.exp(-(state.playing ? 2.4 : 1.1) * dt));
    if (!reduceMotion) {
      rot = (rot + omega * dt) % 360;
      els.platterRot.setAttribute('transform', `rotate(${rot.toFixed(3)} ${C.x} ${C.y})`);
    }

    const pos = livePosition();
    const progress = state.duration ? pos / state.duration : 0;
    const onRecord = state.playing || (state.duration > 0 && pos > 0);
    const armTarget = onRecord ? TH_OUT + (TH_IN - TH_OUT) * progress : REST;
    armAngle += (armTarget - armAngle) * (1 - Math.exp(-(reduceMotion ? 50 : 3.2) * dt));
    els.arm.setAttribute('transform', `rotate(${armAngle.toFixed(3)} ${P.x} ${P.y})`);

    els.sweepProgress.setAttribute('d', onRecord && progress > 0.001 ? arcPath(TH_OUT, TH_OUT + (TH_IN - TH_OUT) * progress) : '');
    els.npTime.textContent = state.duration ? `${fmt(pos)} / ${fmt(state.duration)}` : '';
    els.npBar.style.width = `${(progress * 100).toFixed(2)}%`;

    if (!state.controller && !state.uri && state.playing && pos >= state.duration) {
      state.position = 0;               // demo loops
      state.posStamp = now;
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Spotify player ---------- */
  function toUri(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    let m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|episode|show|artist)\/([A-Za-z0-9]+)/i);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    m = s.match(/^spotify:(playlist|album|track|episode|show|artist):([A-Za-z0-9]+)$/i);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    if (/^[A-Za-z0-9]{22}$/.test(s)) return `spotify:playlist:${s}`;
    return '';
  }

  function mount() {
    if (!state.api || !state.uri || state.controller) return;
    const slot = document.createElement('div');
    els.host.appendChild(slot);
    state.api.createController(slot, { uri: state.uri, width: '100%', height: 152 }, (controller) => {
      state.controller = controller;
      controller.addListener('playback_update', (e) => {
        const d = e.data || {};
        state.playing = !d.isPaused;
        state.buffering = !!d.isBuffering;
        state.duration = d.duration || 0;
        state.position = d.position || 0;
        state.posStamp = performance.now();
        if (state.playing) { clearTimeout(state.connectTimer); openDock(false); }
        const playing = d.playingURI || d.playingUri || '';
        if (playing && playing !== state.trackUri) onTrackChange(playing);
        render();
      });
      controller.addListener('ready', () => {
        if (state.wantPlay) { state.wantPlay = false; toggle(); }
      });
    });
  }

  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    state.api = IFrameAPI;
    mount();
  };

  /* ---------- boot ---------- */
  state.uri = toUri(new URLSearchParams(location.search).get('playlist')) || toUri(CONFIG.playlist);
  if (state.uri) {
    fetchMeta(state.uri).then((m) => { state.playlist = m; showMeta(); });
  }
  showMeta();
  setPitch(0);
  render();
  requestAnimationFrame(frame);
})();
