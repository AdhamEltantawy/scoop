/* Scoop — explore your city on foot, one hexagon at a time.
 *
 * Visited cells are always stored at BASE_RES (the finest size). Coarser
 * hex sizes are derived on the fly with cellToParent, so switching sizes
 * never loses detail.
 */
(() => {
  'use strict';

  const BASE_RES = 10;
  const STORAGE_KEY = 'scoop.v1';
  const SETTINGS_KEY = 'scoop.settings.v1';
  const MAX_VIEW_CELLS = 6000;      // skip grid / "% of view" beyond this
  const MAX_PATH_STEPS = 20;        // fill gaps between fixes up to ~20 cells
  const MAX_WALK_SPEED = 7;         // m/s; faster than this = probably a vehicle
  const MIN_STEP_METERS = 5;        // ignore GPS jitter for distance

  const COLORS = {
    visited: '#ff7a3d',
    walk: '#ffd166',
    grid: '#1d2433',
    here: '#2f6bff',
  };

  // ---------- persistence ----------

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('Could not save — storage full or blocked. Export a backup!');
      return false;
    }
  }

  const stored = loadJSON(STORAGE_KEY, {});
  /** @type {Map<string, number>} cell -> first visited (ms epoch) */
  const visited = new Map(Object.entries(stored.cells || {}));
  /** @type {{start:number,end:number,km:number,newCells:number}[]} */
  const walks = Array.isArray(stored.walks) ? stored.walks : [];

  const settings = Object.assign(
    { res: 9, grid: true, accuracy: 40, view: null },
    loadJSON(SETTINGS_KEY, {})
  );

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1500);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveJSON(STORAGE_KEY, { version: 1, cells: Object.fromEntries(visited), walks });
  }
  function saveSettings() {
    saveJSON(SETTINGS_KEY, settings);
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- helpers ----------

  const $ = (id) => document.getElementById(id);

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function haversine(a, b) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** Cells from a to b inclusive, or just [b] when they're too far apart. */
  function pathBetween(a, b) {
    if (!a || a === b) return [b];
    try {
      if (h3.gridDistance(a, b) <= MAX_PATH_STEPS) return h3.gridPathCells(a, b);
    } catch (e) {
      // pentagons or very distant cells — fall through
    }
    return [b];
  }

  function toDisplay(cell) {
    return settings.res === BASE_RES ? cell : h3.cellToParent(cell, settings.res);
  }

  function formatNum(n) {
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  // ---------- marking ----------

  let walk = null; // { start, km, newCells:Set, lastCell, lastFix }

  /** Mark base-res cells as visited. Returns how many were new. */
  function markCells(cells) {
    const now = Date.now();
    let added = 0;
    for (const c of cells) {
      if (!visited.has(c)) {
        visited.set(c, now);
        added++;
        if (walk) walk.newCells.add(c);
      }
    }
    if (added) {
      scheduleSave();
      scheduleRender();
    }
    return added;
  }

  function unmarkCells(cells) {
    let removed = 0;
    for (const c of cells) {
      if (visited.delete(c)) removed++;
      if (walk) walk.newCells.delete(c);
    }
    if (removed) {
      scheduleSave();
      scheduleRender();
    }
    return removed;
  }

  function baseChildren(displayCell) {
    return settings.res === BASE_RES ? [displayCell] : h3.cellToChildren(displayCell, BASE_RES);
  }

  // ---------- map ----------

  const map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  if (settings.view) {
    map.setView([settings.view.lat, settings.view.lng], settings.view.zoom);
  } else {
    map.setView([51.505, -0.09], 3);
  }

  // Separate panes so redrawn hexes never cover the location dot.
  ['grid', 'visited', 'walk', 'here'].forEach((name, i) => {
    map.createPane(name).style.zIndex = String(410 + i * 10);
  });
  const gridLayer = L.layerGroup([], { pane: 'grid' }).addTo(map);
  const visitedLayer = L.layerGroup([], { pane: 'visited' }).addTo(map);
  const walkLayer = L.layerGroup([], { pane: 'walk' }).addTo(map);
  const hereLayer = L.layerGroup([], { pane: 'here' }).addTo(map);

  const accuracyCircle = L.circle([0, 0], {
    pane: 'here', radius: 1, color: COLORS.here, weight: 1, fillOpacity: 0.12, interactive: false,
  });
  const youMarker = L.circleMarker([0, 0], {
    pane: 'here', radius: 7, color: '#fff', weight: 3, fillColor: COLORS.here, fillOpacity: 1, interactive: false,
  });
  let hereHex = null;

  function viewPolygon(padRatio) {
    const b = map.getBounds().pad(padRatio);
    return [
      [b.getSouth(), b.getWest()],
      [b.getNorth(), b.getWest()],
      [b.getNorth(), b.getEast()],
      [b.getSouth(), b.getEast()],
    ];
  }

  function estimatedCellsInView(res, padRatio) {
    const b = map.getBounds().pad(padRatio);
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const h = haversine(sw, L.latLng(ne.lat, sw.lng)) / 1000;
    const midLat = (sw.lat + ne.lat) / 2;
    const w = haversine(L.latLng(midLat, sw.lng), L.latLng(midLat, ne.lng)) / 1000;
    return (h * w) / h3.getHexagonAreaAvg(res, h3.UNITS.km2);
  }

  let renderQueued = false;
  let lastRender = 0;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const wait = Math.max(0, 500 - (Date.now() - lastRender));
    setTimeout(() => {
      renderQueued = false;
      lastRender = Date.now();
      render();
    }, wait);
  }

  function render() {
    const res = settings.res;

    // Visited cells at the chosen size.
    const display = new Set();
    for (const c of visited.keys()) display.add(toDisplay(c));

    const walkDisplay = new Set();
    if (walk) for (const c of walk.newCells) walkDisplay.add(toDisplay(c));

    // Only draw what's near the viewport — keeps big histories fast.
    const bounds = map.getBounds().pad(0.5);
    const inView = (c) => {
      const [lat, lng] = h3.cellToLatLng(c);
      return bounds.contains([lat, lng]);
    };
    const drawVisited = [...display].filter(inView);
    const drawWalk = [...walkDisplay].filter(inView);

    visitedLayer.clearLayers();
    if (drawVisited.length) {
      L.polygon(h3.cellsToMultiPolygon(drawVisited, false), {
        pane: 'visited', color: COLORS.visited, weight: 1.5, opacity: 0.9,
        fillColor: COLORS.visited, fillOpacity: 0.42, interactive: false,
      }).addTo(visitedLayer);
    }

    walkLayer.clearLayers();
    if (drawWalk.length) {
      L.polygon(h3.cellsToMultiPolygon(drawWalk, false), {
        pane: 'walk', color: COLORS.walk, weight: 2.5, opacity: 1,
        fillColor: COLORS.walk, fillOpacity: 0.35, interactive: false,
      }).addTo(walkLayer);
    }

    // Grid of the viewport + "% of view explored".
    gridLayer.clearLayers();
    let viewPct = null;
    if (estimatedCellsInView(res, 0.1) <= MAX_VIEW_CELLS) {
      let cells = [];
      try {
        cells = h3.polygonToCells(viewPolygon(0.1), res, false);
      } catch (e) {
        cells = [];
      }
      if (cells.length) {
        const vb = map.getBounds();
        let total = 0;
        let seen = 0;
        for (const c of cells) {
          const [lat, lng] = h3.cellToLatLng(c);
          if (!vb.contains([lat, lng])) continue;
          total++;
          if (display.has(c)) seen++;
        }
        if (total) viewPct = (seen / total) * 100;

        if (settings.grid && map.getZoom() >= 12) {
          const rings = [];
          for (const c of cells) {
            if (display.has(c)) continue;
            const ring = h3.cellToBoundary(c);
            ring.push(ring[0]);
            rings.push(ring);
          }
          L.polyline(rings, {
            pane: 'grid', color: COLORS.grid, weight: 0.7, opacity: 0.28, interactive: false,
          }).addTo(gridLayer);
        }
      }
    }

    // Stats
    let km2 = 0;
    for (const c of visited.keys()) km2 += cellAreaCached(c);
    $('statCells').textContent = display.size.toLocaleString();
    $('statArea').textContent = formatNum(km2);
    $('statView').textContent = viewPct === null ? '–' : (viewPct < 10 && viewPct > 0 ? viewPct.toFixed(1) : Math.round(viewPct)) + '%';
    if (walk) {
      $('statWalkNew').textContent = walkDisplay.size.toLocaleString();
      $('statWalkDist').textContent = walk.km.toFixed(2);
    }

    updateHereHex();
  }

  const areaCache = new Map();
  function cellAreaCached(c) {
    let a = areaCache.get(c);
    if (a === undefined) {
      a = h3.cellArea(c, h3.UNITS.km2);
      areaCache.set(c, a);
    }
    return a;
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    settings.view = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    saveSettings();
    scheduleRender();
  });

  // ---------- location ----------

  let watchId = null;
  let lastPos = null;
  let follow = true;
  let pendingCenter = false;

  function ensureWatching() {
    if (watchId !== null) return true;
    if (!('geolocation' in navigator)) {
      toast('This browser has no location support');
      return false;
    }
    watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 30000,
    });
    return true;
  }

  function onGeoError(err) {
    if (err.code === err.PERMISSION_DENIED) {
      toast('Location permission denied — enable it in your browser settings', 4000);
      if (walk) stopWalk();
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    } else if (walk && (!lastPos || Date.now() - lastPos.time > 15000)) {
      toast('Still looking for GPS…');
    }
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const here = L.latLng(lat, lng);
    lastPos = { latlng: here, accuracy, time: pos.timestamp };

    accuracyCircle.setLatLng(here).setRadius(accuracy);
    youMarker.setLatLng(here);
    if (!hereLayer.hasLayer(youMarker)) {
      accuracyCircle.addTo(hereLayer);
      youMarker.addTo(hereLayer);
    }

    if (pendingCenter || (walk && follow)) {
      map.setView(here, pendingCenter ? Math.max(map.getZoom(), 16) : map.getZoom());
      pendingCenter = false;
    }
    updateHereHex();

    if (walk) recordFix(here, accuracy, pos.timestamp);
  }

  function recordFix(here, accuracy, time) {
    if (accuracy > settings.accuracy) {
      toast(`Waiting for better GPS (±${Math.round(accuracy)} m)`);
      return;
    }
    const cell = h3.latLngToCell(here.lat, here.lng, BASE_RES);
    const prev = walk.lastFix;

    if (prev) {
      const d = haversine(prev.latlng, here);
      const dt = Math.max(1, (time - prev.time) / 1000);
      if (d / dt > MAX_WALK_SPEED && d > 50) {
        // Probably on a bus/bike/train — don't paint the ride.
        toast('Moving fast — not marking until you slow down');
        walk.lastFix = { latlng: here, time };
        walk.lastCell = cell;
        return;
      }
      if (d < MIN_STEP_METERS) {
        if (cell !== walk.lastCell) {
          markCells([cell]);
          walk.lastCell = cell;
        }
        return;
      }
      walk.km += d / 1000;
    }

    markCells(pathBetween(walk.lastCell, cell));
    walk.lastCell = cell;
    walk.lastFix = { latlng: here, time };
    scheduleRender();
  }

  function updateHereHex() {
    if (!lastPos) return;
    const cell = h3.latLngToCell(lastPos.latlng.lat, lastPos.latlng.lng, settings.res);
    if (hereHex && hereHex._cell === cell) return;
    if (hereHex) hereLayer.removeLayer(hereHex);
    hereHex = L.polygon(h3.cellToBoundary(cell), {
      pane: 'here', color: COLORS.here, weight: 2.5, dashArray: '6 4', fill: false, interactive: false,
    }).addTo(hereLayer);
    hereHex._cell = cell;
  }

  map.on('dragstart', () => { follow = false; });

  // ---------- wake lock ----------

  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || !walk) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (walk) requestWakeLock();
    } else {
      saveNow();
    }
  });
  window.addEventListener('pagehide', saveNow);

  // ---------- walk ----------

  function startWalk() {
    if (!ensureWatching()) return;
    walk = { start: Date.now(), km: 0, newCells: new Set(), lastCell: null, lastFix: null };
    follow = true;
    pendingCenter = !lastPos;
    document.body.classList.add('walking');
    $('btnWalk').setAttribute('aria-pressed', 'true');
    $('walkLabel').textContent = 'Stop walk';
    requestWakeLock();
    if (lastPos) {
      map.setView(lastPos.latlng, Math.max(map.getZoom(), 16));
      recordFix(lastPos.latlng, lastPos.accuracy, Date.now());
    }
    toast('Walk started — keep this screen open');
    scheduleRender();
  }

  function stopWalk() {
    if (!walk) return;
    const summary = { start: walk.start, end: Date.now(), km: +walk.km.toFixed(3), newCells: walk.newCells.size };
    if (summary.km > 0 || summary.newCells > 0) walks.push(summary);
    const newDisplay = new Set([...walk.newCells].map(toDisplay)).size;
    walk = null;
    saveNow();
    document.body.classList.remove('walking');
    $('btnWalk').setAttribute('aria-pressed', 'false');
    $('walkLabel').textContent = 'Start walk';
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    toast(`Walk saved: ${summary.km.toFixed(2)} km, ${newDisplay} new hex${newDisplay === 1 ? '' : 'es'}`, 4000);
    scheduleRender();
  }

  $('btnWalk').addEventListener('click', () => (walk ? stopWalk() : startWalk()));

  $('btnLocate').addEventListener('click', () => {
    follow = true;
    if (lastPos) {
      map.setView(lastPos.latlng, Math.max(map.getZoom(), 16));
    } else if (ensureWatching()) {
      pendingCenter = true;
      toast('Finding you…');
    }
  });

  // ---------- paint mode ----------

  let painting = false;
  $('btnPaint').addEventListener('click', () => {
    painting = !painting;
    document.body.classList.toggle('painting', painting);
    $('btnPaint').setAttribute('aria-pressed', String(painting));
  });

  map.on('click', (e) => {
    if (!painting) return;
    const cell = h3.latLngToCell(e.latlng.lat, e.latlng.lng, settings.res);
    const children = baseChildren(cell);
    const isVisited = children.some((c) => visited.has(c));
    if (isVisited) unmarkCells(children);
    else markCells(children);
  });

  // ---------- menu / settings ----------

  function openSheet() {
    $('sheet').hidden = false;
    $('sheetBackdrop').hidden = false;
  }
  function closeSheet() {
    $('sheet').hidden = true;
    $('sheetBackdrop').hidden = true;
  }
  $('btnMenu').addEventListener('click', openSheet);
  $('btnClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);

  $('selRes').value = String(settings.res);
  $('chkGrid').checked = settings.grid;
  $('selAccuracy').value = String(settings.accuracy);

  $('selRes').addEventListener('change', (e) => {
    settings.res = Number(e.target.value);
    saveSettings();
    hereHex && hereLayer.removeLayer(hereHex);
    hereHex = null;
    render();
  });
  $('chkGrid').addEventListener('change', (e) => {
    settings.grid = e.target.checked;
    saveSettings();
    render();
  });
  $('selAccuracy').addEventListener('change', (e) => {
    settings.accuracy = Number(e.target.value);
    saveSettings();
  });

  // Backup
  $('btnExport').addEventListener('click', () => {
    saveNow();
    const data = {
      app: 'scoop', version: 1, exported: new Date().toISOString(), baseRes: BASE_RES,
      cells: Object.fromEntries(visited), walks,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scoop-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btnImport').addEventListener('click', () => $('fileJson').click());
  $('fileJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.cells !== 'object') throw new Error('not a Scoop backup');
      let added = 0;
      for (const [c, ts] of Object.entries(data.cells)) {
        if (!h3.isValidCell(c) || h3.getResolution(c) !== BASE_RES) continue;
        const prev = visited.get(c);
        if (prev === undefined) added++;
        visited.set(c, prev === undefined ? ts : Math.min(prev, ts));
      }
      const knownStarts = new Set(walks.map((w) => w.start));
      for (const w of data.walks || []) if (!knownStarts.has(w.start)) walks.push(w);
      walks.sort((a, b) => a.start - b.start);
      saveNow();
      render();
      toast(`Restored — ${added.toLocaleString()} new cells merged`);
      closeSheet();
    } catch (err) {
      toast('Could not read that file: ' + err.message, 4000);
    }
  });

  // GPX import (tracks from Strava, Komoot, Google Takeout exports, etc.)
  $('btnImportGpx').addEventListener('click', () => $('fileGpx').click());
  $('fileGpx').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let added = 0;
    let points = 0;
    const bounds = L.latLngBounds([]);
    for (const file of files) {
      try {
        const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('invalid XML');
        const segments = [...doc.querySelectorAll('trkseg, rte')];
        if (!segments.length) segments.push(doc.documentElement);
        for (const seg of segments) {
          let last = null;
          const cells = [];
          for (const pt of seg.querySelectorAll('trkpt, rtept, wpt')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lng = parseFloat(pt.getAttribute('lon'));
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            points++;
            bounds.extend([lat, lng]);
            const cell = h3.latLngToCell(lat, lng, BASE_RES);
            cells.push(...pathBetween(last, cell));
            last = cell;
          }
          added += markCells(cells);
        }
      } catch (err) {
        toast(`Skipped ${file.name}: ${err.message}`, 4000);
      }
    }
    if (points) {
      saveNow();
      closeSheet();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
      toast(`Imported ${points.toLocaleString()} points — ${added.toLocaleString()} new cells`, 4000);
    }
  });

  $('btnClear').addEventListener('click', () => {
    if (!confirm('Erase every visited hex and walk on this device? This cannot be undone.')) return;
    visited.clear();
    walks.length = 0;
    if (walk) walk.newCells.clear();
    saveNow();
    render();
    closeSheet();
    toast('All cleared');
  });

  // ---------- boot ----------

  render();

  // If permission was already granted, show where you are right away.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      if (p.state === 'granted') {
        pendingCenter = !settings.view;
        ensureWatching();
      }
    }).catch(() => {});
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Handy for debugging from the console.
  window.scoop = { visited, walks, settings, render };
})();
