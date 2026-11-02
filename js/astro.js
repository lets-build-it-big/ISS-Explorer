/* ============================================================
   ISS Explorer — orbital & solar math
   Thin, well-tested helpers around satellite.js
   ============================================================ */

(function (global) {
  "use strict";

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const TAU = Math.PI * 2;
  const EARTH_RADIUS_KM = 6378.137;
  const MU = 398600.4418; // km^3 / s^2

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const deg2rad = (d) => d * D2R;
  const rad2deg = (r) => r * R2D;

  function normalizeLon(lon) {
    let l = ((lon + 180) % 360 + 360) % 360 - 180;
    return l;
  }

  function compass(az) {
    if (!Number.isFinite(az)) return "—";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round((((az % 360) + 360) % 360) / 45) % 8];
  }

  function parseTleEpoch(line1) {
    const yy = parseInt(line1.slice(18, 20), 10);
    const day = parseFloat(line1.slice(20, 32));
    if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    return new Date(Date.UTC(year, 0, 1) + (day - 1) * 86400000);
  }

  function tleMeta(line1, line2) {
    const epoch = parseTleEpoch(line1);
    const inclination = parseFloat(line2.slice(8, 16));
    const ecc = parseFloat("0." + line2.slice(26, 33).trim());
    const meanMotion = parseFloat(line2.slice(52, 63));
    const rev = parseInt(line2.slice(63, 68), 10);

    let apogee = null;
    let perigee = null;
    let semiMajor = null;
    if (Number.isFinite(meanMotion) && meanMotion > 0) {
      const n = (meanMotion * TAU) / 86400;
      semiMajor = Math.cbrt(MU / (n * n));
      apogee = semiMajor * (1 + ecc) - EARTH_RADIUS_KM;
      perigee = semiMajor * (1 - ecc) - EARTH_RADIUS_KM;
    }

    return {
      epoch,
      inclination,
      eccentricity: ecc,
      meanMotion,
      periodMin: Number.isFinite(meanMotion) ? 1440 / meanMotion : null,
      revolutionsPerDay: meanMotion,
      rev,
      semiMajor,
      apogee,
      perigee,
    };
  }

  /* ---------- Sun ---------- */

  /**
   * Low-precision solar position (NOAA), accurate to ~0.01°.
   * Returns a geocentric equatorial (ECI) unit vector plus sub-solar point.
   */
  function sunState(dateMs) {
    const jd = dateMs / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const L = deg2rad((280.460 + 0.9856474 * n) % 360);
    const g = deg2rad((357.528 + 0.9856003 * n) % 360);
    const lambda = L + deg2rad(1.915) * Math.sin(g) + deg2rad(0.020) * Math.sin(2 * g);
    const eps = deg2rad(23.439 - 0.0000004 * n);

    const eci = {
      x: Math.cos(lambda),
      y: Math.cos(eps) * Math.sin(lambda),
      z: Math.sin(eps) * Math.sin(lambda),
    };
    const ra = Math.atan2(eci.y, eci.x);
    const dec = Math.asin(clamp(eci.z, -1, 1));
    const gmst = satellite.gstime(new Date(dateMs));
    const lon = normalizeLon(rad2deg(ra - gmst));
    const lat = rad2deg(dec);

    // Sun direction in Earth-fixed coordinates
    const cg = Math.cos(gmst);
    const sg = Math.sin(gmst);
    const ecef = {
      x: eci.x * cg + eci.y * sg,
      y: -eci.x * sg + eci.y * cg,
      z: eci.z,
    };

    return { eci, ecef, lat, lon, ra: rad2deg(ra), dec: lat, eclipticLon: rad2deg(lambda) };
  }

  function sunElevationAt(lat, lon, dateMs) {
    const sun = sunState(dateMs);
    const phi = deg2rad(lat);
    const lam = deg2rad(lon);
    const normal = {
      x: Math.cos(phi) * Math.cos(lam),
      y: Math.cos(phi) * Math.sin(lam),
      z: Math.sin(phi),
    };
    return rad2deg(Math.asin(clamp(
      normal.x * sun.ecef.x + normal.y * sun.ecef.y + normal.z * sun.ecef.z,
      -1, 1
    )));
  }

  /* ---------- Satellite state ---------- */

  function groundState(satrec, date) {
    const ms = date instanceof Date ? date.getTime() : date;
    const when = new Date(ms);
    const pv = satellite.propagate(satrec, when);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;

    const gmst = satellite.gstime(when);
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const lat = satellite.degreesLat(geo.latitude);
    const lon = normalizeLon(satellite.degreesLong(geo.longitude));
    const alt = geo.height;
    const speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) * 3600;

    const sun = sunState(ms);
    const rx = pv.position.x, ry = pv.position.y, rz = pv.position.z;
    const sunlit = rx * sun.eci.x + ry * sun.eci.y + rz * sun.eci.z > 0;

    // Orbit-plane normal and solar beta angle
    const nx = pv.position.y * pv.velocity.z - pv.position.z * pv.velocity.y;
    const ny = pv.position.z * pv.velocity.x - pv.position.x * pv.velocity.z;
    const nz = pv.position.x * pv.velocity.y - pv.position.y * pv.velocity.x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const beta = rad2deg(Math.asin(clamp(
      (nx * sun.eci.x + ny * sun.eci.y + nz * sun.eci.z) / nl,
      -1, 1
    )));

    return {
      date: when,
      lat,
      lon,
      alt,
      speed,
      sunlit,
      beta,
      gmst,
      positionEci: pv.position,
      velocityEci: pv.velocity,
      sun,
    };
  }

  function lookAngles(satrec, date, observer) {
    const when = date instanceof Date ? date : new Date(date);
    const pv = satellite.propagate(satrec, when);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const gmst = satellite.gstime(when);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(
      {
        latitude: deg2rad(observer.lat),
        longitude: deg2rad(observer.lon),
        height: 0,
      },
      ecf
    );
    return {
      elevation: rad2deg(look.elevation),
      azimuth: ((rad2deg(look.azimuth) % 360) + 360) % 360,
      range: look.rangeSat,
    };
  }

  /* ---------- Pass prediction ---------- */

  function computePasses(satrec, observer, startDate, hours, minElevation) {
    const start = startDate instanceof Date ? startDate.getTime() : startDate;
    const end = start + hours * 3600e3;
    const step = 20000;
    const passes = [];
    let current = null;
    let previousElevation = null;

    const finalize = (endMs, endAz) => {
      if (!current) return;
      current.end = new Date(endMs);
      current.endAz = endAz;
      current.duration = Math.max(0, (endMs - current.start.getTime()) / 1000);
      const peak = groundState(satrec, current.peak);
      const obsSun = sunElevationAt(observer.lat, observer.lon, current.peak.getTime());
      current.sunlit = peak ? peak.sunlit : false;
      current.observerDark = obsSun < -6;
      current.visible = current.sunlit && current.observerDark;
      if (current.maxElevation >= minElevation) passes.push(current);
      current = null;
    };

    for (let t = start; t <= end; t += step) {
      const look = lookAngles(satrec, new Date(t), observer);
      if (!look) { previousElevation = null; continue; }
      const elev = look.elevation;

      if (elev > 0) {
        if (!current) {
          current = {
            start: new Date(t),
            startAz: look.azimuth,
            maxElevation: elev,
            peak: new Date(t),
            inProgress: t === start && previousElevation === null,
          };
        } else if (elev > current.maxElevation) {
          current.maxElevation = elev;
          current.peak = new Date(t);
        }
      } else if (current) {
        finalize(t, look.azimuth);
      }
      previousElevation = elev;
    }

    if (current) finalize(end, current.startAz);

    return passes
      .filter((p) => p.maxElevation >= minElevation)
      .sort((a, b) => a.start - b.start);
  }

  /* ---------- Sunlight timeline ---------- */

  function lightSegments(satrec, fromDate, minutes, stepSeconds) {
    const start = fromDate instanceof Date ? fromDate.getTime() : fromDate;
    const step = (stepSeconds || 30) * 1000;
    const end = start + minutes * 60000;
    const segments = [];
    let current = null;

    for (let t = start; t <= end; t += step) {
      const state = groundState(satrec, new Date(t));
      if (!state) continue;
      if (!current || current.sunlit !== state.sunlit) {
        if (current) {
          current.end = new Date(t);
          segments.push(current);
        }
        current = { start: new Date(t), end: null, sunlit: state.sunlit };
      }
    }

    if (current) {
      current.end = new Date(end);
      segments.push(current);
    }

    for (const seg of segments) {
      if (!seg.end) seg.end = new Date(end);
      seg.durationMs = Math.max(0, seg.end - seg.start);
    }
    return segments;
  }

  /* ---------- Formatting ---------- */

  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  function pad(n) { return String(Math.floor(n)).padStart(2, "0"); }

  function utcClock(date, seconds) {
    return pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) +
      (seconds === false ? "" : ":" + pad(date.getUTCSeconds()));
  }

  function utcDate(date) {
    return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  function utcShortDate(date) {
    return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]}`;
  }

  function formatLat(lat) {
    if (!Number.isFinite(lat)) return "—";
    const v = Math.abs(lat);
    return `${v.toFixed(2)}° ${lat >= 0 ? "N" : "S"}`;
  }

  function formatLon(lon) {
    if (!Number.isFinite(lon)) return "—";
    const v = Math.abs(lon);
    return `${v.toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
  }

  function formatSigned(value, digits) {
    const d = digits == null ? 1 : digits;
    return (value >= 0 ? "+" : "−") + Math.abs(value).toFixed(d);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(s)}s`;
    return `${s}s`;
  }

  function offsetLabel(ms) {
    if (!Number.isFinite(ms) || Math.abs(ms) < 1500) return "LIVE";
    const sign = ms > 0 ? "+" : "−";
    const totalMin = Math.round(Math.abs(ms) / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${sign}${h}H ${pad(m)}M`;
    return `${sign}${m}M`;
  }

  function countdown(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—:—";
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  global.Astro = {
    D2R, R2D, EARTH_RADIUS_KM,
    clamp,
    deg2rad,
    rad2deg,
    normalizeLon,
    compass,
    parseTleEpoch,
    tleMeta,
    sunState,
    sunElevationAt,
    groundState,
    lookAngles,
    computePasses,
    lightSegments,
    utcClock,
    utcDate,
    utcShortDate,
    formatLat,
    formatLon,
    formatSigned,
    formatDuration,
    offsetLabel,
    countdown,
  };
})(window);
