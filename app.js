/* Scoop — explore your city on foot, one hexagon at a time.
 *
 * The map uses one hex size: H3 resolution 10 (street hexes, ~0.015 km²).
 * Explored hexes stay explored, but they cool down: a hex's heat halves every
 * 30 days since you last walked through it (see heat() in social-core.js).
 */
(() => {
  'use strict';

  const core = window.ScoopCore;
  const BASE_RES = 10;
  const STORAGE_KEY = 'scoop.v1';
  const SETTINGS_KEY = 'scoop.settings.v1';
  const MAX_VIEW_CELLS = 6000;      // skip grid / "% of view" beyond this
  const MAX_PATH_STEPS = 20;        // GPX import: fill gaps between points up to ~20 cells
  const MAX_LIVE_PATH_STEPS = 8;    // live walks: fill short GPS dropouts only
  const MIN_STEP_METERS = 5;        // ignore GPS jitter for distance
  const START_METERS = 100;         // a walk records hexes once you're this far from where it started

  // Walking-only detection. Speed comes from the GPS chip (Doppler) when it
  // reports one, otherwise from distance covered over the last ~20 s.
  const SPEED_LIMITS = { walk: 2.5, run: 4.5 }; // m/s: 9 km/h, 16 km/h
  const FAST_FIXES_TO_PAUSE = 3;    // consecutive too-fast fixes before pausing
  const SLOW_MS_TO_RESUME = 60000;  // must be at walking speed this long to resume
  const PENDING_MS = 30000;         // hold new cells this long before committing,
                                    // so a vehicle pulling away doesn't count
  const SPEED_WINDOW_MS = 20000;

  // Colours come from tokens.css so the map and the chrome share one palette.
  const rootStyle = getComputedStyle(document.documentElement);
  const tok = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
  const COLORS = {
    walk: tok('--walk', '#19C29A'),
    walkStroke: tok('--walk-stroke', '#053F33'),
    grid: tok('--grid', '#1A1A1A'),
    here: tok('--location', '#1E1A16'),
    hereWaiting: '#8A8178',
    friend: tok('--friend-overlay', '#3355E0'),
    privacy: tok('--privacy', '#5C6470'),
    privacyStroke: tok('--privacy-stroke', '#3A4048'),
    community: tok('--community', '#8A4FC7'),
  };

  // Explored hexes are drawn in heat bands, from just walked to long ago. Each
  // band has a darker stroke so even the coldest still reads as explored.
  // Heat halves every 30 days: 0.5 after a month, 0.25 after two, 0.1 after ~3.3.
  const HEAT_BANDS = [0.75, 0.5, 0.25, 0.1, 0].map((min, i) => ({
    min,
    color: tok(`--heat-${i}`, ['#E0301E', '#EE6B2F', '#F49E5E', '#EBC8A2', '#C9BCAE'][i]),
    stroke: tok(`--heat-${i}-stroke`, ['#9A1D0E', '#B0441A', '#B26D33', '#A68A6B', '#857868'][i]),
    fill: Number(tok(`--heat-${i}-opacity`, '')) || [0.72, 0.62, 0.55, 0.5, 0.48][i],
    name: ['Now', '1 mo', '2 mo', '3 mo', '100d+'][i],
  }));
  const heatBand = (h) => HEAT_BANDS.findIndex((b) => h >= b.min);

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
  /**
   * points: what the walk earned (heat restored plus bonuses). Walks from
   * before scores faded have none.
   * @type {{start:number,end:number,km:number,newCells:number,points?:number}[]}
   */
  const walks = Array.isArray(stored.walks) ? stored.walks : [];
  /** @type {Map<string, number>} cell -> number of walks through it (older data has none: counts as 1) */
  const visits = new Map(Object.entries(stored.visits || {}));
  const visitCount = (c) => visits.get(c) || (visited.has(c) ? 1 : 0);
  /** @type {Map<string, number>} cell -> last walked through (ms epoch). Older data starts at the first visit. */
  const lastSeen = new Map(Object.entries(stored.last || {}));
  for (const [c, t] of visited) if (!lastSeen.has(c)) lastSeen.set(c, t);

  const settings = Object.assign(
    { grid: true, accuracy: 40, basemap: 'osm', activity: 'walk', view: null },
    loadJSON(SETTINGS_KEY, {})
  );
  delete settings.res; // hex sizes were removed: everything is street-sized now

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1500);
  }
  function snapshot() {
    return {
      cells: Object.fromEntries(visited), visits: Object.fromEntries(visits), last: Object.fromEntries(lastSeen), walks,
    };
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveJSON(STORAGE_KEY, { version: 1, ...snapshot() });
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

  /** Heat of an explored hex; hexes on the walk in progress are at full heat. */
  function cellHeat(c, now = Date.now()) {
    if (walk && walk.cells.has(c)) return 1;
    return core.heat(lastSeen.get(c), now);
  }

  /** Current score of the hexes on this device (check-in points live on the server). */
  function hexScoreTotal(now = Date.now()) {
    let total = 0;
    for (const c of visited.keys()) total += core.hexValue(visitCount(c)) * cellHeat(c, now);
    return total;
  }

  function formatNum(n) {
    if (n >= 100) return Math.round(n).toLocaleString();
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  // ---------- marking ----------

  // { start, km, newCells:Set, cells:Map<cell, time>, lastCell, lastFix, history, pending,
  //   moving, fastCount, fastSince, slowSince, slowFixes, origin, armed, replay }
  let walk = null;

  /** Mark base-res cells as walked through at `time`. Returns how many were new. */
  function markCells(cells, time = Date.now()) {
    let added = 0;
    for (const c of cells) {
      if (walk) walk.cells.set(c, Math.max(walk.cells.get(c) || 0, time));
      if (!visited.has(c)) {
        visited.set(c, time);
        lastSeen.set(c, time);
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
  map.attributionControl.setPosition('bottomleft');

  // Basemaps that need no API key. Pick another in Settings if one stops working.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const BASEMAPS = {
    osm: {
      label: 'OSM',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: OSM_ATTR },
    },
    streets: {
      label: 'Esri',
      url: ESRI + '/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
    },
    hot: {
      label: 'Humanitarian',
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      options: { maxZoom: 19, subdomains: 'abc', attribution: OSM_ATTR + ', Humanitarian style by HOT' },
    },
    satellite: {
      label: 'Satellite',
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
        if (++failed === 6 && loaded === 0) toast('Map not loading — try another map style in Settings', 5000);
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
    pane: 'here', radius: 1, color: COLORS.here, weight: 1, opacity: 0.35,
    fillColor: COLORS.here, fillOpacity: 0.1, interactive: false,
  });
  const youMarker = L.circleMarker([0, 0], {
    pane: 'here', radius: 8, color: '#fff', weight: 3, fillColor: COLORS.here, fillOpacity: 1, interactive: false,
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

  /**
   * Cells as one multi-polygon layer with one ring per hex, so every hex gets
   * its own stroke (merged outlines would hide the hex grid) while Leaflet
   * still draws a single layer.
   */
  function hexLayer(cells, options) {
    // Zoomed far out, hexes are a few pixels wide: merge them instead.
    if (map.getZoom() < 14 || cells.length > 8000) return L.polygon(h3.cellsToMultiPolygon(cells, false), options);
    return L.polygon(cells.map((c) => [h3.cellToBoundary(c)]), options);
  }

  /** Hexes drawn as "this walk" (committed plus still pending). */
  function walkDisplayCells() {
    const out = new Set();
    if (!walk) return out;
    for (const c of walk.newCells) out.add(c);
    for (const c of walk.cells.keys()) out.add(c);
    for (const p of walk.pending) for (const c of p.cells) out.add(c);
    return out;
  }

  function render() {
    const res = BASE_RES;
    const now = Date.now();
    const display = visited;
    const walkDisplay = walkDisplayCells();

    // Only draw what's near the viewport — keeps big histories fast.
    const bounds = map.getBounds().pad(0.5);
    const inView = (c) => {
      const [lat, lng] = h3.cellToLatLng(c);
      return bounds.contains([lat, lng]);
    };
    const bands = HEAT_BANDS.map(() => []);
    for (const c of visited.keys()) if (!walkDisplay.has(c) && inView(c)) bands[heatBand(cellHeat(c, now))].push(c);
    const drawWalk = [...walkDisplay].filter(inView);

    visitedLayer.clearLayers();
    // Coldest first, so warmer bands' strokes sit on top.
    for (let i = HEAT_BANDS.length - 1; i >= 0; i--) {
      if (!bands[i].length) continue;
      const b = HEAT_BANDS[i];
      hexLayer(bands[i], {
        pane: 'visited', color: b.stroke, weight: 1.3, opacity: 1,
        fillColor: b.color, fillOpacity: b.fill, interactive: false,
      }).addTo(visitedLayer);
    }

    walkLayer.clearLayers();
    if (drawWalk.length) {
      hexLayer(drawWalk, {
        pane: 'walk', color: COLORS.walkStroke, weight: 2.4, opacity: 1,
        fillColor: COLORS.walk, fillOpacity: 0.8, interactive: false,
      }).addTo(walkLayer);
    }

    // Unexplored grid of the viewport: thin and dark on street maps, white on satellite.
    gridLayer.clearLayers();
    if (settings.grid && map.getZoom() >= 12 && estimatedCellsInView(res, 0.1) <= MAX_VIEW_CELLS) {
      let cells = [];
      try {
        cells = h3.polygonToCells(viewPolygon(0.1), res, false);
      } catch (e) {
        cells = [];
      }
      const rings = [];
      for (const c of cells) {
        if (display.has(c) || walkDisplay.has(c)) continue;
        const ring = h3.cellToBoundary(c);
        ring.push(ring[0]);
        rings.push(ring);
      }
      if (rings.length) {
        const sat = settings.basemap === 'satellite';
        L.polyline(rings, {
          pane: 'grid', color: sat ? '#FFFFFF' : COLORS.grid, weight: 0.8, opacity: sat ? 0.35 : 0.28, interactive: false,
        }).addTo(gridLayer);
      }
    }

    // Stats card
    let km2 = 0;
    const bandCount = HEAT_BANDS.map(() => 0);
    for (const c of visited.keys()) {
      km2 += cellAreaCached(c);
      bandCount[heatBand(cellHeat(c, now))]++;
    }
    $('statCells').textContent = display.size.toLocaleString();
    $('statScore').textContent = Math.round(hexScoreTotal(now)).toLocaleString();
    $('statArea').textContent = km2 >= 10 ? Math.round(km2).toLocaleString() : km2.toFixed(1);
    const total = display.size || 1;
    $('warmthBar').replaceChildren(...bandCount.map((n, i) => {
      if (!n) return null;
      const seg = document.createElement('span');
      seg.style.background = HEAT_BANDS[i].color;
      seg.style.flex = String(n);
      return seg;
    }).filter(Boolean));
    const warm = bandCount[0] + bandCount[1] + bandCount[2];
    $('warmthPct').textContent = `${Math.round((warm / total) * 100)}% warm`;
    if (walk) {
      const pendingKm = walk.pending.reduce((a, p) => a + p.km, 0);
      $('statWalkNew').textContent = '+' + walkNewCount().toLocaleString();
      $('statWalkDist').textContent = (walk.km + pendingKm).toFixed(2);
    }

    updateHereHex();
    updateCard();
    emit('render', { display });
  }

  /** New hexes on the walk so far (committed and pending). */
  function walkNewCount() {
    if (!walk) return 0;
    const n = new Set(walk.newCells);
    for (const p of walk.pending) for (const c of p.cells) if (!visited.has(c)) n.add(c);
    return n.size;
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
          showOnboarding('denied');
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
      if (walk && !isNative) stopWalk(true);
      stopWebWatch();
      showOnboarding('denied');
    } else if (walk && (!lastPos || Date.now() - lastPos.time > 15000)) {
      toast('Still looking for GPS…');
    }
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;
    const here = L.latLng(lat, lng);
    lastPos = { latlng: here, accuracy, time: pos.timestamp };
    document.body.classList.add('has-fix');

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
    updateCard();
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
    if (!walk.replay && !moving) toast('Walking pace again · recording');
  }

  /** Commit pending cells recorded before `cutoff` (all of them by default). */
  function commitPending(cutoff = Infinity) {
    while (walk.pending.length && walk.pending[0].time <= cutoff) {
      const p = walk.pending.shift();
      walk.km += p.km;
      markCells(p.cells, p.time);
    }
  }

  let weakGpsToastAt = 0;
  function recordFix(here, accuracy, time, reportedSpeed) {
    walk.lastAcc = accuracy;
    if (accuracy > settings.accuracy) {
      if (!walk.armed) walk.gpsOk = false;
      else if (!walk.replay && Date.now() - weakGpsToastAt > 20000) {
        weakGpsToastAt = Date.now();
        toast(`Weak GPS (±${Math.round(accuracy)} m) · waiting`);
      }
      return;
    }
    if (!walk.gpsOk) {
      walk.gpsOk = true;
      if (!walk.replay && !walk.armed) toast(`Hexes count once you're ${START_METERS} m away`);
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
      if (!walk.armed) walk.origin = null; // measure the first 100 m again once walking
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

  /** True when `here` is in the inner 90% of the hex (outside its edge band). */
  function inCoreOf(here, cell) {
    return core.inCore(here.lat, here.lng, h3.cellToLatLng(cell), h3.cellToBoundary(cell));
  }

  /** Queue the cells walked to reach `here`, plus the distance covered. */
  function addStep(here, cell, time) {
    // Don't record the hex where the walk was switched on: wait until you've
    // walked 100 m from there. That stretch still counts towards distance.
    if (!walk.armed) {
      if (!walk.origin) walk.origin = here;
      walk.lastPoint = here;
      if (haversine(walk.origin, here) < START_METERS) return;
      walk.armed = true;
      walk.lastFix = { latlng: walk.origin, time };
      if (!walk.replay) toast('Recording hexes');
    }
    // Edge band: GPS wobble near a hex's edge doesn't unlock it. Stay in the
    // hex you were in until the fix is well inside the new one.
    if (cell !== walk.lastCell && !inCoreOf(here, cell)) cell = walk.lastCell;

    const prev = walk.lastFix;
    if (prev && haversine(prev.latlng, here) < MIN_STEP_METERS) {
      if (cell && cell !== walk.lastCell) {
        walk.pending.push({ time, cells: [cell], km: 0 });
        walk.lastCell = cell;
      }
      return;
    }
    const km = prev ? haversine(prev.latlng, here) / 1000 : 0;
    walk.pending.push({ time, cells: cell ? pathBetween(walk.lastCell, cell, MAX_LIVE_PATH_STEPS) : [], km });
    if (cell) walk.lastCell = cell;
    walk.lastFix = { latlng: here, time };
  }

  /** While walking, the hex you're standing in gets a dashed outline. */
  function updateHereHex() {
    const waiting = walkPhase() === 'gps';
    youMarker.setStyle({ fillColor: waiting ? COLORS.hereWaiting : COLORS.here });
    if (!lastPos || !walk) {
      if (hereHex) { hereLayer.removeLayer(hereHex); hereHex = null; }
      return;
    }
    const cell = h3.latLngToCell(lastPos.latlng.lat, lastPos.latlng.lng, BASE_RES);
    if (hereHex && hereHex._cell === cell) return;
    if (hereHex) hereLayer.removeLayer(hereHex);
    hereHex = L.polygon(h3.cellToBoundary(cell), {
      pane: 'here', color: COLORS.here, weight: 1.6, dashArray: '4 3', fill: false, interactive: false,
    }).addTo(hereLayer);
    hereHex._cell = cell;
  }

  map.on('dragstart', () => { follow = false; });

  // ---------- walk phases and the stats card ----------

  /** idle | empty | gps | warm | rec | paused */
  function walkPhase() {
    if (!walk) return visited.size ? 'idle' : 'empty';
    if (walk.moving) return 'paused';
    if (walk.armed) return 'rec';
    return walk.gpsOk ? 'warm' : 'gps';
  }

  const clock = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };

  function updateCard() {
    const phase = walkPhase();
    document.body.dataset.phase = phase;
    if (!walk) return;
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-timer]')) el.textContent = clock(now - walk.start);
    if (phase === 'gps') {
      $('gpsAcc').textContent = walk.lastAcc ? `±${Math.round(walk.lastAcc)} m` : '±– m';
      $('gpsNeed').textContent = `needs ±${settings.accuracy} m`;
    } else if (phase === 'warm') {
      const from = walk.origin && (walk.lastPoint || (lastPos && lastPos.latlng));
      const done = from ? Math.min(START_METERS, haversine(walk.origin, from)) : 0;
      $('warmToGo').textContent = `${Math.max(0, Math.round(START_METERS - done))} m`;
      $('warmBar').style.width = `${(done / START_METERS) * 100}%`;
    } else if (phase === 'paused') {
      const left = walk.slowSince === null ? SLOW_MS_TO_RESUME : SLOW_MS_TO_RESUME - (now - walk.slowSince);
      $('pauseLeft').textContent = clock(left);
      const n = walkNewCount();
      $('pauseNote').textContent = `Recording picks up again after a minute at walking speed. ` +
        (n ? `Your ${n.toLocaleString()} new hex${n === 1 ? ' is' : 'es are'} safe.` : 'Nothing you walked is lost.');
    }
  }

  let ticker = null;

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

  function newWalk(start, replay = false) {
    return {
      start, km: 0, newCells: new Set(), cells: new Map(), lastCell: null, lastFix: null,
      history: [], pending: [], moving: false, fastCount: 0, fastSince: 0, slowSince: null, slowFixes: [],
      origin: null, armed: false, replay, gpsOk: replay, lastAcc: null, lastPoint: null,
    };
  }

  /**
   * Finish a walk's hexes: one more visit each, warmed back to full heat.
   * Returns the points earned. With count = false (re-importing a walk that's
   * already in) only the last-visit times are brought up to date.
   */
  function countVisits(count = true) {
    let points = 0;
    for (const [c, t] of walk.cells) {
      const isNew = walk.newCells.has(c);
      const prevLast = isNew ? 0 : lastSeen.get(c);
      if (count) {
        const before = isNew ? 0 : visitCount(c);
        points += core.visitGain(before, prevLast, before + 1, t);
        visits.set(c, before + 1);
      }
      if (!prevLast || t > prevLast) lastSeen.set(c, t);
    }
    return Math.round(points * 100) / 100;
  }

  /** Tell other parts of the app (community sync) that walks were added or data changed. */
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent('scoop:' + name, { detail }));
  }

  /** Badges your walks earn on this device, plus any the server awarded. */
  let serverBadges = new Map();
  function earnedBadges() {
    let maxVisits = 0;
    for (const c of visited.keys()) maxVisits = Math.max(maxVisits, visitCount(c));
    const local = core.localBadges({
      walks: walks.length,
      hexes: visited.size,
      km: walks.reduce((a, w) => a + (w.km || 0), 0),
      longestStreak: core.streaks(walks.map((w) => w.start)).longest,
      maxVisits,
    });
    for (const k of serverBadges.keys()) local.add(k);
    return local;
  }

  function startWalk() {
    if (!isNative && !ensureWatching()) return;
    closeSheet();
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
      if (Date.now() - lastPos.time < 30000) recordFix(lastPos.latlng, lastPos.accuracy, Date.now(), null);
    }
    if (isNative) toast('Walk started · you can lock your phone');
    clearInterval(ticker);
    ticker = setInterval(updateCard, 1000);
    scheduleRender();
    updateCard();
  }

  function stopWalk(silent = false) {
    if (!walk) return;
    if (!walk.moving) commitPending();
    const badgesBefore = earnedBadges();
    const summary = { start: walk.start, end: Date.now(), km: +walk.km.toFixed(3), newCells: walk.newCells.size };
    const warmed = [...walk.cells.keys()].filter((c) => !walk.newCells.has(c)).length;
    summary.points = countVisits();
    const saved = summary.km > 0 || summary.newCells > 0 || summary.points > 0;
    if (saved) walks.push(summary);
    walk = null;
    clearInterval(ticker);
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
    render();
    if (silent) return;
    if (!saved) {
      toast(`Nothing recorded · hexes count once you're ${START_METERS} m away`, 3500);
      return;
    }
    const fresh = [...earnedBadges()].filter((k) => !badgesBefore.has(k));
    showSummary(summary, warmed, fresh);
  }

  function showSummary(w, warmed, freshBadges) {
    const dur = clock(w.end - w.start);
    const when = new Date(w.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const row = (sw, label, value) => el('div', { class: 'sum-row' }, el('span', {}, sw, label), el('b', {}, value));
    const badge = freshBadges.length ? core.BADGES[freshBadges[0]] : null;
    fillEl($('summaryBody'),
      el('div', { class: 'stack' },
        el('div', { class: 'summary-top' },
          el('div', { class: 'stack tight', style: 'gap:2px' },
            el('span', { class: 'when' }, `Walk saved · ${when}`),
            el('span', { class: 'summary-km' }, w.km.toFixed(2), el('small', {}, 'km'))),
          el('span', { class: 'pill' }, `+${Math.round(w.points).toLocaleString()} pts`)),
        el('div', { class: 'sum-rows' },
          row(el('span', { class: 'hex-sw', style: `background:${HEAT_BANDS[0].color}` }), 'New hexes', w.newCells.toLocaleString()),
          row(el('span', { class: 'hex-sw', style: `background:${HEAT_BANDS[2].color}` }), 'Warmed back up', warmed.toLocaleString()),
          row(el('span', { class: 'ring-sw' }), 'Time', dur)),
        badge ? el('div', { class: 'new-badge' },
          el('div', { class: 'hex-badge hot' }, badge.glyph),
          el('div', {}, el('b', {}, `New badge: ${badge.label}`), el('small', {}, badge.desc))) : null,
        el('button', { class: 'btn', onclick: closeSheet }, 'Done')));
    openSheet('summarySheet');
  }

  function locate() {
    follow = true;
    if (lastPos) {
      map.setView(lastPos.latlng, Math.max(map.getZoom(), 16));
    } else if (ensureWatching()) {
      pendingCenter = true;
      toast('Finding you…');
    }
  }

  $('btnWalk').addEventListener('click', () => (walk ? stopWalk() : startWalk()));
  $('btnLocate').addEventListener('click', locate);
  $('btnLocateWalk').addEventListener('click', locate);

  // ---------- small DOM helpers ----------

  /** Build an element. Children are appended as text unless they're nodes. */
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : String(kid));
    }
    return node;
  }

  function fillEl(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  }

  /** Segmented control: options are [value, label] pairs. */
  function segmented(node, options, value, onPick) {
    node.setAttribute('role', 'radiogroup');
    fillEl(node, options.map(([v, label]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value),
      onclick: (e) => {
        for (const b of node.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
        onPick(v);
      },
    }, label)));
    return node;
  }

  // ---------- sheets ----------

  let sheetTimer = null;
  let currentSheet = null;
  function openSheet(id) {
    clearTimeout(sheetTimer);
    for (const s of document.querySelectorAll('.sheet')) {
      if (s.id === id) continue;
      s.classList.remove('open');
      s.hidden = true;
    }
    const sheet = $(id);
    sheet.hidden = false;
    sheet.scrollTop = 0;
    void sheet.offsetHeight; // start the slide from below
    sheet.classList.add('open');
    document.body.classList.add('sheet-open');
    currentSheet = id;
  }
  function closeSheet() {
    const open = document.querySelectorAll('.sheet.open');
    if (!open.length) return;
    for (const s of open) s.classList.remove('open');
    document.body.classList.remove('sheet-open');
    currentSheet = null;
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => {
      for (const s of document.querySelectorAll('.sheet:not(.open)')) s.hidden = true;
    }, 360);
  }
  const anySheetOpen = () => !!currentSheet;
  $('scrim').addEventListener('click', closeSheet);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet();
  });

  // ---------- dialog (destructive actions) ----------

  let dialogDone = null;
  /**
   * Centred confirmation for destructive actions. Resolves 'confirm', 'extra'
   * (the optional safer action, e.g. export first) or null when cancelled.
   */
  function confirmDialog({ title, body, confirm, extra }) {
    if (dialogDone) dialogDone(null);
    $('dialogTitle').textContent = title;
    $('dialogBody').textContent = body;
    return new Promise((resolve) => {
      const finish = (v) => {
        dialogDone = null;
        $('dialog').hidden = true;
        resolve(v);
      };
      dialogDone = finish;
      fillEl($('dialogActions'),
        extra ? el('button', { class: 'btn outline', onclick: () => finish('extra') }, extra) : null,
        el('button', { class: 'btn danger', onclick: () => finish('confirm') }, confirm),
        el('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'));
      $('dialog').hidden = false;
      $('dialogActions').lastChild.focus();
    });
  }
  $('dialog').querySelector('[data-cancel]').addEventListener('click', () => dialogDone && dialogDone(null));

  // ---------- Me ----------

  const identity = { initial: '·', name: 'Your map', sub: 'Everything stays on this phone' };
  function setIdentity(next) {
    Object.assign(identity, next);
    $('meInitial').textContent = identity.initial;
    $('meAvatar').textContent = identity.initial;
    $('meName').textContent = identity.name;
    $('meSub').textContent = identity.sub;
  }
  setIdentity({});

  function renderBadges() {
    const earned = earnedBadges();
    const all = Object.entries(core.BADGES);
    $('badgeLabel').textContent = `Badges · ${earned.size} of ${all.length}`;
    fillEl($('badgeGrid'), all.map(([key, b]) => el('div', {
      class: earned.has(key) ? 'badge earned' : 'badge',
      title: `${b.label}: ${b.desc}` + (serverBadges.has(key) ? ` · earned ${new Date(serverBadges.get(key)).toLocaleDateString()}` : ''),
    }, el('div', { class: 'hex' }, b.glyph), el('span', { class: 'name' }, b.label))));
  }

  function openMe() {
    const streak = core.streaks(walks.map((w) => w.start));
    $('meScore').textContent = Math.round(hexScoreTotal()).toLocaleString();
    $('meStreak').textContent = String(streak.current);
    $('meBest').textContent = String(streak.longest);
    renderTrends();
    renderBadges();
    emit('me-open', {});
    openSheet('meSheet');
  }
  $('btnMe').addEventListener('click', openMe);
  $('btnSettings').addEventListener('click', () => openSettings());

  // ---------- trends (private: worked out on the device) ----------

  const TREND_UNITS = {
    day: { count: 14, now: 'Today', prev: 'yesterday', adj: 'daily', span: '14 days' },
    week: { count: 12, now: 'This week', prev: 'last week', adj: 'weekly', span: '12 weeks' },
    month: { count: 12, now: 'This month', prev: 'last month', adj: 'monthly', span: '12 months' },
  };
  const TREND_METRICS = {
    hexes: { title: 'New hexes', say: (n) => `${Math.round(n).toLocaleString()} new hex${Math.round(n) === 1 ? '' : 'es'}` },
    points: { title: 'Points', say: (n) => `${Math.round(n).toLocaleString()} pts` },
    km: { title: 'Distance', say: (n) => `${n.toFixed(n >= 10 ? 0 : 1)} km` },
  };
  const trendPrefs = Object.assign({ unit: 'week', metric: 'hexes' }, loadJSON('scoop.trends.v1', {}));

  function trendEvents(metric) {
    if (metric === 'hexes') return [...visited.values()].map((t) => ({ t, v: 1 }));
    if (metric === 'km') return walks.map((w) => ({ t: w.start, v: w.km || 0 }));
    return walks.filter((w) => typeof w.points === 'number').map((w) => ({ t: w.start, v: w.points }));
  }

  function periodName(start, unit, i, last) {
    const d = new Date(start);
    if (i === last) return TREND_UNITS[unit].now;
    if (unit === 'day') return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (unit === 'week') return `Week of ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function renderTrends() {
    const { unit, metric } = trendPrefs;
    const fmt = TREND_METRICS[metric];
    const U = TREND_UNITS[unit];
    $('trendTitle').textContent = `${fmt.title} · ${U.adj}`;
    $('trendSpan').textContent = U.span;
    const buckets = core.trendBuckets(trendEvents(metric), unit, U.count);
    const last = buckets.length - 1;
    const max = Math.max(...buckets.map((b) => b.value), 0);
    const peak = buckets.findIndex((b) => b.value === max && max > 0);
    const readout = $('trendReadout');
    const chart = $('trendChart');
    const select = (i) => {
      [...chart.children].forEach((c, k) => c.setAttribute('aria-pressed', String(k === i)));
      readout.textContent = i === last
        ? `${U.now}: ${fmt.say(buckets[last].value)} · ${fmt.say(buckets[last - 1].value)} ${U.prev}`
        : `${periodName(buckets[i].start, unit, i, last)}: ${fmt.say(buckets[i].value)}`;
    };
    fillEl(chart, buckets.map((b, i) => el('button', {
      type: 'button',
      'aria-label': `${periodName(b.start, unit, i, last)}: ${fmt.say(b.value)}`,
      onclick: () => select(i),
    }, el('span', {
      class: b.value > 0 ? 'bar' : 'bar zero',
      style: b.value > 0 ? `height:${Math.max(4, (b.value / max) * 100)}%` : null,
    }))));
    select(last);

    const total = buckets.reduce((a, b) => a + b.value, 0);
    let summary = `Last ${U.span}: ${fmt.say(total)}`;
    if (peak >= 0) summary += ` · best: ${periodName(buckets[peak].start, unit, peak, -1)} (${fmt.say(max)})`;
    if (metric === 'points' && walks.some((w) => typeof w.points !== 'number')) {
      summary += '. Points are counted for walks recorded since scores started fading.';
    }
    $('trendSummary').textContent = summary;
  }

  function saveTrendPrefs() {
    saveJSON('scoop.trends.v1', trendPrefs);
    renderTrends();
  }
  segmented($('segTrendMetric'), [['hexes', 'Hexes'], ['points', 'Points'], ['km', 'Km']], trendPrefs.metric,
    (v) => { trendPrefs.metric = v; saveTrendPrefs(); });
  segmented($('segTrendUnit'), [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], trendPrefs.unit,
    (v) => { trendPrefs.unit = v; saveTrendPrefs(); });

  // ---------- settings ----------

  function openSettings() {
    emit('settings-open', {});
    openSheet('settingsSheet');
  }

  fillEl($('heatLegend'), HEAT_BANDS.map((b) => el('div', {},
    el('div', { class: 'heat-hex', style: `background:${b.stroke}` }, el('i', { style: `background:${b.color}` })),
    b.name)));

  if (!BASEMAPS[settings.basemap]) settings.basemap = 'osm';
  segmented($('segBasemap'), Object.entries(BASEMAPS).map(([k, b]) => [k, b.label]), settings.basemap, (v) => {
    settings.basemap = v;
    saveSettings();
    setBasemap(v);
    render();
  });

  const gridBtn = $('btnGrid');
  gridBtn.setAttribute('aria-checked', String(!!settings.grid));
  gridBtn.addEventListener('click', () => {
    settings.grid = !settings.grid;
    gridBtn.setAttribute('aria-checked', String(settings.grid));
    saveSettings();
    render();
  });

  if (!SPEED_LIMITS[settings.activity]) settings.activity = 'walk';
  segmented($('segActivity'), [['walk', 'Walking · 9 km/h'], ['run', 'Walk + run · 16 km/h']], settings.activity, (v) => {
    settings.activity = v;
    saveSettings();
  });

  segmented($('segAccuracy'), [25, 40, 75, 150].map((m) => [m, `${m} m`]), Number(settings.accuracy), (v) => {
    settings.accuracy = v;
    saveSettings();
    updateCard();
  });

  // Backup
  async function exportBackup() {
    saveNow();
    const data = { app: 'scoop', version: 1, exported: new Date().toISOString(), baseRes: BASE_RES, ...snapshot() };
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
    toast('Backup saved to Downloads');
  }
  $('btnExport').addEventListener('click', exportBackup);

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
      for (const c of visited.keys()) {
        const t = Number((data.last || {})[c]) || data.cells[c];
        if (Number.isFinite(t) && t > (lastSeen.get(c) || 0)) lastSeen.set(c, t);
      }
      const knownStarts = new Set(walks.map((w) => w.start));
      for (const w of data.walks || []) if (!knownStarts.has(w.start)) walks.push(w);
      walks.sort((a, b) => a.start - b.start);
      saveNow();
      render();
      emit('changed', {});
      closeSheet();
      toast(`Restored · ${added.toLocaleString()} new hexes merged, nothing deleted`);
    } catch (err) {
      toast('Could not read that file: ' + err.message, 4000);
    }
  });

  /** Replay a recorded track through the same walking-only filter as a live walk. */
  function replayTrack(points) {
    walk = newWalk(points[0].time, true);
    for (const p of points) recordFix(L.latLng(p.lat, p.lng), 0, p.time, null);
    if (!walk.moving) commitPending();
    const result = { start: walk.start, end: points[points.length - 1].time, km: walk.km, newCells: walk.newCells.size };
    // Re-importing the same file shouldn't count as walking there again.
    result.points = countVisits(!walks.some((w) => w.start === result.start));
    walk = null;
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
    let count = 0;
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
          if (result.km > 0 && !walks.some((w) => w.start === result.start)) {
            walks.push(result);
            count++;
          }
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
      toast(`Imported ${count} walk${count === 1 ? '' : 's'} · ${km.toFixed(1)} km · ${added.toLocaleString()} new hexes`, 4000);
    }
  });

  $('btnClear').addEventListener('click', async () => {
    const n = visited.size;
    const choice = await confirmDialog({
      title: 'Clear everything?',
      body: `This deletes your ${n.toLocaleString()} hex${n === 1 ? '' : 'es'}, walks, trends and privacy zones from this phone. It can't be undone.`,
      extra: 'Export a backup first',
      confirm: 'Clear everything',
    });
    if (choice === 'extra') return exportBackup();
    if (choice !== 'confirm') return;
    visited.clear();
    visits.clear();
    lastSeen.clear();
    walks.length = 0;
    if (walk) { walk.newCells.clear(); walk.cells.clear(); walk.pending = []; }
    saveNow();
    emit('cleared', {});
    render();
    closeSheet();
    toast('All cleared');
  });

  // ---------- onboarding (first launch) ----------

  const ONBOARDED_KEY = 'scoop.onboarded.v1';
  const ONB = [
    { t: 'Explore your city on foot, one hexagon at a time', b: 'Every street-sized hex you walk through lights up on your map.', p: 'Next', hexes: 'walk' },
    { t: 'Warm means recent', b: "Hexes you just walked glow ember. Over the weeks they cool — walk them again to warm them up. They're never lost.", p: 'Next', hexes: 'heat' },
    { t: 'Private by default', b: 'Your map lives on this phone. Scoop never draws or uploads your routes. Friends are optional.', p: 'Next' },
    { t: 'Scoop needs your location while you walk', b: "It's only used to light up hexes. Nothing leaves your phone unless you sign in.", p: 'Allow location', s: 'Not now' },
  ];
  const DENIED = {
    t: 'Location is off',
    b: isNative
      ? "Scoop can't light up hexes without it. Turn it on in Settings → Apps → Scoop → Location, then come back."
      : "Scoop can't light up hexes without it. Allow location for this site in your browser settings, then come back.",
    p: 'Try again', s: 'Look around the map',
  };

  function hideOnboarding() {
    $('onboard').hidden = true;
  }

  function requestLocation() {
    hideOnboarding();
    pendingCenter = true;
    stopWebWatch();
    ensureWatching();
  }

  function showOnboarding(step) {
    const ob = step === 'denied' ? DENIED : ONB[step];
    const onbHex = (fill, stroke) => el('div', { class: 'onb-hex', style: `background:${stroke}` }, el('i', { style: `background:${fill}` }));
    let hexes = null;
    if (ob.hexes === 'walk') {
      hexes = el('div', { class: 'onb-hexes' },
        onbHex(COLORS.walk, COLORS.walkStroke), onbHex(COLORS.walk, COLORS.walkStroke),
        onbHex(HEAT_BANDS[0].color, HEAT_BANDS[0].stroke),
        onbHex('var(--surface)', HEAT_BANDS[4].color), onbHex('var(--surface)', HEAT_BANDS[4].color));
    } else if (ob.hexes === 'heat') {
      hexes = [el('div', { class: 'onb-hexes' }, HEAT_BANDS.map((b) => onbHex(b.color, b.stroke))),
        el('div', { class: 'onb-scale' }, el('span', {}, 'Just walked'), el('span', {}, '100+ days'))];
    }
    const next = () => {
      if (step === 'denied') return requestLocation();
      if (step < ONB.length - 1) return showOnboarding(step + 1);
      saveJSON(ONBOARDED_KEY, true);
      requestLocation();
    };
    const skip = () => {
      if (step === 'denied') return hideOnboarding();
      saveJSON(ONBOARDED_KEY, true);
      showOnboarding('denied');
    };
    fillEl($('onboardCard'),
      hexes,
      el('div', { class: 'onb-text' }, el('span', { class: 'onb-title' }, ob.t), el('span', { class: 'body' }, ob.b)),
      el('div', { class: 'onb-actions' },
        el('button', { class: 'btn', onclick: next }, ob.p),
        ob.s ? el('button', { class: 'btn ghost', onclick: skip }, ob.s) : null),
      step === 'denied' ? null : el('div', { class: 'dots', 'aria-hidden': 'true' },
        ONB.map((_, i) => el('span', { class: i === step ? 'on' : '' }))));
    closeSheet();
    $('onboard').hidden = false;
  }

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

  if (!loadJSON(ONBOARDED_KEY, false) && !visited.size) showOnboarding(0);

  if (isNative) {
    $('walkTip').textContent = 'Walks keep recording with the screen off — look for the notification.';
  }

  // Android back button: close whatever is open, otherwise send the app to the
  // background (instead of quitting) so a walk in progress keeps recording.
  if (App) {
    App.addListener('backButton', () => {
      if (dialogDone) dialogDone(null);
      else if (anySheetOpen()) closeSheet();
      else if (!$('onboard').hidden && $('onboardCard').querySelector('.dots') === null) hideOnboarding();
      else App.minimizeApp();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dialogDone) dialogDone(null);
    else closeSheet();
  });

  if (!isNative && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Used by social.js (community features) and handy for debugging from the console.
  window.scoop = {
    BASE_RES, COLORS, HEAT_BANDS, map, visited, visits, visitCount, lastSeen, walks, settings, isNative, Filesystem, Share, App,
    render, scheduleRender, toast, formatNum, cellAreaCached, haversine, openSheet, closeSheet, saveNow, emit,
    hexScoreTotal, hexLayer, confirmDialog, segmented, el, fill: fillEl, setIdentity, openMe, openSettings,
    startWalk, locate, earnedBadges, renderBadges,
    setServerBadges: (m) => { serverBadges = m; },
    position: () => lastPos,
    walking: () => !!walk,
    currentSheet: () => currentSheet,
  };
  emit('ready', window.scoop);
})();
