/* ============================================================
   ISS Explorer — application controller
   Live TLE, simulation clock, UI binding and pass predictions.
   ============================================================ */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const TLE_ENDPOINT = "https://api.wheretheiss.at/v1/satellites/25544/tles";
  const TLE_REFRESH_MS = 3 * 60 * 60 * 1000;
  const RE_KM = 6378.137;
  const SPEEDS = [1, 60, 600];
  const SLIDER_MIN = -60;
  const SLIDER_MAX = 120;

  // Onboard elements — used instantly and as an offline fallback.
  const FALLBACK_TLE = {
    line1: "1 25544U 98067A   26304.75703384  .00006360  00000+0  12291-3 0  9994",
    line2: "2 25544  51.6332 344.2755 0007028 332.5119  27.5497 15.49131714592920",
  };

  const DEFAULT_OBSERVER = {
    lat: 29.5502,
    lon: -95.097,
    name: "Houston, TX",
    inView: false,
  };

  const state = {
    satrec: null,
    tle: null,
    networkOk: null,
    syncing: true,
    offsetMs: 0,
    live: true,
    playing: true,
    speed: 1,
    follow: true,
    layers: {
      orbit: true,
      track: true,
      night: true,
      grid: true,
      footprint: true,
      labels: true,
    },
    observer: { ...DEFAULT_OBSERVER },
    sat: null,
    look: null,
    cycle: null,
    passes: [],
    passesLoading: true,
    selectedPass: -1,
    orbitEci: [],
    trackCache: null,
    cycleCache: null,
    lastUi: 0,
    lastFrame: 0,
    lastPassTick: 0,
    lastPassCalc: 0,
    toastTimer: null,
    observerTimer: null,
    layersReturnFocus: null,
    modalReturnFocus: null,
  };

  let globe = null;

  /* ============================================================
     Boot
     ============================================================ */

  function init() {
    globe = new ISSGlobe($("globe"), {
      onPick: ({ lat, lon }) => {
        setObserver(lat, lon, "Custom site");
        toast(`Ground station set to ${Astro.formatLat(lat)} · ${Astro.formatLon(lon)}`);
      },
      onInteract: () => {
        if (state.follow) setFollow(false);
      },
      onFollowChange: (value) => {
        state.follow = value;
        syncFollowUI();
      },
      onHover: (hover) => handleHover(hover),
      onReset: () => {
        setFollow(true);
        toast("View reset · following the ISS");
      },
    });

    applyTLE(FALLBACK_TLE.line1, FALLBACK_TLE.line2, "local");
    applyQueryParams();
    updateObserverUI();
    updateStaticUI();
    bindUI();
    tickClock();
    setInterval(tickClock, 500);

    requestAnimationFrame(frame);

    // Fold pass computation after first paint.
    setTimeout(computePasses, 350);
    refreshTLE(true);
    setInterval(() => refreshTLE(true), TLE_REFRESH_MS);
    setInterval(() => {
      if (!document.hidden) computePasses();
    }, 10 * 60 * 1000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - state.lastPassCalc > 10 * 60 * 1000) {
        refreshTLE(true);
        computePasses();
      }
    });
  }

  function applyQueryParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const offset = parseFloat(params.get("offset"));
      if (Number.isFinite(offset)) {
        state.offsetMs = Astro.clamp(offset, -4320, 4320) * 60000;
        state.live = false;
        state.playing = false;
      }
      const lat = parseFloat(params.get("lat"));
      const lon = parseFloat(params.get("lon"));
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        setObserver(lat, lon, params.get("name") || "Custom site");
      }
    } catch (err) { /* ignore malformed deep links */ }
  }

  /* ============================================================
     Orbital elements
     ============================================================ */

  function applyTLE(line1, line2, source) {
    let satrec;
    try {
      satrec = satellite.twoline2satrec(line1, line2);
      const test = satellite.propagate(satrec, new Date());
      if (!test || !test.position || typeof test.position === "boolean") throw new Error("Propagation failed");
    } catch (err) {
      if (source === "live" && state.tle) {
        state.networkOk = false;
        updateSourceChip();
        return false;
      }
      if (source !== "local") {
        return applyTLE(FALLBACK_TLE.line1, FALLBACK_TLE.line2, "local");
      }
      return false;
    }

    const meta = Astro.tleMeta(line1, line2);
    state.satrec = satrec;
    state.tle = {
      line1,
      line2,
      meta,
      source,
      appliedAt: Date.now(),
    };
    if (source === "live") state.networkOk = true;
    state.orbitEci = buildOrbitEci(satrec, meta.periodMin);
    state.trackCache = null;
    state.cycleCache = null;

    updateStaticUI();
    updateSourceChip();
    computePasses();
    return true;
  }

  async function refreshTLE(silent) {
    if (!state.tle || state.tle.source !== "live") {
      state.syncing = true;
      updateSourceChip();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch(`${TLE_ENDPOINT}?t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !/^1 /.test(data.line1 || "") || !/^2 /.test(data.line2 || "")) {
        throw new Error("Malformed TLE");
      }
      const changed = data.line1 !== (state.tle && state.tle.line1);
      const applied = applyTLE(data.line1, data.line2, "live");
      if (!applied) throw new Error("TLE could not be propagated");
      state.networkOk = true;
      updateSourceChip();
      if (changed && !silent) toast("Orbital elements synchronized");
    } catch (err) {
      state.networkOk = false;
      updateSourceChip();
      console.warn("ISS Explorer: live TLE refresh failed", err);
      if (!silent && state.tle && state.tle.source !== "live") {
        toast("Live TLE unavailable — using onboard elements");
      }
    } finally {
      clearTimeout(timer);
      state.syncing = false;
      updateSourceChip();
    }
  }

  function buildOrbitEci(satrec, periodMin) {
    if (!Number.isFinite(periodMin) || periodMin <= 0) return [];
    const N = 160;
    const start = Date.now();
    const span = periodMin * 60000;
    const points = [];
    for (let i = 0; i <= N; i++) {
      const pv = satellite.propagate(satrec, new Date(start + (i / N) * span));
      if (!pv || !pv.position || typeof pv.position === "boolean") continue;
      points.push({
        x: pv.position.x / RE_KM,
        y: pv.position.y / RE_KM,
        z: pv.position.z / RE_KM,
      });
    }
    return points;
  }

  /* ============================================================
     Derived data
     ============================================================ */

  function getGroundTrack(simDate) {
    const simMs = simDate.getTime();
    const key = Math.floor(simMs / 2000);
    const now = Date.now();
    if (state.trackCache && state.trackCache.key === key) return state.trackCache.data;
    if (state.trackCache && now - state.trackCache.wall < 120) return state.trackCache.data;

    const past = [];
    const future = [];
    const step = 45000;
    const from = simMs - 45 * 60000;
    const to = simMs + 90 * 60000;

    for (let t = from; t <= to; t += step) {
      const date = new Date(t);
      const pv = satellite.propagate(state.satrec, date);
      if (!pv || !pv.position || typeof pv.position === "boolean") continue;
      const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
      const point = {
        lat: satellite.degreesLat(geo.latitude),
        lon: Astro.normalizeLon(satellite.degreesLong(geo.longitude)),
      };
      if (t <= simMs) past.push(point);
      if (t >= simMs) future.push(point);
    }
    // Make sure both tracks touch the current position.
    if (state.sat) {
      const p = { lat: state.sat.lat, lon: state.sat.lon };
      if (!past.length || past[past.length - 1].lon !== p.lon) past.push(p);
      if (!future.length || future[0].lon !== p.lon) future.unshift(p);
    }

    const data = { past, future };
    state.trackCache = { key, wall: now, data };
    return data;
  }

  function getLightCycle(simDate) {
    const simMs = simDate.getTime();
    const key = Math.floor(simMs / 15000);
    const now = Date.now();
    if (state.cycleCache && state.cycleCache.key === key) return state.cycleCache.data;
    if (state.cycleCache && now - state.cycleCache.wall < 450) return state.cycleCache.data;

    let segments = [];
    try {
      segments = Astro.lightSegments(state.satrec, simDate, 100, 30);
    } catch (err) {
      segments = [];
    }
    state.cycle = segments;
    state.cycleCache = { key, wall: now, data: segments };
    return segments;
  }

  function computePasses() {
    if (!state.satrec) return;
    state.passesLoading = true;
    state.lastPassCalc = Date.now();
    renderPassList();

    setTimeout(() => {
      let passes = [];
      try {
        passes = Astro.computePasses(
          state.satrec,
          state.observer,
          new Date(),
          24,
          10
        ).slice(0, 4);
      } catch (err) {
        passes = [];
      }
      state.passes = passes;
      state.passesLoading = false;
      state.selectedPass = -1;
      renderPassList();
      renderScrubTicks();
      refreshPassCountdowns();
    }, 30);
  }

  /* ============================================================
     Main loop
     ============================================================ */

  function frame(now) {
    const dt = Math.min(0.1, (now - (state.lastFrame || now)) / 1000);
    state.lastFrame = now;

    if (state.live) {
      state.offsetMs = 0;
    } else if (state.playing) {
      state.offsetMs += dt * 1000 * state.speed;
      state.offsetMs = Astro.clamp(state.offsetMs, -3 * 86400000, 3 * 86400000);
    }

    const simDate = new Date(Date.now() + state.offsetMs);
    const sat = Astro.groundState(state.satrec, simDate);
    state.sat = sat;

    if (sat) {
      const look = Astro.lookAngles(state.satrec, simDate, state.observer);
      state.look = look;
      state.observer.inView = !!(look && look.elevation > 0);
      getLightCycle(simDate);
    }

    const track = getGroundTrack(simDate);

    globe.update({
      sat,
      sun: sat ? sat.sun : null,
      gmst: sat ? sat.gmst : 0,
      orbit: state.orbitEci,
      trackPast: track.past,
      trackFuture: track.future,
      observer: state.observer,
      layers: state.layers,
      follow: state.follow,
    });
    globe.render(now);

    if (now - state.lastUi > 105) {
      state.lastUi = now;
      updateTelemetry(simDate, sat);
    }

    requestAnimationFrame(frame);
  }

  /* ============================================================
     Small UI utilities
     ============================================================ */

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function tickClock() {
    const now = new Date();
    setText("utc-clock", Astro.utcClock(now));
    setText("utc-date", Astro.utcDate(now));
  }

  function toast(text, duration) {
    const el = $("toast");
    setText("toast-text", text);
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, duration || 3400);
  }

  function handleHover(hover) {
    const tip = $("hover-tip");
    if (!hover) {
      tip.hidden = true;
      return;
    }
    setText("tip-lat", Astro.formatLat(hover.lat));
    setText("tip-lon", Astro.formatLon(hover.lon));
    const flip = hover.x > globe.w - 180;
    tip.style.left = `${hover.x}px`;
    tip.style.top = `${hover.y}px`;
    tip.style.transform = flip ? "translate(calc(-100% - 14px), -50%)" : "translate(14px, -50%)";
    tip.hidden = false;
  }

  /* ============================================================
     Telemetry & timeline UI
     ============================================================ */

  function updateTelemetry(simDate, sat) {
    const offset = state.offsetMs;
    setText("sim-time", Astro.utcClock(simDate));
    setText(
      "sim-date",
      Math.abs(offset) < 60000
        ? `${Astro.utcDate(simDate)} · UTC`
        : `${Astro.utcShortDate(simDate)} · ${Astro.offsetLabel(offset)}`
    );

    if (sat) {
      setText("alt-value", sat.alt.toFixed(1));
      setText("vel-value", Math.round(sat.speed).toLocaleString("en-US"));
      setText("lat-value", Astro.formatLat(sat.lat));
      setText("lon-value", Astro.formatLon(sat.lon));
      setText("sun-state", sat.sunlit ? "Sunlit" : "Earth shadow");
      setText("beta-value", `β ${Astro.formatSigned(sat.beta)}°`);
      $("sun-card").classList.toggle("is-eclipse", !sat.sunlit);
    }

    updateLightCycle(simDate, sat);
    updateObserverTelemetry();
    updateStatus();
    updateTleAge();
    syncPlayButton();

    const slider = $("time-slider");
    if (document.activeElement !== slider) {
      slider.value = String(Astro.clamp(offset / 60000, SLIDER_MIN, SLIDER_MAX));
    }
    slider.title = `Simulation offset: ${Astro.offsetLabel(offset)}`;

    if (Date.now() - state.lastPassTick > 12000) {
      state.lastPassTick = Date.now();
      refreshPassCountdowns();
    }
  }

  function updateLightCycle(simDate, sat) {
    const segments = state.cycle || [];
    renderCycleBar(segments, simDate);

    let next = null;
    if (sat) {
      next = segments.find(
        (seg) => seg.start.getTime() > simDate.getTime() + 1500 && seg.sunlit !== sat.sunlit
      );
    }
    if (next) {
      setText("sun-event-label", next.sunlit ? "Sunrise in" : "Eclipse in");
      setText("sun-countdown", Astro.countdown(next.start - simDate));
      $("sun-countdown").title = `${Astro.utcClock(next.start)} UTC`;
    } else {
      setText("sun-event-label", "Light change");
      setText("sun-countdown", "—:—");
      $("sun-countdown").title = "No transition within the next 100 minutes";
    }
  }

  function renderCycleBar(segments, simDate) {
    const key = segments
      .map((s) => `${s.start.getTime()}-${s.end.getTime()}-${s.sunlit ? 1 : 0}`)
      .join("|");
    if (key === state.cycleKey) return;
    state.cycleKey = key;

    const bar = $("cycle-bar");
    bar.innerHTML = "";
    if (!segments.length) {
      const empty = document.createElement("div");
      empty.className = "cycle-seg eclipse";
      empty.style.flexGrow = "1";
      bar.appendChild(empty);
      return;
    }
    for (const seg of segments) {
      const el = document.createElement("div");
      el.className = `cycle-seg ${seg.sunlit ? "sunlit" : "eclipse"}`;
      el.style.flexGrow = String(Math.max(0.01, (seg.end - seg.start) / 1000));
      const label = seg.sunlit ? "Sunlit" : "Earth shadow";
      el.title = `${label} · ${Astro.utcClock(seg.start)} → ${Astro.utcClock(seg.end)} UTC`;
      bar.appendChild(el);
    }
  }

  function updateObserverTelemetry() {
    const look = state.look;
    if (!look) {
      setText("look-range", "—");
      setText("look-elev", "—");
      setText("look-az", "—");
      return;
    }
    setText("look-range", Math.round(look.range).toLocaleString("en-US"));
    setText("look-elev", look.elevation.toFixed(1));
    setText("look-az", String(Math.round(look.azimuth)));
    $("look-az").title = `${Astro.compass(look.azimuth)} · ${look.azimuth.toFixed(1)}°`;

    const row = $("horizon-row");
    const inView = look.elevation > 0;
    row.classList.toggle("in-view", inView);
    if (inView) {
      setText("horizon-text", `In line of sight · elevation ${look.elevation.toFixed(1)}°`);
    } else {
      const now = Date.now();
      const next = state.passes.find((p) => p.start.getTime() > now);
      if (next) {
        setText("horizon-text", `Below horizon · next pass in ${Astro.formatDuration(next.start - now)}`);
      } else if (state.passesLoading) {
        setText("horizon-text", "Computing passes…");
      } else {
        setText("horizon-text", "Below horizon · no pass in 24 h");
      }
    }
  }

  function updateStatus() {
    const pill = $("status-pill");
    let cls = "is-live";
    let text = "Live tracking";
    let detail = "";

    if (!state.tle) {
      text = "Acquiring signal";
    } else if (!state.playing) {
      cls = "is-paused";
      text = "Paused";
      if (Math.abs(state.offsetMs) > 60000) detail = Astro.offsetLabel(state.offsetMs);
    } else if (state.live) {
      text = "Live tracking";
    } else if (state.speed > 1) {
      cls = "is-timelapse";
      text = "Time-lapse";
      detail = `${state.speed}×`;
    } else if (state.offsetMs < -1000) {
      cls = "is-replay";
      text = "Replay";
      detail = Astro.offsetLabel(state.offsetMs);
    } else if (state.offsetMs > 1000) {
      cls = "is-forecast";
      text = "Forecast";
      detail = Astro.offsetLabel(state.offsetMs);
    } else {
      text = "Tracking";
    }

    pill.classList.remove("is-live", "is-forecast", "is-replay", "is-paused", "is-timelapse");
    pill.classList.add(cls);
    setText("status-text", text);
    setText("status-detail", detail);
  }

  function updateTleAge() {
    if (!state.tle) return;
    const epoch = state.tle.meta.epoch;
    if (!epoch) {
      setText("tle-age", "TLE —");
      return;
    }
    const ageH = (Date.now() - epoch.getTime()) / 3600000;
    const label = ageH < 1 ? "<1h" : ageH < 48 ? `${Math.round(ageH)}h` : `${Math.round(ageH / 24)}d`;
    const chip = $("tle-age");
    chip.textContent = `TLE · ${label}`;
    chip.title = `${state.tle.source === "live" ? "Live TLE" : "Onboard TLE"} · epoch ${Astro.utcDate(epoch)} ${Astro.utcClock(epoch)} UTC`;
    chip.classList.toggle("is-stale", ageH > 72);
  }

  function updateStaticUI() {
    const meta = state.tle && state.tle.meta;
    if (meta) {
      setText("period-value", `${meta.periodMin.toFixed(1)} min`);
      setText("incl-value", `${meta.inclination.toFixed(2)}°`);
      setText("apo-value", `${Math.round(meta.apogee)} km`);
      setText("peri-value", `${Math.round(meta.perigee)} km`);
      setText("orbit-rev", `Rev ${meta.rev.toLocaleString("en-US")}`);
    }
    updateSourceChip();
    updateObserverUI();
    syncFollowUI();
    syncLayerInputs();
    syncPlayButton();
    setText("btn-speed", `${state.speed}×`);
    $("btn-live").classList.toggle("is-active", state.live);
    $("btn-live").setAttribute("aria-pressed", String(state.live));
    $("time-slider").min = String(SLIDER_MIN);
    $("time-slider").max = String(SLIDER_MAX);
  }

  function updateSourceChip() {
    const chip = $("source-chip");
    let label = "TLE · syncing";
    let liveClass = false;

    if (state.tle) {
      if (state.tle.source === "live" && state.networkOk === true) {
        label = "TLE · live";
        liveClass = true;
      } else if (state.tle.source === "live") {
        label = "TLE · cached";
        liveClass = true;
      } else if (state.syncing) {
        label = "TLE · syncing";
      } else {
        label = "TLE · local";
      }
    }
    chip.textContent = label;
    chip.classList.toggle("is-live", liveClass);

    if (state.tle) {
      const sourceLabel = state.tle.source === "live" ? "TLE · wheretheiss.at" : "TLE · onboard";
      setText("tle-source", sourceLabel);
      setText("data-credit", state.tle.source === "live" ? "Data · wheretheiss.at" : "Data · onboard elements");
    }
  }

  /* ============================================================
     Passes
     ============================================================ */

  function renderPassList() {
    const list = $("pass-list");
    list.innerHTML = "";

    if (state.passesLoading) {
      const empty = document.createElement("div");
      empty.className = "pass-empty";
      empty.textContent = "Computing orbital passes…";
      list.appendChild(empty);
      return;
    }

    if (!state.passes.length) {
      const empty = document.createElement("div");
      empty.className = "pass-empty";
      empty.textContent = "No passes above 10° in the next 24 hours from this station.";
      list.appendChild(empty);
      return;
    }

    state.passes.slice(0, 3).forEach((pass, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pass-row" + (state.selectedPass === index ? " is-selected" : "");
      btn.dataset.index = String(index);
      btn.title = `${Astro.utcClock(pass.start)} → ${Astro.utcClock(pass.end)} UTC · peak ${Astro.utcClock(pass.peak)} UTC`;

      const visibleIcon = pass.visible
        ? `<span class="pass-visible" title="Likely visible: ISS sunlit, station in darkness"><svg class="icon"><use href="#i-sun"/></svg></span>`
        : "";

      btn.innerHTML = `
        <span class="pass-time"><strong>${Astro.utcClock(pass.start, false)}</strong><span>UTC</span></span>
        <span class="pass-info">
          <span class="pass-title">MAX ${Math.round(pass.maxElevation)}° · ${Astro.formatDuration(pass.duration * 1000)}</span>
          <span class="pass-sub">
            <span>${Astro.compass(pass.startAz)} → ${Astro.compass(pass.endAz)}</span>
            <span class="pass-rel" data-peak="${pass.peak.getTime()}" data-end="${pass.end.getTime()}">${passRelative(pass)}</span>
            ${visibleIcon}
          </span>
        </span>
        <svg class="pass-arrow"><use href="#i-chevron"/></svg>
      `;
      list.appendChild(btn);
    });
  }

  function passRelative(pass) {
    const now = Date.now();
    if (now > pass.end.getTime()) return "passed";
    if (now >= pass.peak.getTime()) return "in progress";
    return `in ${Astro.formatDuration(pass.peak.getTime() - now)}`;
  }

  function refreshPassCountdowns() {
    const now = Date.now();
    document.querySelectorAll(".pass-rel").forEach((el) => {
      const peak = Number(el.dataset.peak);
      const end = Number(el.dataset.end);
      let text;
      if (!Number.isFinite(peak)) return;
      if (now > end) text = "passed";
      else if (now >= peak) text = "in progress";
      else text = `in ${Astro.formatDuration(peak - now)}`;
      if (el.textContent !== text) el.textContent = text;
    });
  }

  function renderScrubTicks() {
    const holder = $("scrub-ticks");
    holder.innerHTML = "";
    const now = Date.now();
    for (const pass of state.passes) {
      const mins = (pass.peak.getTime() - now) / 60000;
      if (mins < SLIDER_MIN || mins > SLIDER_MAX) continue;
      const pct = ((mins - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
      const tick = document.createElement("span");
      tick.className = "scrub-tick";
      tick.style.left = `${pct}%`;
      tick.title = `Predicted pass · ${Astro.utcClock(pass.peak)} UTC · max ${Math.round(pass.maxElevation)}°`;
      holder.appendChild(tick);
    }
  }

  function jumpToPass(index) {
    const pass = state.passes[index];
    if (!pass) return;
    state.selectedPass = index;
    state.offsetMs = pass.peak.getTime() - Date.now();
    state.live = false;
    state.playing = false;
    state.speed = 1;
    syncPlayButton();
    syncFollowUI();
    setText("btn-speed", "1×");
    $("btn-live").classList.remove("is-active");
    renderPassList();
    updateStatus();
    toast(`Jumped to pass peak · ${Astro.utcClock(pass.peak)} UTC`);
  }

  /* ============================================================
     Observer
     ============================================================ */

  function setObserver(lat, lon, name) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    state.observer = {
      lat: Astro.clamp(lat, -89.9, 89.9),
      lon: Astro.normalizeLon(lon),
      name: name || "Custom site",
      inView: false,
    };
    state.selectedPass = -1;
    updateObserverUI();
    clearTimeout(state.observerTimer);
    state.observerTimer = setTimeout(computePasses, 240);
  }

  function updateObserverUI() {
    const obs = state.observer;
    setText("obs-name", obs.name || "Custom site");
    setText("obs-coords", `${Astro.formatLat(obs.lat)} · ${Astro.formatLon(obs.lon)}`);
    const latInput = $("obs-lat");
    const lonInput = $("obs-lon");
    if (latInput && document.activeElement !== latInput) latInput.value = obs.lat.toFixed(4);
    if (lonInput && document.activeElement !== lonInput) lonInput.value = obs.lon.toFixed(4);
  }

  function openObserverModal() {
    updateObserverUI();
    openModal("observer-modal");
    setTimeout(() => $("obs-lat").focus(), 80);
  }

  function applyObserverForm(event) {
    event.preventDefault();
    const lat = parseFloat($("obs-lat").value);
    const lon = parseFloat($("obs-lon").value);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      toast("Latitude must be between −90 and 90.");
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      toast("Longitude must be between −180 and 180.");
      return;
    }
    setObserver(lat, lon, "Custom site");
    closeModals();
    toast(`Ground station set to ${Astro.formatLat(lat)} · ${Astro.formatLon(lon)}`);
  }

  function useMyLocation() {
    const btn = $("btn-geolocate");
    if (!navigator.geolocation) {
      toast("Geolocation is not supported by this browser.");
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        btn.innerHTML = original;
        const { latitude, longitude } = pos.coords;
        setObserver(latitude, longitude, "My location");
        closeModals();
        toast(`Ground station set to ${Astro.formatLat(latitude)} · ${Astro.formatLon(longitude)}`);
      },
      (err) => {
        btn.disabled = false;
        btn.innerHTML = original;
        const messages = {
          1: "Location permission denied. Click the globe instead.",
          2: "Location unavailable. Click the globe instead.",
          3: "Location request timed out. Click the globe instead.",
        };
        toast(messages[err.code] || "Could not get your location.");
      },
      { timeout: 9000, maximumAge: 120000 }
    );
  }

  /* ============================================================
     Controls
     ============================================================ */

  function setFollow(value) {
    state.follow = !!value;
    globe.follow = state.follow;
    syncFollowUI();
  }

  function syncFollowUI() {
    const active = state.follow;
    const chip = $("follow-chip");
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
    setText("follow-text", active ? "Following ISS" : "Follow ISS");

    const btn = $("btn-follow");
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
    $("toggle-follow").checked = active;
  }

  function syncPlayButton() {
    const icon = $("play-icon");
    icon.setAttribute("href", state.playing ? "#i-pause" : "#i-play");
    const btn = $("btn-play");
    btn.setAttribute("aria-label", state.playing ? "Pause simulation" : "Play simulation");
    btn.title = state.playing ? "Pause (Space)" : "Play (Space)";
    $("btn-live").classList.toggle("is-active", state.live);
    $("btn-live").setAttribute("aria-pressed", String(state.live));
  }

  function syncLayerInputs() {
    document.querySelectorAll("[data-layer]").forEach((input) => {
      const key = input.dataset.layer;
      input.checked = !!state.layers[key];
    });
  }

  function togglePlay() {
    if (state.playing) {
      state.playing = false;
      state.live = false;
    } else {
      state.playing = true;
      if (state.speed === 1 && Math.abs(state.offsetMs) < 2000) state.live = true;
      state.selectedPass = -1;
      renderPassList();
    }
    syncPlayButton();
    updateStatus();
  }

  function cycleSpeed() {
    const index = SPEEDS.indexOf(state.speed);
    const next = SPEEDS[(index + 1) % SPEEDS.length];
    state.speed = next;
    state.playing = true;
    if (next > 1) {
      state.live = false;
    } else if (Math.abs(state.offsetMs) < 2000) {
      state.live = true;
    }
    state.selectedPass = -1;
    renderPassList();
    setText("btn-speed", `${next}×`);
    syncPlayButton();
    updateStatus();
    toast(next === 1 ? "Real-time playback" : `Time-lapse ${next}×`);
  }

  function goLive() {
    const wasLive = state.live && state.playing;
    state.live = true;
    state.playing = true;
    state.speed = 1;
    state.offsetMs = 0;
    state.selectedPass = -1;
    setText("btn-speed", "1×");
    syncPlayButton();
    renderPassList();
    updateStatus();
    if (!wasLive) toast("Live tracking resumed");
  }

  function onScrub(event) {
    const minutes = parseFloat(event.target.value);
    state.offsetMs = minutes * 60000;
    state.live = false;
    state.playing = false;
    if (state.selectedPass >= 0) {
      state.selectedPass = -1;
      document.querySelectorAll(".pass-row.is-selected").forEach((row) => row.classList.remove("is-selected"));
    }
    syncPlayButton();
    updateStatus();
  }

  /* ============================================================
     Layer popover & modals
     ============================================================ */

  function setLayersOpen(open) {
    const pop = $("layers-pop");
    const btn = $("btn-layers");
    const wasOpen = !pop.hidden;
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      if (!wasOpen) {
        state.layersReturnFocus = document.activeElement;
        setTimeout(() => $("layers-close").focus(), 0);
      }
    } else if (wasOpen && state.layersReturnFocus) {
      state.layersReturnFocus.focus();
      state.layersReturnFocus = null;
    }
  }

  function openModal(id) {
    const previous = document.activeElement;
    closeModals(false);
    const modal = $(id);
    if (!modal) return;
    state.modalReturnFocus = previous;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    const focusable = modal.querySelector("button, input, select, textarea");
    if (focusable) setTimeout(() => focusable.focus(), 60);
  }

  function closeModals(restoreFocus = true) {
    const hadOpen = Array.from(document.querySelectorAll(".modal")).some((modal) => !modal.hidden);
    document.querySelectorAll(".modal").forEach((modal) => { modal.hidden = true; });
    document.body.classList.remove("modal-open");
    if (restoreFocus && hadOpen && state.modalReturnFocus && document.contains(state.modalReturnFocus)) {
      state.modalReturnFocus.focus();
    }
    state.modalReturnFocus = null;
  }

  function trapModalFocus(event, modal) {
    const focusables = Array.from(
      modal.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ============================================================
     Events
     ============================================================ */

  function bindUI() {
    $("btn-play").addEventListener("click", togglePlay);
    $("btn-speed").addEventListener("click", cycleSpeed);
    $("btn-live").addEventListener("click", goLive);
    $("time-slider").addEventListener("input", onScrub);

    $("btn-follow").addEventListener("click", () => setFollow(!state.follow));
    $("follow-chip").addEventListener("click", () => {
      setFollow(true);
      globe.zoomTarget = 1;
    });
    $("toggle-follow").addEventListener("change", (event) => setFollow(event.target.checked));
    $("btn-zoom-in").addEventListener("click", () => globe.zoomBy(1.28));
    $("btn-zoom-out").addEventListener("click", () => globe.zoomBy(0.78));

    $("btn-layers").addEventListener("click", (event) => {
      event.stopPropagation();
      setLayersOpen($("layers-pop").hidden);
    });
    $("layers-close").addEventListener("click", () => setLayersOpen(false));
    document.addEventListener("pointerdown", (event) => {
      const pop = $("layers-pop");
      if (pop.hidden) return;
      if (pop.contains(event.target) || $("btn-layers").contains(event.target)) return;
      setLayersOpen(false);
    });

    document.querySelectorAll("[data-layer]").forEach((input) => {
      input.addEventListener("change", () => {
        state.layers[input.dataset.layer] = input.checked;
      });
    });

    $("btn-about").addEventListener("click", () => openModal("about-modal"));
    $("btn-observer").addEventListener("click", openObserverModal);
    $("observer-form").addEventListener("submit", applyObserverForm);
    $("btn-geolocate").addEventListener("click", useMyLocation);

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", closeModals);
    });
    document.querySelectorAll(".modal").forEach((modal) => {
      modal.addEventListener("pointerdown", (event) => {
        if (event.target === modal) closeModals();
      });
    });

    $("pass-list").addEventListener("click", (event) => {
      const row = event.target.closest(".pass-row");
      if (!row) return;
      jumpToPass(Number(row.dataset.index));
    });

    document.addEventListener("keydown", onKeyDown);
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const openDialog = document.querySelector(".modal:not([hidden])");
    if (openDialog) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModals();
      } else if (event.key === "Tab") {
        trapModalFocus(event, openDialog);
      }
      return;
    }

    if (event.key === "Escape") {
      setLayersOpen(false);
      return;
    }

    const target = event.target;
    if (target && target.closest && target.closest("input, textarea, select, button, a, [contenteditable='true']")) return;

    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
      return;
    }

    const key = event.key.toLowerCase();
    const layerKeys = { o: "orbit", t: "track", n: "night", g: "grid" };

    if (event.key === "?") {
      event.preventDefault();
      openModal("about-modal");
    } else if (key === "l") {
      goLive();
    } else if (key === "f") {
      setFollow(!state.follow);
    } else if (key === "r") {
      setFollow(true);
      globe.resetView();
      toast("View reset · following the ISS");
    } else if (layerKeys[key]) {
      const layer = layerKeys[key];
      state.layers[layer] = !state.layers[layer];
      syncLayerInputs();
    }
  }

  /* ============================================================
     Kick off
     ============================================================ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
