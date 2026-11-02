/* ============================================================
   ISS Explorer — canvas globe renderer
   Orthographic projection, clipped coastlines, terminator,
   orbit track and ISS marker. No dependencies except LAND data.
   ============================================================ */

(function (global) {
  "use strict";

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const TAU = Math.PI * 2;
  const RE_KM = 6378.137;

  const CITIES = [
    [40.71, -74.01, 1.4], [34.05, -118.24, 1.3], [41.88, -87.63, 1.2], [43.65, -79.38, 1.1],
    [19.43, -99.13, 1.4], [-23.55, -46.63, 1.5], [-22.91, -43.17, 1.1], [-34.6, -58.38, 1.2],
    [-33.45, -70.67, 1.0], [-12.05, -77.04, 0.9], [4.71, -74.07, 0.9], [10.48, -66.9, 0.8],
    [51.51, -0.13, 1.4], [48.86, 2.35, 1.4], [40.42, -3.7, 1.1], [41.9, 12.5, 1.0],
    [52.52, 13.4, 1.1], [55.76, 37.62, 1.4], [59.33, 18.07, 0.8], [59.91, 10.75, 0.7],
    [50.11, 8.68, 0.9], [47.38, 8.54, 0.7], [45.46, 9.19, 0.9], [41.01, 28.98, 1.2],
    [30.04, 31.24, 1.3], [6.52, 3.38, 1.3], [-1.29, 36.82, 0.9], [-26.2, 28.05, 1.0],
    [-33.92, 18.42, 0.8], [25.2, 55.27, 1.1], [24.71, 46.68, 0.9], [35.69, 51.39, 1.1],
    [19.08, 72.88, 1.5], [28.61, 77.21, 1.5], [22.57, 88.36, 1.3], [13.08, 80.27, 1.0],
    [23.81, 90.41, 1.2], [13.76, 100.5, 1.3], [1.35, 103.82, 1.1], [3.14, 101.69, 1.0],
    [-6.21, 106.85, 1.4], [14.6, 120.98, 1.2], [22.32, 114.17, 1.5], [31.23, 121.47, 1.5],
    [39.9, 116.4, 1.5], [37.57, 126.98, 1.4], [35.68, 139.69, 1.6], [34.69, 135.5, 1.2],
    [-33.87, 151.21, 1.3], [-37.81, 144.96, 1.1], [-27.47, 153.03, 0.8], [-31.95, 115.86, 0.7],
    [35.68, 51.39, 0.9], [32.09, 34.78, 0.9], [33.89, 35.5, 0.7], [21.49, -157.86, 0.6],
    [61.22, -149.9, 0.5], [64.15, -21.94, 0.4], [53.35, -6.26, 0.7], [38.72, -9.14, 0.8],
  ];

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function shortestDelta(a, b) { return ((b - a + 540) % 360) - 180; }
  function normalize3(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    return { x: x / l, y: y / l, z: z / l };
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  class ISSGlobe {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.options = options || {};
      this.cam = { lat: 24, lon: -60 };
      this.camInitialized = false;
      this.follow = true;
      this.zoom = 1;
      this.zoomTarget = 1;
      this.baseR = 300;
      this.R = 300;
      this.cx = 0;
      this.cy = 0;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.data = null;
      this.time = 0;
      this.lastFrame = 0;
      this.lastInteract = -1e9;
      this.dragging = false;
      this.dragDistance = 0;
      this.pointers = new Map();
      this.spin = { lon: 0, lat: 0 };
      this.pinchDistance = null;
      this.hover = null;
      this.starCanvas = null;
      this.nightCanvas = document.createElement("canvas");
      this.nightCanvas.width = 220;
      this.nightCanvas.height = 220;
      this.nightCtx = this.nightCanvas.getContext("2d");
      this._bind();
      this.resize();
      if (typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas.parentElement || canvas);
      } else {
        window.addEventListener("resize", () => this.resize());
      }
    }

    /* ---------------- public API ---------------- */

    update(data) {
      this.data = data;
      if (data && data.follow !== undefined) this.follow = data.follow !== false;
      if (!this.camInitialized && data && data.sat) {
        this.cam.lat = data.sat.lat;
        this.cam.lon = data.sat.lon;
        this.camInitialized = true;
      }
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === this.w && h === this.h) return;
      this.w = w;
      this.h = h;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const compact = w < 720;
      const reserve = compact ? 116 : 86;
      const availH = Math.max(220, h - reserve);
      this.baseR = Math.min(w * 0.43, availH * 0.47, 440);
      this.cx = w / 2;
      this.cy = (h - reserve) / 2 + 6;
      this.makeStars();
      this.render(performance.now(), false);
    }

    zoomBy(factor) {
      this.zoomTarget = clamp(this.zoomTarget * factor, 0.8, 2.8);
    }

    resetView() {
      this.follow = true;
      this.zoomTarget = 1;
      this.lastInteract = performance.now();
      if (this.data && this.data.sat) {
        this.cam.lat = this.data.sat.lat;
        this.cam.lon = this.data.sat.lon;
      }
    }

    setZoom(zoom) {
      this.zoomTarget = clamp(zoom, 0.8, 2.8);
    }

    /* ---------------- camera helpers ---------------- */

    _updateTrig() {
      this._cp = Math.cos(this.cam.lat * D2R);
      this._sp = Math.sin(this.cam.lat * D2R);
      this._cl = Math.cos(this.cam.lon * D2R);
      this._sl = Math.sin(this.cam.lon * D2R);
    }

    geoToCam(lat, lon) {
      const phi = lat * D2R;
      const dl = (lon - this.cam.lon) * D2R;
      const cp = Math.cos(phi);
      const x1 = cp * Math.sin(dl);
      const y1 = cp * Math.cos(dl);
      const z1 = Math.sin(phi);
      return {
        x: x1,
        y: this._cp * z1 - this._sp * y1,
        z: this._sp * z1 + this._cp * y1,
      };
    }

    ecefToCam(v) {
      const x1 = v.x * this._cl + v.y * this._sl;
      const y1 = -v.x * this._sl + v.y * this._cl;
      const z1 = v.z;
      return {
        x: x1,
        y: this._cp * z1 - this._sp * y1,
        z: this._sp * z1 + this._cp * y1,
      };
    }

    camToGeo(sx, sy) {
      const R = this.R;
      const x = (sx - this.cx) / R;
      const y = -(sy - this.cy) / R;
      const r2 = x * x + y * y;
      if (r2 > 1) return null;
      const z = Math.sqrt(1 - r2);
      const y1 = this._cp * y + this._sp * z;
      const z1 = -this._sp * y + this._cp * z;
      return {
        lat: Math.asin(clamp(z1, -1, 1)) * R2D,
        lon: ((this.cam.lon + Math.atan2(x, y1) * R2D + 540) % 360) - 180,
      };
    }

    project(v) {
      return {
        x: this.cx + v.x * this.R,
        y: this.cy - v.y * this.R,
        z: v.z,
      };
    }

    /* ---------------- star field ---------------- */

    makeStars() {
      const c = document.createElement("canvas");
      const w = this.w;
      const h = this.h;
      const dpr = this.dpr;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      const g = c.getContext("2d");
      g.scale(dpr, dpr);

      let seed = 20261101;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      for (let i = 0; i < 560; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = rand() < 0.035 ? 1.15 + rand() * 0.9 : 0.25 + rand() * 0.8;
        const a = 0.12 + rand() * 0.6;
        const tint = rand();
        const color = tint > 0.82 ? `rgba(174,224,240,${a})` : tint > 0.5 ? `rgba(202,220,235,${a})` : `rgba(255,248,232,${a})`;
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
        if (r > 1.1) {
          g.globalAlpha = 0.25;
          g.strokeStyle = color;
          g.lineWidth = 0.5;
          g.beginPath();
          g.moveTo(x - r * 3, y);
          g.lineTo(x + r * 3, y);
          g.moveTo(x, y - r * 3);
          g.lineTo(x, y + r * 3);
          g.stroke();
          g.globalAlpha = 1;
        }
      }
      this.starCanvas = c;
    }

    /* ---------------- interaction ---------------- */

    _bind() {
      const canvas = this.canvas;

      canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.lastInteract = performance.now();
        this.spin.lon = 0;
        this.spin.lat = 0;
        if (this.pointers.size === 1) {
          this.dragging = false;
          this.dragDistance = 0;
          this.dragStart = { x: e.clientX, y: e.clientY, t: performance.now() };
          this.lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
        } else if (this.pointers.size === 2) {
          const pts = [...this.pointers.values()];
          this.pinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          this.pinched = true;
          this._setFollowing(false);
          this.options.onInteract && this.options.onInteract();
        }
      });

      canvas.addEventListener("pointermove", (e) => {
        if (!this.pointers.has(e.pointerId)) {
          this._emitHover(e);
          return;
        }
        const prev = this.pointers.get(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pointers.size >= 2) {
          const pts = [...this.pointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (this.pinchDistance) {
            this.zoomTarget = clamp(this.zoomTarget * (dist / this.pinchDistance), 0.8, 2.8);
          }
          this.pinchDistance = dist;
          this.lastInteract = performance.now();
          return;
        }

        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        this.dragDistance += Math.hypot(dx, dy);
        if (!this.dragging && this.dragDistance > 4) {
          this.dragging = true;
          this._setFollowing(false);
          this.options.onInteract && this.options.onInteract();
        }
        if (!this.dragging) return;

        const now = performance.now();
        const dt = Math.max(8, now - this.lastPointer.t);
        const k = 57.2958 / (this.R * this.zoom);
        const dLon = -dx * k;
        const dLat = dy * k;
        this.cam.lon = ((this.cam.lon + dLon + 540) % 360) - 180;
        this.cam.lat = clamp(this.cam.lat + dLat, -89.5, 89.5);
        this.spin.lon = clamp((dLon / dt) * 1000, -80, 80);
        this.spin.lat = clamp((dLat / dt) * 1000, -80, 80);
        this.lastPointer = { x: e.clientX, y: e.clientY, t: now };
        this.lastInteract = now;
        this.options.onCamera && this.options.onCamera(this.cam);
      });

      const endPointer = (e) => {
        const wasDragging = this.dragging;
        const start = this.dragStart;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinchDistance = null;
        if (this.pointers.size === 0) {
          this.dragging = false;
          if (e.type === "pointerup" && !wasDragging && !this.pinched && start && performance.now() - start.t < 800) {
            const rect = this.canvas.getBoundingClientRect();
            const geo = this.camToGeo(e.clientX - rect.left, e.clientY - rect.top);
            if (geo) {
              this.options.onPick && this.options.onPick(geo);
            }
          }
          if (wasDragging) {
            this.lastInteract = performance.now();
          }
          this.pinched = false;
        }
      };
      canvas.addEventListener("pointerup", endPointer);
      canvas.addEventListener("pointercancel", endPointer);

      canvas.addEventListener("pointerleave", () => {
        if (this.pointers.size === 0) {
          this.options.onHover && this.options.onHover(null);
          this.hover = null;
        }
      });

      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0011);
        this.zoomTarget = clamp(this.zoomTarget * factor, 0.8, 2.8);
        this.lastInteract = performance.now();
      }, { passive: false });

      canvas.addEventListener("dblclick", () => {
        this.resetView();
        this.options.onReset && this.options.onReset();
      });
    }

    _setFollowing(value) {
      if (this.follow === value) return;
      this.follow = value;
      this.options.onFollowChange && this.options.onFollowChange(value);
    }

    _emitHover(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const geo = this.camToGeo(x, y);
      this.hover = geo ? { x, y, ...geo } : null;
      this.options.onHover && this.options.onHover(geo ? { ...geo, x, y } : null);
    }

    /* ---------------- render ---------------- */

    render(now, advance) {
      if (advance === undefined) advance = true;
      const ctx = this.ctx;
      const dt = Math.min(0.1, Math.max(0, (now - (this.lastFrame || now)) / 1000));
      this.lastFrame = now;
      this.time = now;

      if (!this.w) return;
      ctx.clearRect(0, 0, this.w, this.h);
      if (this.starCanvas) ctx.drawImage(this.starCanvas, 0, 0, this.w, this.h);

      this._updateCamera(now, dt);
      this._updateTrig();
      this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 12 || 0.2);
      this.R = this.baseR * this.zoom;

      const data = this.data || {};
      const R = this.R;
      const cx = this.cx;
      const cy = this.cy;
      const sat = data.sat;
      const sun = data.sun || (sat && sat.sun);

      // outer atmosphere
      const halo = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.18);
      halo.addColorStop(0, "rgba(90, 220, 225, 0.13)");
      halo.addColorStop(0.45, "rgba(60, 150, 190, 0.055)");
      halo.addColorStop(1, "rgba(30, 90, 140, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.18, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.clip();

      this.drawOcean(R);
      if (!data.layers || data.layers.grid) this.drawGraticule(R);
      this.drawLand(R);
      this.drawSunGlint(R, sun);
      if (!data.layers || data.layers.night) this.drawNight(R, sun);

      const obs = data.observer;
      if ((!data.layers || data.layers.footprint) && sat) this.drawFootprint(R, sat);
      if (!data.layers || data.layers.track) {
        this.drawGroundTrack(R, data.trackPast, "past");
        this.drawGroundTrack(R, data.trackFuture, "future");
      }

      this.drawRimShade(R);
      ctx.restore();

      if (!data.layers || data.layers.orbit) this.drawOrbit(R, data.orbit, data.gmst);
      this.drawAtmosphereRim(R);

      const labels = data.layers ? data.layers.labels : true;
      if (obs) this.drawObserver(R, obs, labels ? sat : null);
      if (sat) this.drawISS(R, sat, labels);

      this.drawHover();
    }

    _updateCamera(now, dt) {
      const sat = this.data && this.data.sat;
      if (this.follow && sat) {
        const k = 1 - Math.exp(-dt * 5.5);
        this.cam.lat += (sat.lat - this.cam.lat) * k;
        this.cam.lon += shortestDelta(this.cam.lon, sat.lon) * k;
      } else if (!this.dragging) {
        if (Math.abs(this.spin.lon) > 0.02 || Math.abs(this.spin.lat) > 0.02) {
          this.cam.lon = ((this.cam.lon + this.spin.lon * dt + 540) % 360) - 180;
          this.cam.lat = clamp(this.cam.lat + this.spin.lat * dt, -89.5, 89.5);
          const decay = Math.exp(-dt * 4.2);
          this.spin.lon *= decay;
          this.spin.lat *= decay;
        } else if (now - this.lastInteract > 15000) {
          this.cam.lon = ((this.cam.lon + dt * 1.2 + 540) % 360) - 180;
        }
      }
      this.cam.lat = clamp(this.cam.lat, -89.5, 89.5);
    }

    drawOcean(R) {
      const ctx = this.ctx;
      const g = ctx.createRadialGradient(this.cx - R * 0.28, this.cy - R * 0.32, R * 0.08, this.cx, this.cy, R * 1.05);
      g.addColorStop(0, "#103349");
      g.addColorStop(0.42, "#0b2a3e");
      g.addColorStop(0.78, "#071b2b");
      g.addColorStop(1, "#041019");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R, 0, TAU);
      ctx.fill();
    }

    drawGraticule(R) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(113, 189, 212, 0.10)";
      const path = new Path2D();

      for (let lon = -180; lon < 180; lon += 30) {
        const major = lon === 0;
        let started = false;
        for (let lat = -88; lat <= 88; lat += 3) {
          const v = this.geoToCam(lat, lon);
          if (v.z >= 0) {
            const p = this.project(v);
            if (!started) { path.moveTo(p.x, p.y); started = true; }
            else path.lineTo(p.x, p.y);
          } else started = false;
        }
        if (major) {
          ctx.strokeStyle = "rgba(113, 209, 224, 0.20)";
        }
      }

      for (let lat = -60; lat <= 60; lat += 30) {
        const major = lat === 0;
        let started = false;
        for (let lon = -180; lon <= 180; lon += 3) {
          const v = this.geoToCam(lat, lon);
          if (v.z >= 0) {
            const p = this.project(v);
            if (!started) { path.moveTo(p.x, p.y); started = true; }
            else path.lineTo(p.x, p.y);
          } else started = false;
        }
        if (major) ctx.strokeStyle = "rgba(113, 209, 224, 0.18)";
      }

      ctx.stroke(path);
      ctx.restore();

      // subtle emphasized equator / prime meridian
      ctx.save();
      ctx.strokeStyle = "rgba(126, 216, 228, 0.20)";
      ctx.lineWidth = 0.8;
      for (const [type, value] of [["lat", 0], ["lon", 0]]) {
        const p = new Path2D();
        let started = false;
        for (let t = -180; t <= 180; t += 2) {
          const lat = type === "lat" ? value : t;
          const lon = type === "lat" ? t : value;
          const v = this.geoToCam(lat, lon);
          if (v.z >= 0) {
            const s = this.project(v);
            if (!started) { p.moveTo(s.x, s.y); started = true; }
            else p.lineTo(s.x, s.y);
          } else started = false;
        }
        ctx.stroke(p);
      }
      ctx.restore();
    }

    drawLand(R) {
      if (!global.LAND) return;
      const ctx = this.ctx;
      const path = new Path2D();

      for (let p = 0; p < global.LAND.length; p++) {
        const poly = global.LAND[p];
        for (let r = 0; r < poly.length; r++) {
          const ring = poly[r];
          const pts = [];
          for (let i = 0; i < ring.length; i += 2) {
            pts.push(this.geoToCam(ring[i + 1], ring[i]));
          }
          const clipped = this.clipVisible(pts);
          if (clipped.length < 3) continue;
          const s0 = this.project(clipped[0]);
          path.moveTo(s0.x, s0.y);
          for (let i = 1; i < clipped.length; i++) {
            const s = this.project(clipped[i]);
            path.lineTo(s.x, s.y);
          }
          path.closePath();
        }
      }

      const sun = (this.data && (this.data.sun || (this.data.sat && this.data.sat.sun)));
      let gx = this.cx - R * 0.3;
      let gy = this.cy - R * 0.3;
      if (sun) {
        const sv = this.ecefToCam(sun.ecef);
        if (sv.z > 0) {
          const sp = this.project(sv);
          gx = sp.x;
          gy = sp.y;
        }
      }
      const grad = ctx.createLinearGradient(gx, gy, this.cx * 2 - gx, this.cy * 2 - gy);
      grad.addColorStop(0, "rgba(66, 102, 110, 0.96)");
      grad.addColorStop(0.55, "rgba(41, 72, 81, 0.96)");
      grad.addColorStop(1, "rgba(28, 52, 62, 0.96)");

      ctx.fillStyle = grad;
      ctx.fill(path, "evenodd");
      ctx.strokeStyle = "rgba(130, 199, 212, 0.5)";
      ctx.lineWidth = 0.7;
      ctx.stroke(path);
    }

    clipVisible(points) {
      const out = [];
      const n = points.length;
      for (let i = 0; i < n; i++) {
        const a = points[i];
        const b = points[(i + 1) % n];
        const aIn = a.z >= 0;
        const bIn = b.z >= 0;
        if (aIn) out.push(a);
        if (aIn !== bIn) {
          const t = a.z / (a.z - b.z);
          out.push(normalize3(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t
          ));
        }
      }
      return out;
    }

    drawSunGlint(R, sun) {
      if (!sun) return;
      const v = this.ecefToCam(sun.ecef);
      if (v.z <= 0.02) return;
      const p = this.project(v);
      const ctx = this.ctx;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R * 0.62);
      g.addColorStop(0, "rgba(255, 238, 194, 0.12)");
      g.addColorStop(0.35, "rgba(180, 230, 230, 0.05)");
      g.addColorStop(1, "rgba(120, 200, 220, 0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    drawNight(R, sun) {
      if (!sun) return;
      const sunCam = this.ecefToCam(sun.ecef);
      const ctx = this.ctx;
      const N = 220;
      const im = this.nightCtx.createImageData(N, N);
      const data = im.data;

      for (let y = 0; y < N; y++) {
        const ny = 1 - ((y + 0.5) / N) * 2;
        for (let x = 0; x < N; x++) {
          const nx = ((x + 0.5) / N) * 2 - 1;
          const r2 = nx * nx + ny * ny;
          const idx = (y * N + x) * 4;
          if (r2 >= 1) continue;
          const nz = Math.sqrt(1 - r2);
          const dot = nx * sunCam.x + ny * sunCam.y + nz * sunCam.z;
          let night = clamp((0.07 - dot) / 0.19, 0, 1);
          night = night * night * (3 - 2 * night);
          data[idx] = 3;
          data[idx + 1] = 9;
          data[idx + 2] = 21;
          data[idx + 3] = Math.round(night * 142);
        }
      }
      this.nightCtx.putImageData(im, 0, 0);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.nightCanvas, this.cx - R, this.cy - R, R * 2, R * 2);
      ctx.restore();

      // city lights on the night side
      ctx.save();
      for (const [lat, lon, size] of CITIES) {
        const v = this.geoToCam(lat, lon);
        if (v.z < 0.03) continue;
        const dot = v.x * sunCam.x + v.y * sunCam.y + v.z * sunCam.z;
        const darkness = clamp((-dot - 0.02) / 0.22, 0, 1);
        if (darkness <= 0.02) continue;
        const p = this.project(v);
        const glow = size * 1.9;
        ctx.globalAlpha = darkness * 0.22;
        ctx.fillStyle = "rgba(255, 179, 96, 0.92)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, glow, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = darkness * 0.92;
        ctx.fillStyle = "rgba(255, 224, 172, 0.96)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 0.82, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    drawGroundTrack(R, points, kind) {
      if (!points || points.length < 2) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.lineWidth = kind === "future" ? 1 : 0.8;
      ctx.strokeStyle = kind === "future" ? "rgba(94, 234, 212, 0.34)" : "rgba(94, 234, 212, 0.14)";
      ctx.setLineDash(kind === "future" ? [1.5, 5] : [1, 6]);
      ctx.lineCap = "round";
      const path = new Path2D();
      let started = false;
      for (const pt of points) {
        const v = this.geoToCam(pt.lat, pt.lon);
        if (v.z >= 0) {
          const p = this.project(v);
          if (!started) { path.moveTo(p.x, p.y); started = true; }
          else path.lineTo(p.x, p.y);
        } else started = false;
      }
      ctx.stroke(path);
      ctx.restore();
    }

    drawFootprint(R, sat) {
      const ctx = this.ctx;
      const ang = Math.acos(RE_KM / (RE_KM + Math.max(0, sat.alt)));
      const lat1 = sat.lat * D2R;
      const lon1 = sat.lon * D2R;
      ctx.save();
      ctx.strokeStyle = "rgba(94, 234, 212, 0.22)";
      ctx.lineWidth = 0.9;
      ctx.setLineDash([2, 5]);
      const path = new Path2D();
      let started = false;
      for (let i = 0; i <= 96; i++) {
        const brg = (i / 96) * TAU;
        const lat2 = Math.asin(clamp(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg), -1, 1));
        const lon2 = lon1 + Math.atan2(
          Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
          Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
        );
        const v = this.geoToCam(lat2 * R2D, ((lon2 * R2D + 540) % 360) - 180);
        if (v.z >= 0) {
          const p = this.project(v);
          if (!started) { path.moveTo(p.x, p.y); started = true; }
          else path.lineTo(p.x, p.y);
        } else started = false;
      }
      ctx.stroke(path);
      ctx.restore();
    }

    drawOrbit(R, orbit, gmst) {
      if (!orbit || orbit.length < 2) return;
      const ctx = this.ctx;
      const cg = Math.cos(gmst || 0);
      const sg = Math.sin(gmst || 0);
      const pts = orbit.map((v) => {
        const x = v.x * cg + v.y * sg;
        const y = -v.x * sg + v.y * cg;
        return { x, y, z: v.z };
      });

      const glow = new Path2D();
      const line = new Path2D();
      const visible = [];
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i];
        const p = this.project(v);
        const ok = v.z >= 0;
        visible.push(ok);
        if (!ok) continue;
        if (i === 0 || !visible[i - 1]) glow.moveTo(p.x, p.y), line.moveTo(p.x, p.y);
        else glow.lineTo(p.x, p.y), line.lineTo(p.x, p.y);
      }

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(243, 180, 94, 0.10)";
      ctx.lineWidth = 5;
      ctx.stroke(glow);
      ctx.strokeStyle = "rgba(248, 195, 120, 0.62)";
      ctx.lineWidth = 1.15;
      ctx.stroke(line);

      // direction chevrons
      ctx.fillStyle = "rgba(255, 216, 160, 0.8)";
      for (let i = 12; i < pts.length - 6; i += 28) {
        if (!visible[i] || !visible[i + 4]) continue;
        const a = this.project(pts[i]);
        const b = this.project(pts[i + 4]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;
        ctx.beginPath();
        ctx.moveTo(a.x + ux * 3, a.y + uy * 3);
        ctx.lineTo(a.x - ux * 2 + px * 2.2, a.y - uy * 2 + py * 2.2);
        ctx.lineTo(a.x - ux * 2 - px * 2.2, a.y - uy * 2 - py * 2.2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    drawRimShade(R) {
      const ctx = this.ctx;
      const g = ctx.createRadialGradient(this.cx, this.cy, R * 0.72, this.cx, this.cy, R * 1.005);
      g.addColorStop(0, "rgba(2, 7, 12, 0)");
      g.addColorStop(0.82, "rgba(2, 7, 12, 0.10)");
      g.addColorStop(1, "rgba(1, 5, 10, 0.48)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R, 0, TAU);
      ctx.fill();
    }

    drawAtmosphereRim(R) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = "rgba(116, 226, 235, 0.30)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R, 0, TAU);
      ctx.stroke();

      const g = ctx.createRadialGradient(this.cx, this.cy, R * 0.995, this.cx, this.cy, R * 1.05);
      g.addColorStop(0, "rgba(94, 220, 232, 0.20)");
      g.addColorStop(1, "rgba(60, 140, 190, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, R * 1.05, 0, TAU);
      ctx.arc(this.cx, this.cy, R * 0.995, 0, TAU, true);
      ctx.fill();
      ctx.restore();
    }

    _issLabelRect(sat, labels) {
      if (!labels || !sat) return null;
      const v = this.geoToCam(sat.lat, sat.lon);
      if (v.z <= 0) return null;
      const p = this.project(v);
      const bx = clamp(p.x + 18, 8, this.w - 94);
      const by = clamp(p.y - 15, 14, this.h - 14);
      return { x: bx - 4, y: by - 10, w: 96, h: 27, mx: p.x, my: p.y };
    }

    drawObserver(R, obs, sat) {
      const v = this.geoToCam(obs.lat, obs.lon);
      if (v.z <= 0) return;
      const p = this.project(v);
      const ctx = this.ctx;
      const pulse = (Math.sin(this.time / 650) + 1) / 2;

      ctx.save();
      if (obs.inView) {
        ctx.strokeStyle = `rgba(243, 180, 94, ${0.35 - pulse * 0.25})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 + pulse * 7, 0, TAU);
        ctx.stroke();
      }
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#f3b45e";
      ctx.shadowColor = "rgba(243, 180, 94, 0.9)";
      ctx.shadowBlur = 8;
      ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
      ctx.restore();

      const labels = this.data && this.data.layers ? this.data.layers.labels : true;
      if (!labels) return;
      ctx.save();
      ctx.font = "500 8px 'JetBrains Mono', monospace";
      ctx.textBaseline = "alphabetic";
      const label = (obs.name || "STATION").toUpperCase().slice(0, 22);
      const tw = ctx.measureText(label).width;
      const iss = this._issLabelRect(sat, true);

      // Try below, above, left and right, then keep the label clear of the ISS
      // marker and its callout (which sits up and to the right of the station).
      const positions = [
        { align: "center", tx: p.x, ty: p.y + 17 },
        { align: "center", tx: p.x, ty: p.y - 11 },
        { align: "right", tx: p.x - 11, ty: p.y + 4 },
        { align: "left", tx: p.x + 11, ty: p.y + 4 },
      ];
      let pick = positions[0];
      let bestScore = Infinity;
      positions.forEach((pos, i) => {
        let tx = pos.tx;
        if (pos.align === "center") tx = clamp(tx, tw / 2 + 5, this.w - tw / 2 - 5);
        else if (pos.align === "right") tx = clamp(tx, tw + 5, this.w - 5);
        else tx = clamp(tx, 5, this.w - tw - 5);
        const ty = clamp(pos.ty, 11, this.h - 4);
        const x = pos.align === "center" ? tx - tw / 2 : pos.align === "right" ? tx - tw : tx;
        const y = ty - 9;
        let score = i * 2 + (tx !== pos.tx || ty !== pos.ty ? 1.5 : 0);
        if (iss) {
          const ox = Math.max(0, Math.min(x + tw, iss.x + iss.w) - Math.max(x, iss.x));
          const oy = Math.max(0, Math.min(y + 9, iss.y + iss.h) - Math.max(y, iss.y));
          score += ox * oy * 3;
          const dx = Math.max(iss.mx - (x + tw), x - iss.mx, 0);
          const dy = Math.max(iss.my - (y + 9), y - iss.my, 0);
          score += Math.max(0, 30 - Math.hypot(dx, dy)) * 2;
        }
        if (score < bestScore) {
          bestScore = score;
          pick = { align: pos.align, tx, ty };
        }
      });

      ctx.textAlign = pick.align;
      ctx.shadowColor = "rgba(0, 6, 11, 0.95)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = "rgba(255, 224, 177, 0.95)";
      ctx.fillText(label, pick.tx, pick.ty);
      ctx.restore();
    }

    drawISS(R, sat, labels) {
      const v = this.geoToCam(sat.lat, sat.lon);
      if (v.z <= 0) return;
      const p = this.project(v);
      const ctx = this.ctx;
      const t = this.time;
      const pulse = (Math.sin(t / 520) + 1) / 2;

      ctx.save();
      // acquisition rings
      ctx.strokeStyle = `rgba(94, 234, 212, ${0.30 - pulse * 0.22})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11 + pulse * 12, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = "rgba(94, 234, 212, 0.22)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, TAU);
      ctx.stroke();

      // crosshair ticks
      ctx.strokeStyle = "rgba(150, 250, 238, 0.7)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const ang = (i * Math.PI) / 2;
        const x1 = p.x + Math.cos(ang) * 8;
        const y1 = p.y + Math.sin(ang) * 8;
        const x2 = p.x + Math.cos(ang) * 12;
        const y2 = p.y + Math.sin(ang) * 12;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // tiny station glyph
      ctx.translate(p.x, p.y);
      ctx.rotate(-0.38);
      ctx.shadowColor = "rgba(94, 234, 212, 0.9)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "rgba(122, 242, 226, 0.92)";
      ctx.fillRect(-10.5, -3.2, 6.5, 6.4);
      ctx.fillRect(4, -3.2, 6.5, 6.4);
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#f4fffd";
      roundRect(ctx, -3.5, -2.4, 7, 4.8, 1);
      ctx.fill();
      ctx.restore();

      if (!labels) return;
      ctx.save();
      const labelX = p.x + 18;
      const labelY = p.y - 15;
      const bx = clamp(labelX, 8, this.w - 94);
      const by = clamp(labelY, 14, this.h - 14);
      ctx.strokeStyle = "rgba(94, 234, 212, 0.34)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x + 12, p.y - 10);
      ctx.lineTo(bx - 4, by + 2);
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.shadowColor = "rgba(0, 6, 11, 0.95)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.font = "500 9px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#eafffb";
      ctx.fillText("ISS · ZARYA", bx, by);
      ctx.font = "400 8px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(243, 180, 94, 0.92)";
      ctx.fillText(`${sat.alt.toFixed(1)} KM`, bx, by + 11);
      ctx.restore();
    }

    drawHover() {
      if (!this.hover) return;
      const ctx = this.ctx;
      const { x, y } = this.hover;
      ctx.save();
      ctx.strokeStyle = "rgba(94, 234, 212, 0.5)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 7, y); ctx.lineTo(x - 5, y);
      ctx.moveTo(x + 5, y); ctx.lineTo(x + 7, y);
      ctx.moveTo(x, y - 7); ctx.lineTo(x, y - 5);
      ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 7);
      ctx.stroke();
      ctx.restore();
    }
  }

  global.ISSGlobe = ISSGlobe;
})(window);
