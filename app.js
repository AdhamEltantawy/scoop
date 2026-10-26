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
  const MAX_PATH_STEPS = 20;        // GPX import: fill gaps between points up to ~20 cells
  const MAX_LIVE_PATH_STEPS = 8;    // live walks: fill short GPS dropouts only
  const MIN_STEP_METERS = 5;        // ignore GPS jitter for distance

  // Walking-only detection. Speed comes from the GPS chip (Doppler) when it
  // reports one, otherwise from distance covered over the last ~20 s.
  const SPEED_LIMITS = { walk: 2.5, run: 4.5 }; // m/s: 9 km/h, 16 km/h
  const FAST_FIXES_TO_PAUSE = 3;    // consecutive too-fast fixes before pausing
  const SLOW_MS_TO_RESUME = 60000;  // must be at walking speed this long to resume
  const PENDING_MS = 30000;         // hold new cells this long before committing,
                                    // so a vehicle pulling away doesn't count
  const SPEED_WINDOW_MS = 20000;

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
  /** @type {Map<string, number>} cell -> number of walks through it (older data has none: counts as 1) */
  const visits = new Map(Object.entries(stored.visits || {}));
  const visitCount = (c) => visits.get(c) || (visited.has(c) ? 1 : 0);

  const settings = Object.assign(
    { res: 9, grid: true, accuracy: 40, basemap: 'osm', activity: 'walk', view: null },
    loadJSON(SETTINGS_KEY, {})
  );

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1500);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveJSON(STORAGE_KEY, { version: 1, cells: Object.fromEntries(visited), visits: Object.fromEntries(visits), walks });
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
  function pathBetween(a, b, maxSteps = MAX_PATH_STEPS) {
    if (!a || a === b) return [b];
    try {
      if (h3.gridDistance(a, b) <= maxSteps) return h3.gridPathCells(a, b);
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

  // { start, km, newCells:Set, cells:Set, lastCell, lastFix, history, pending,
  //   moving, fastCount, fastSince, slowSince, slowFixes }
  let walk = null;

  /** Mark base-res cells as visited. Returns how many were new. */
  function markCells(cells) {
    const now = Date.now();
    let added = 0;
    for (const c of cells) {
      if (walk) walk.cells.add(c);
      if (!visited.has(c)) {
        visited.set(c, now);
        added++;
        if (walk) walk.newCells.add(c);
      }
    }
    if (added) {
      // Timers are throttled in the background, so save right away there.
      if (document.hidden) saveNow();
      else scheduleSave();
      scheduleRender();
    }
    return added;
  }

  // ---------- map ----------

  const map = L.map('map', {
    zoomControl: false,
    preferCanvas: true,
    attributionControl: true,
  });

  // Basemaps that need no API key. Pick another in the menu if one stops working.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const BASEMAPS = {
    osm: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: OSM_ATTR },
    },
    hot: {
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      options: { maxZoom: 19, subdomains: 'abc', attribution: OSM_ATTR + ', Humanitarian style by HOT' },
    },
    streets: {
      url: ESRI + '/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
    },
    satellite: {
      url: ESRI + '/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
    },
  };

  let baseLayer = null;
  function setBasemap(key) {
    const def = BASEMAPS[key] || BASEMAPS.osm;
    if (baseLayer) map.removeLayer(baseLayer);
    let loaded = 0;
    let failed = 0;
    baseLayer = L.tileLayer(def.url, Object.assign({ referrerPolicy: 'strict-origin-when-cross-origin' }, def.options))
      .on('tileload', () => { loaded++; })
      .on('tileerror', () => {
        if (++failed === 6 && loaded === 0) toast('Map not loading — try another map style in the menu', 5000);
      })
      .addTo(map);
  }
  setBasemap(settings.basemap);

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
    if (walk) {
      for (const c of walk.newCells) walkDisplay.add(toDisplay(c));
      for (const p of walk.pending) for (const c of p.cells) if (!visited.has(c)) walkDisplay.add(toDisplay(c));
    }

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
      $('statWalkDist').textContent = (walk.km + walk.pending.reduce((a, p) => a + p.km, 0)).toFixed(2);
    }

    updateHereHex();
    emit('render', { display });
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

  // ---------- native (Android app) ----------

  // In the Android app (Capacitor), walks use a background-capable GPS watcher,
  // so tracking keeps going with the screen off. In a browser these are null.
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform());
  const plugin = (name) => (isNative ? window.capacitorExports.registerPlugin(name) : null);
  const BackgroundGeolocation = plugin('BackgroundGeolocation');
  const App = plugin('App');
  const Filesystem = plugin('Filesystem');
  const Share = plugin('Share');

  // ---------- location ----------

  let watchId = null;
  let nativeWatcherId = null;
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

  function stopWebWatch() {
    if (watchId === null) return;
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function startNativeWatcher() {
    BackgroundGeolocation.addWatcher({
      backgroundTitle: 'Scoop is recording your walk',
      backgroundMessage: 'Tap to return to the map',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    }, (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') {
          stopWalk();
          if (confirm('Scoop needs location permission to record walks. Open settings?')) {
            BackgroundGeolocation.openSettings();
          }
        }
        return;
      }
      if (!loc) return;
      onFix({
        coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed },
        timestamp: loc.time || Date.now(),
      });
    }).then((id) => {
      // The walk may have been stopped while permissions were being requested.
      if (walk) nativeWatcherId = id;
      else BackgroundGeolocation.removeWatcher({ id });
    });
  }

  function stopNativeWatcher() {
    if (nativeWatcherId === null) return;
    BackgroundGeolocation.removeWatcher({ id: nativeWatcherId });
    nativeWatcherId = null;
  }

  function onGeoError(err) {
    if (err.code === err.PERMISSION_DENIED) {
      toast('Location permission denied — enable it in your browser settings', 4000);
      if (walk && !isNative) stopWalk();
      stopWebWatch();
    } else if (walk && (!lastPos || Date.now() - lastPos.time > 15000)) {
      toast('Still looking for GPS…');
    }
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;
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

    if (walk) recordFix(here, accuracy, pos.timestamp, speed);
  }

  /** Best guess at current speed in m/s, or null if not enough data yet. */
  function currentSpeed(time, reported) {
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return reported;
    const h = walk.history;
    const old = h.find((f) => time - f.time <= SPEED_WINDOW_MS);
    if (!old || time - old.time < 8000) return null;
    return haversine(old.latlng, h[h.length - 1].latlng) / ((time - old.time) / 1000);
  }

  function setMoving(moving) {
    walk.moving = moving;
    document.body.classList.toggle('too-fast', moving);
  }

  /** Commit pending cells recorded before `cutoff` (all of them by default). */
  function commitPending(cutoff = Infinity) {
    while (walk.pending.length && walk.pending[0].time <= cutoff) {
      const p = walk.pending.shift();
      walk.km += p.km;
      markCells(p.cells);
    }
  }

  function recordFix(here, accuracy, time, reportedSpeed) {
    if (accuracy > settings.accuracy) {
      toast(`Waiting for better GPS (±${Math.round(accuracy)} m)`);
      return;
    }
    walk.history.push({ latlng: here, time });
    while (walk.history.length && time - walk.history[0].time > SPEED_WINDOW_MS * 2) walk.history.shift();

    const speed = currentSpeed(time, reportedSpeed);
    const tooFast = speed !== null && speed > SPEED_LIMITS[settings.activity];
    const cell = h3.latLngToCell(here.lat, here.lng, BASE_RES);

    if (walk.moving) {
      // In a vehicle: wait for a sustained stretch at walking speed, so red
      // lights and traffic jams don't count. Once confirmed, that stretch is
      // credited as walking.
      if (tooFast) {
        walk.slowSince = null;
        walk.slowFixes = [];
      } else {
        if (walk.slowSince === null) walk.slowSince = time;
        walk.slowFixes.push({ latlng: here, cell, time });
      }
      if (walk.slowSince !== null && time - walk.slowSince >= SLOW_MS_TO_RESUME) {
        setMoving(false);
        walk.fastCount = 0;
        walk.lastCell = null;
        walk.lastFix = null;
        for (const f of walk.slowFixes) addStep(f.latlng, f.cell, f.time);
        walk.slowFixes = [];
        commitPending(time - PENDING_MS);
        scheduleRender();
      }
      return;
    }

    if (tooFast) {
      if (walk.fastCount === 0) walk.fastSince = time;
      walk.fastCount++;
    } else {
      walk.fastCount = 0;
    }
    if (walk.fastCount >= FAST_FIXES_TO_PAUSE) {
      // Probably a car/bus/bike/train. Keep the walk up to shortly before the
      // speed rose, and drop the rest: that was the vehicle pulling away.
      commitPending(walk.fastSince - 10000);
      walk.pending = [];
      walk.lastCell = null;
      walk.lastFix = null;
      walk.slowSince = null;
      walk.slowFixes = [];
      setMoving(true);
      scheduleRender();
      return;
    }

    addStep(here, cell, time);
    commitPending(time - PENDING_MS);
    scheduleRender();
  }

  /** Queue the cells walked to reach `here`, plus the distance covered. */
  function addStep(here, cell, time) {
    const prev = walk.lastFix;
    if (prev && haversine(prev.latlng, here) < MIN_STEP_METERS) {
      if (cell !== walk.lastCell) {
        walk.pending.push({ time, cells: [cell], km: 0 });
        walk.lastCell = cell;
      }
      return;
    }
    const km = prev ? haversine(prev.latlng, here) / 1000 : 0;
    walk.pending.push({ time, cells: pathBetween(walk.lastCell, cell, MAX_LIVE_PATH_STEPS), km });
    walk.lastCell = cell;
    walk.lastFix = { latlng: here, time };
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
    // The Android app tracks with the screen off, so it doesn't need this.
    if (isNative || !('wakeLock' in navigator) || !walk) return;
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

  function newWalk(start) {
    return {
      start, km: 0, newCells: new Set(), cells: new Set(), lastCell: null, lastFix: null,
      history: [], pending: [], moving: false, fastCount: 0, fastSince: 0, slowSince: null, slowFixes: [],
    };
  }

  /** Count one more visit for every cell the finished walk went through. */
  function countVisits() {
    for (const c of walk.cells) visits.set(c, walk.newCells.has(c) ? 1 : visitCount(c) + 1);
  }

  /** Tell other parts of the app (community sync) that walks were added or data changed. */
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent('scoop:' + name, { detail }));
  }

  function startWalk() {
    if (!isNative && !ensureWatching()) return;
    walk = newWalk(Date.now());
    follow = true;
    pendingCenter = !lastPos;
    document.body.classList.add('walking');
    $('btnWalk').setAttribute('aria-pressed', 'true');
    $('walkLabel').textContent = 'Stop walk';
    requestWakeLock();
    if (isNative) {
      stopWebWatch();
      startNativeWatcher();
    }
    if (lastPos) {
      map.setView(lastPos.latlng, Math.max(map.getZoom(), 16));
      recordFix(lastPos.latlng, lastPos.accuracy, Date.now(), null);
    }
    toast(isNative ? 'Walk started — you can lock your phone' : 'Walk started — keep this screen open');
    scheduleRender();
  }

  function stopWalk() {
    if (!walk) return;
    if (!walk.moving) commitPending();
    document.body.classList.remove('too-fast');
    const summary = { start: walk.start, end: Date.now(), km: +walk.km.toFixed(3), newCells: walk.newCells.size };
    if (summary.km > 0 || summary.newCells > 0) walks.push(summary);
    const newDisplay = new Set([...walk.newCells].map(toDisplay)).size;
    countVisits();
    walk = null;
    saveNow();
    emit('changed', { walk: summary });
    document.body.classList.remove('walking');
    $('btnWalk').setAttribute('aria-pressed', 'false');
    $('walkLabel').textContent = 'Start walk';
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (isNative) {
      stopNativeWatcher();
      ensureWatching();
    }
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

  // ---------- menu / settings ----------

  function openSheet(id = 'sheet') {
    closeSheet();
    $(id).hidden = false;
    $('sheetBackdrop').hidden = false;
  }
  function closeSheet() {
    for (const el of document.querySelectorAll('.sheet')) el.hidden = true;
    $('sheetBackdrop').hidden = true;
  }
  const anySheetOpen = () => !!document.querySelector('.sheet:not([hidden])');
  $('btnMenu').addEventListener('click', () => openSheet());
  $('btnClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);

  $('selRes').value = String(settings.res);
  $('chkGrid').checked = settings.grid;
  $('selAccuracy').value = String(settings.accuracy);
  $('selBasemap').value = BASEMAPS[settings.basemap] ? settings.basemap : 'osm';

  $('selActivity').value = SPEED_LIMITS[settings.activity] ? settings.activity : 'walk';
  $('selActivity').addEventListener('change', (e) => {
    settings.activity = e.target.value;
    saveSettings();
  });

  $('selBasemap').addEventListener('change', (e) => {
    settings.basemap = e.target.value;
    saveSettings();
    setBasemap(settings.basemap);
  });

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
  $('btnExport').addEventListener('click', async () => {
    saveNow();
    const data = {
      app: 'scoop', version: 1, exported: new Date().toISOString(), baseRes: BASE_RES,
      cells: Object.fromEntries(visited), visits: Object.fromEntries(visits), walks,
    };
    const name = `scoop-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (isNative) {
      // The Android WebView can't download files, so hand it to the share sheet
      // (save to Drive, Files, email, …).
      try {
        const { uri } = await Filesystem.writeFile({
          path: name, data: JSON.stringify(data), directory: 'CACHE', encoding: 'utf8',
        });
        await Share.share({ title: 'Scoop backup', files: [uri] });
      } catch (err) {
        if (!/cancel/i.test(err.message || '')) toast('Could not export: ' + err.message, 4000);
      }
      return;
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
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
      for (const [c, n] of Object.entries(data.visits || {})) {
        if (visited.has(c) && Number.isInteger(n) && n > visitCount(c)) visits.set(c, n);
      }
      const knownStarts = new Set(walks.map((w) => w.start));
      for (const w of data.walks || []) if (!knownStarts.has(w.start)) walks.push(w);
      walks.sort((a, b) => a.start - b.start);
      saveNow();
      render();
      emit('changed', {});
      toast(`Restored — ${added.toLocaleString()} new cells merged`);
      closeSheet();
    } catch (err) {
      toast('Could not read that file: ' + err.message, 4000);
    }
  });

  /** Replay a recorded track through the same walking-only filter as a live walk. */
  function replayTrack(points) {
    walk = newWalk(points[0].time);
    for (const p of points) recordFix(L.latLng(p.lat, p.lng), 0, p.time, null);
    if (!walk.moving) commitPending();
    const result = { start: walk.start, end: points[points.length - 1].time, km: walk.km, newCells: walk.newCells.size };
    // Re-importing the same file shouldn't count as walking there again.
    if (!walks.some((w) => w.start === result.start)) countVisits();
    walk = null;
    document.body.classList.remove('too-fast');
    return result;
  }

  // GPX import (tracks from Strava, Komoot, Garmin, etc.). Points need
  // timestamps so the walking-speed check can tell walks from drives.
  $('btnImportGpx').addEventListener('click', () => {
    if (walk) toast('Stop your walk before importing');
    else $('fileGpx').click();
  });
  $('fileGpx').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let added = 0;
    let km = 0;
    const bounds = L.latLngBounds([]);
    for (const file of files) {
      try {
        const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('invalid XML');
        const segments = [...doc.querySelectorAll('trkseg')];
        if (!segments.length) throw new Error('no recorded track in this file');
        for (const seg of segments) {
          const points = [];
          for (const pt of seg.querySelectorAll('trkpt')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lng = parseFloat(pt.getAttribute('lon'));
            const time = Date.parse(pt.querySelector('time')?.textContent || '');
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            if (!Number.isFinite(time)) throw new Error("no timestamps, so walking can't be verified");
            points.push({ lat, lng, time });
            bounds.extend([lat, lng]);
          }
          if (!points.length) continue;
          const result = replayTrack(points);
          added += result.newCells;
          km += result.km;
          if (result.km > 0 && !walks.some((w) => w.start === result.start)) walks.push(result);
        }
      } catch (err) {
        toast(`Skipped ${file.name}: ${err.message}`, 4000);
      }
    }
    if (bounds.isValid()) {
      walks.sort((a, b) => a.start - b.start);
      saveNow();
      render();
      closeSheet();
      map.fitBounds(bounds, { padding: [40, 40] });
      emit('changed', {});
      toast(`Imported ${km.toFixed(2)} km of walking — ${added.toLocaleString()} new cells`, 4000);
    }
  });

  $('btnClear').addEventListener('click', () => {
    if (!confirm('Erase every visited hex and walk on this device? This cannot be undone.')) return;
    visited.clear();
    visits.clear();
    walks.length = 0;
    if (walk) { walk.newCells.clear(); walk.pending = []; }
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

  if (isNative) {
    $('walkTip').textContent = 'Walks keep recording with the screen off — look for the notification.';
  }

  // Android back button: close whatever is open, otherwise send the app to the
  // background (instead of quitting) so a walk in progress keeps recording.
  if (App) {
    App.addListener('backButton', () => {
      if (anySheetOpen()) closeSheet();
      else App.minimizeApp();
    });
  }

  if (!isNative && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Used by social.js (community features) and handy for debugging from the console.
  window.scoop = {
    BASE_RES, COLORS, map, visited, visits, visitCount, walks, settings, isNative, Filesystem, Share, App,
    render, scheduleRender, toDisplay, toast, formatNum, cellAreaCached, haversine, openSheet, closeSheet,
    position: () => lastPos,
    walking: () => !!walk,
  };
  emit('ready', window.scoop);
})();
