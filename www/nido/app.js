// Nido — application (rendu, navigation, interactions tactiles, connexion).
(function () {
  "use strict";

  // Configuration : `config.js` (prioritaire) complété par la détection automatique dans Home Assistant.
  const C = window.HOME_CONFIG || (window.HOME_CONFIG = {});
  const USER_KEYS = new Set(Object.keys(C));
  const DEFAULT_PRESETS = [
    { id: "eco", label: "Éco", icon: "leaf" },
    { id: "comfort", label: "Confort", icon: "sofa-single-outline" },
    { id: "frost_protection", label: "Hors-gel", icon: "snowflake" },
    { id: "away", label: "Absent", icon: "home-export-outline" },
    { id: "home", label: "Présent", icon: "home-outline" },
    { id: "sleep", label: "Nuit", icon: "weather-night" },
    { id: "boost", label: "Boost", icon: "rocket-launch-outline" },
    { id: "auto", label: "Auto", icon: "calendar-clock" },
  ];
  // Complète la configuration avec des valeurs vides, pour que chaque section soit facultative.
  function normalizeConfig(c) {
    c.homeName = c.homeName || "Maison";
    for (const k of ["persons", "rooms", "lights", "covers", "media", "climates", "schedules", "heatingAutomations"]) c[k] = c[k] || [];
    c.climatePresets = c.climatePresets || DEFAULT_PRESETS;
    c.vacuum = c.vacuum && c.vacuum.entity ? { rooms: [], selects: [], switches: [], ...c.vacuum } : null;
    c.security = { camera: null, openings: [], motion: [], illuminance: null, ...(c.security || {}) };
    c.system = { ...(c.system || {}) };
    c.energy = { ...(c.energy || {}) };
    c.energy.fallback = { sources: [], devices: [], ...(c.energy.fallback || {}) };
    c.heatingRule = c.heatingRule || "any";
    return c;
  }
  normalizeConfig(C);
  const $ = (s) => document.querySelector(s);
  const STORE = { conn: "nido.conn", theme: "nido.theme", oauth: "nido.oauth", prefs: "nido.prefs", custom: "nido.custom" };
  // Reprise des réglages enregistrés par l'ancienne version (« Maison ») sur le même appareil.
  try {
    for (const k of ["conn", "theme", "oauth", "prefs"]) {
      const old = localStorage.getItem("maison." + k);
      if (old !== null && localStorage.getItem("nido." + k) === null) localStorage.setItem("nido." + k, old);
    }
  } catch { /* stockage indisponible */ }

  let conn = null;
  let view = "accueil";
  let sheet = null;
  let forecast = [];
  let lastHistory = 0;
  const hist = {};
  const pendingTarget = {};
  const tempTimers = {};

  // ---------- Stockage local (protégé) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
  };

  // ---------- Personnalisation (cartes masquées, renommées, déplacées ; pages ; règle de chauffage) ----------
  // Enregistrée dans le compte Home Assistant de l'utilisateur (elle le suit sur tous ses appareils),
  // avec une copie locale pour un démarrage instantané.
  const slugify = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const custom = { cards: {}, hiddenPages: [], heatingRule: null, ...(store.get(STORE.custom) || {}) };
  (function migrateOldPrefs() {
    const old = store.get(STORE.prefs);
    if (!old || store.get(STORE.custom)) return;
    (old.hiddenRooms || []).forEach((n) => (custom.cards["room-" + slugify(n)] = { ...(custom.cards["room-" + slugify(n)] || {}), hidden: true }));
    (old.hiddenLights || []).forEach((e) => (custom.cards["lt-" + e] = { ...(custom.cards["lt-" + e] || {}), hidden: true }));
    custom.hiddenPages = old.hiddenPages || [];
    custom.heatingRule = old.heatingRule || null;
    store.set(STORE.custom, custom);
  })();
  let saveTimer = 0;
  function saveCustom() {
    store.set(STORE.custom, custom);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (conn && conn.send && !(conn instanceof window.DemoConnection)) {
        conn.send({ type: "frontend/set_user_data", key: "nido", value: custom }).catch((e) => console.warn("Personnalisation non synchronisée", e));
      }
    }, 600);
  }
  async function loadCustom() {
    if (!conn || conn instanceof window.DemoConnection) return;
    try {
      const res = await conn.send({ type: "frontend/get_user_data", key: "nido" });
      if (res?.value) {
        Object.assign(custom, { cards: {}, hiddenPages: [], heatingRule: null }, res.value);
        store.set(STORE.custom, custom);
      } else if (Object.keys(custom.cards).length || custom.hiddenPages.length || custom.heatingRule) {
        saveCustom(); // première synchronisation des réglages déjà faits sur cet appareil
      }
    } catch (e) {
      console.warn("Personnalisation du compte indisponible", e);
    }
  }
  const cardOpt = (cid) => custom.cards[cid] || {};
  let editMode = false;
  const heatingRule = () => custom.heatingRule || C.heatingRule || "any";
  // En mode personnalisation, les cartes masquées restent visibles (estompées) pour pouvoir les réafficher.
  const rooms = () => C.rooms.filter((r) => editMode || !cardOpt("room-" + slugify(r.name)).hidden);
  const lights = () => C.lights.filter((l) => editMode || !cardOpt("lt-" + l.entity).hidden);
  // Pages disponibles selon les appareils présents, puis masquées ou non par l'utilisateur.
  const PAGE_AVAILABLE = {
    lumieres: () => C.lights.length + C.covers.length + C.media.length > 0,
    chauffage: () => C.climates.length > 0,
    conso: () => !!(C.energy.power || C.energy.fallback.sources.length || energy.prefs?.sources?.length),
    menage: () => !!C.vacuum,
    securite: () => !!(C.security.camera || C.security.openings.length || C.security.motion.length || C.persons.length),
    systeme: () => true,
  };
  const pageOn = (v) => !PAGE_AVAILABLE[v] || (PAGE_AVAILABLE[v]() && !custom.hiddenPages.includes(v));

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const st = (id) => conn?.states[id];
  const val = (id) => st(id)?.state;
  const num = (id) => parseFloat(val(id));
  const attr = (id, a) => st(id)?.attributes?.[a];
  const isUnav = (id) => !st(id) || val(id) === "unavailable";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const fname = (id) => attr(id, "friendly_name") || id;
  const ids = (t) => (t === "@lights" ? lights().map((l) => l.entity) : [].concat(t));
  const haptic = () => { try { navigator.vibrate?.(8); } catch { /* non supporté */ } };
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isDesktop = () => window.matchMedia("(min-width: 1100px)").matches;

  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  function ago(iso) {
    if (!iso) return "";
    const s = (new Date(iso).getTime() - Date.now()) / 1000;
    const a = Math.abs(s);
    if (a < 60) return "à l'instant";
    if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  }

  const WEATHER = {
    "clear-night": ["weather-night", "Nuit claire"], cloudy: ["weather-cloudy", "Nuageux"], fog: ["weather-fog", "Brouillard"],
    hail: ["weather-hail", "Grêle"], lightning: ["weather-lightning", "Orage"], "lightning-rainy": ["weather-lightning-rainy", "Orage et pluie"],
    partlycloudy: ["weather-partly-cloudy", "Éclaircies"], pouring: ["weather-pouring", "Averses"], rainy: ["weather-rainy", "Pluie"],
    snowy: ["weather-snowy", "Neige"], "snowy-rainy": ["weather-snowy-rainy", "Neige fondue"], sunny: ["weather-sunny", "Ensoleillé"],
    windy: ["weather-windy", "Venteux"], "windy-variant": ["weather-windy-variant", "Venteux"], exceptional: ["alert-circle-outline", "Exceptionnel"],
  };
  const wx = (c) => WEATHER[c] || ["weather-cloudy", c || "—"];
  const VAC_STATE = { docked: "À la base", cleaning: "En nettoyage", returning: "Retour à la base", paused: "En pause", idle: "Inactif", error: "Erreur", unavailable: "Indisponible" };
  const MEDIA_STATE = { playing: "Lecture", paused: "En pause", idle: "Inactif", off: "Éteint", on: "Allumé", standby: "Veille", buffering: "Chargement", unavailable: "Indisponible" };
  const COVER_STATE = { open: "Ouvert", closed: "Fermé", opening: "Ouverture…", closing: "Fermeture…", unavailable: "Indisponible" };
  const HVAC = { heat: "Chauffe", auto: "Programme", off: "Arrêt", unavailable: "Indisponible" };
  const PERSON = (s) => (s === "home" ? "À la maison" : s === "not_home" ? "Dehors" : s === "unknown" ? "Inconnu" : s);

  // ---------- Historique (courbes) ----------
  function bucket(points, n = 72) {
    if (points.length <= n) return points;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    const size = (t1 - t0) / n;
    const out = [];
    let acc = [], edge = t0 + size;
    for (const p of points) {
      if (p[0] > edge && acc.length) {
        out.push([acc[acc.length - 1][0], acc.reduce((s, q) => s + q[1], 0) / acc.length]);
        acc = [];
        while (p[0] > edge) edge += size;
      }
      acc.push(p);
    }
    if (acc.length) out.push([acc[acc.length - 1][0], acc.reduce((s, q) => s + q[1], 0) / acc.length]);
    return out;
  }

  const trackedSensors = () => [...new Set([...C.rooms.map((r) => r.temp), ...C.rooms.map((r) => r.hum), C.system.freebox?.down, C.system.freebox?.up, C.system.waterHeater?.power, C.energy.power].filter(Boolean))];

  async function loadHistory() {
    try {
      const res = await conn.history(trackedSensors(), 24);
      Object.entries(res || {}).forEach(([id, arr]) => {
        hist[id] = bucket(arr.map((p) => [p.lu ?? p.lc ?? 0, parseFloat(p.s)]).filter((p) => Number.isFinite(p[1]) && p[0]));
      });
      lastHistory = Date.now();
      scheduleRender();
    } catch (e) {
      console.warn("Historique indisponible", e);
    }
  }

  function pushHistory(id) {
    if (!hist[id]) return;
    const v = num(id);
    if (!Number.isFinite(v)) return;
    const now = Date.now() / 1000;
    hist[id].push([now, v]);
    while (hist[id].length && hist[id][0][0] < now - 86400) hist[id].shift();
  }

  function sparkPath(points, w, h, pad, minSpan) {
    if (!points || points.length < 2) return null;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    let v0 = Math.min(...points.map((p) => p[1])), v1 = Math.max(...points.map((p) => p[1]));
    if (v1 - v0 < minSpan) { const m = (v0 + v1) / 2; v0 = m - minSpan / 2; v1 = m + minSpan / 2; }
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * w;
    const y = (v) => h - pad - ((v - v0) / (v1 - v0)) * (h - 2 * pad);
    return points.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join(" ");
  }

  function spark(id, color, key, minSpan = 1) {
    const w = 200, h = 54;
    const d = sparkPath(hist[id], w, h, 6, minSpan);
    if (!d) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="g-${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.26"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
      <path d="${d} L ${w} ${h} L 0 ${h} Z" fill="url(#g-${key})"/>
      <path d="${d}" fill="none" style="stroke:${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  // ---------- Composants ----------
  const card = (key, cls, inner) => `<section class="card ${cls}" data-k="${esc(key)}">${inner}</section>`;
  const head = (title, extra = "") => `<div class="card-head"><h2 data-title>${esc(title)}</h2>${extra}</div>`;
  // Icône principale d'une carte (modifiable en mode personnalisation).
  const ticon = (n) => `<i class="mdi mdi-${esc(n)}" data-icon aria-hidden="true"></i>`;
  // Bloc « titre + contenu » personnalisable d'un seul tenant (masquer, renommer, déplacer).
  const group = (cid, cls, html) => `<div class="group ${cls}" data-cid="${esc(cid)}">${html}</div>`;
  const icon = (n) => `<i class="mdi mdi-${esc(n)}" aria-hidden="true"></i>`;
  const sw = (eid, on, cls = "", label = "") =>
    `<button class="switch ${cls}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="toggle" data-eid="${esc(eid)}" ${isUnav(eid) ? "disabled" : ""}></button>`;
  // Rangée de cartes : le nombre de colonnes suit le nombre de cartes pour que la ligne soit pleine
  // (au moins 4 colonnes sur ordinateur pour qu'une carte seule ne devienne pas géante).
  const cols = (n) => `style="--cols-t:${clamp(n, 2, 4)};--cols-d:${clamp(n, 4, 6)}"`;
  const chev = () => `<i class="mdi mdi-chevron-right chev" aria-hidden="true"></i>`;
  // Titre de section ; avec `to`, il devient un lien vers une autre page.
  const section = (key, title, hint = "", to = "") => to
    ? `<button class="section-title link" data-k="${key}" data-act="nav" data-view="${to}"><h2 data-title>${esc(title)}</h2>${chev()}${hint ? `<span class="hint-end">${esc(hint)}</span>` : ""}</button>`
    : `<div class="section-title" data-k="${key}"><h2 data-title>${esc(title)}</h2>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`;
  const headLink = (title, to, extra = "") => `<button class="card-head link" data-act="nav" data-view="${to}"><h2 data-title>${esc(title)}</h2>${chev()}${extra}</button>`;
  // Ouvre la fiche détaillée (historique 24 h) d'une entité.
  const info = (eid, label = "") => `data-act="info" data-eid="${esc(eid)}"${label ? ` data-label="${esc(label)}"` : ""}`;
  const slug = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const sameRoom = (a, b) => !!a && !!b && slug(a) === slug(b);
  const roomOfClimate = (eid) => C.rooms.find((r) => (r.climates || []).includes(eid));
  const roomLink = (r) => `data-act="nav" data-view="piece" data-param="${slug(r.name)}"`;

  function ring(p, color, label, sub, cls = "") {
    const r = 42, c = 2 * Math.PI * r, off = c * (1 - clamp(p || 0, 0, 100) / 100);
    return `<div class="ring ${cls}"><svg viewBox="0 0 100 100" width="100%" height="100%">
      <circle cx="50" cy="50" r="${r}" fill="none" style="stroke:var(--surface-3)" stroke-width="8"/>
      <circle cx="50" cy="50" r="${r}" fill="none" style="stroke:${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
      <div class="lbl"><div><b>${label}</b><small>${esc(sub)}</small></div></div></div>`;
  }
  const sev = (p) => (p >= 90 ? "var(--danger)" : p >= 75 ? "var(--warm)" : "var(--ok)");

  // État du chauffage d'une pièce : "heating" (au moins un radiateur chauffe en mode Confort),
  // "idle" (allumé, en Éco ou au repos), "off" (tout éteint), "unav" (radiateurs indisponibles)
  // ou null (pas de radiateur). Un radiateur qui chauffe en Éco ne compte pas comme « en chauffe ».
  const COMFORT_PRESETS = ["comfort", "comfort-1", "comfort-2"];
  // Règle « en chauffe » : dès que le radiateur chauffe (par défaut), ou seulement en mode Confort (réglable).
  const isHeating = (s) => !!s && (heatingRule() !== "comfort" || COMFORT_PRESETS.includes(s.attributes.preset_mode)) &&
    (s.attributes.hvac_action ? s.attributes.hvac_action === "heating" : s.state !== "off" && s.state !== "unavailable");
  function roomHeat(r) {
    const list = (r.climates || []).map(st).filter(Boolean);
    if (!list.length) return null;
    const live = list.filter((s) => s.state !== "unavailable");
    if (!live.length) return "unav";
    if (live.some(isHeating)) return "heating";
    if (live.some((s) => s.state !== "off")) return "idle";
    return "off";
  }
  const HEAT_BADGE = {
    heating: ["fire", "Chauffage en marche (Confort)"],
    idle: ["fire", "Radiateur en Éco ou au repos"],
    off: ["fire-off", "Chauffage éteint"],
    unav: ["fire-alert", "Radiateur indisponible"],
  };

  function lightInfo(l) {
    const s = st(l.entity);
    const a = s?.attributes || {};
    const modes = a.supported_color_modes || [];
    const on = s?.state === "on";
    const unav = isUnav(l.entity);
    const dimmable = modes.some((m) => m !== "onoff");
    const bri = on ? Math.round((a.brightness || 0) / 2.55) : 0;
    const label = unav ? "Indisponible" : on ? (dimmable ? bri + " %" : "Allumée") : "Éteinte";
    return { s, a, on, unav, dimmable, ct: modes.includes("color_temp"), bri, label };
  }

  // ---------- Tuiles ----------
  function lightTile(l) {
    const L = lightInfo(l);
    return `<div class="tile light press ${L.on ? "is-on" : ""} ${L.unav ? "unavailable" : ""}" role="button" tabindex="0" aria-pressed="${L.on}"
        aria-label="${esc(l.name)} : ${L.label}" data-act="toggle" data-eid="${esc(l.entity)}" ${L.dimmable ? 'data-long="light"' : ""} data-k="lt-${esc(l.entity)}">
      <div class="tile-top"><span class="chip-icon warm">${ticon(l.icon)}</span>
        ${L.dimmable ? `<button class="tile-more" data-act="sheet" data-sheet="light" data-eid="${esc(l.entity)}" aria-label="Régler ${esc(l.name)}">${icon("tune-vertical")}</button>` : ""}</div>
      <div class="tile-name" data-title>${esc(l.name)}</div><div class="tile-state">${esc(l.room)} · ${L.label}</div>
      ${L.on && L.dimmable ? `<span class="tile-bar" style="width:${L.bri}%"></span>` : ""}</div>`;
  }

  function coverTile(c) {
    const s = val(c.entity);
    return `<div class="tile cover ${s === "open" ? "is-on" : ""} ${isUnav(c.entity) ? "unavailable" : ""}" data-k="cv-${esc(c.entity)}">
      <div class="tile-top"><span class="chip-icon cool">${ticon(s === "closed" ? "window-shutter" : "window-shutter-open")}</span></div>
      <div class="tile-name" data-title>${esc(c.name)}</div><div class="tile-state">${esc(COVER_STATE[s] || s || "—")}</div>
      <div class="seg">
        <button data-act="svc" data-svc="cover.open_cover" data-eid="${c.entity}" aria-label="Ouvrir ${esc(c.name)}">${icon("chevron-up")}</button>
        <button data-act="svc" data-svc="cover.stop_cover" data-eid="${c.entity}" aria-label="Arrêter ${esc(c.name)}">${icon("stop")}</button>
        <button data-act="svc" data-svc="cover.close_cover" data-eid="${c.entity}" aria-label="Fermer ${esc(c.name)}">${icon("chevron-down")}</button>
      </div></div>`;
  }

  function mediaRow(m) {
    const s = st(m.entity);
    const state = s?.state || "unavailable";
    const a = s?.attributes || {};
    const title = a.media_title ? esc(a.media_title) + (a.media_artist ? ` · ${esc(a.media_artist)}` : "") : esc(MEDIA_STATE[state] || state);
    const active = state === "playing" || state === "paused";
    const ctrl = active
      ? `<div class="seg inline"><button data-act="svc" data-svc="media_player.media_play_pause" data-eid="${m.entity}" aria-label="Lecture ou pause">${icon(state === "playing" ? "pause" : "play")}</button>
          <button data-act="svc" data-svc="media_player.media_next_track" data-eid="${m.entity}" aria-label="Suivant">${icon("skip-next")}</button></div>`
      : `<button class="icon-btn" data-act="svc" data-svc="media_player.${state === "off" ? "turn_on" : "turn_off"}" data-eid="${m.entity}" aria-label="Allumer ou éteindre ${esc(m.name)}" ${state === "unavailable" ? "disabled" : ""}>${icon("power")}</button>`;
    return `<div class="row ${active ? "is-on" : ""}"><span class="chip-icon ok">${icon(m.icon)}</span>
      <div class="txt"><div class="title">${esc(m.name)}</div><div class="sub">${title}</div></div>${ctrl}</div>`;
  }

  function nowPlaying() {
    const m = C.media.find((x) => val(x.entity) === "playing") || C.media.find((x) => val(x.entity) === "paused");
    if (m && !pageOn("lumieres")) return null;
    if (!m) return null;
    const s = st(m.entity), a = s.attributes || {};
    const pic = a.entity_picture && conn.baseUrl ? conn.imageUrl(a.entity_picture) : "";
    return card("now", "s-6", headLink("En cours", "lumieres") + `<div class="now-playing">
      <div class="cover-art" ${pic ? `style="background-image:url('${esc(pic)}')"` : ""}>${pic ? "" : icon(m.icon)}</div>
      <div class="txt" style="flex:1;min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.media_title || MEDIA_STATE[s.state])}</div>
        <div class="muted" style="font-size:13px">${esc(a.media_artist || "")}${a.media_artist ? " · " : ""}${esc(m.name)}</div></div>
      <div class="seg inline"><button data-act="svc" data-svc="media_player.media_play_pause" data-eid="${m.entity}" aria-label="Lecture ou pause">${icon(s.state === "playing" ? "pause" : "play")}</button>
        <button data-act="svc" data-svc="media_player.media_next_track" data-eid="${m.entity}" aria-label="Suivant">${icon("skip-next")}</button></div></div>`);
  }

  // ---------- Accueil ----------
  function hero() {
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const period = h < 6 || h >= 22 ? "night" : h < 11 ? "morning" : h < 18 ? "day" : "evening";
    const hello = h < 5 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir";
    const w = C.weather ? st(C.weather) : null;
    const [wIcon, wLabel] = wx(w?.state);
    const fc = forecast.slice(0, 5).map((f) => {
      const day = new Date(f.datetime).toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "");
      return `<div class="fc"><div class="d">${esc(day)}</div>${icon(wx(f.condition)[0])}<div>${Math.round(f.temperature)}°</div><div class="lo">${f.templow != null ? Math.round(f.templow) + "°" : ""}</div></div>`;
    }).join("");
    const people = C.persons.map((p) => {
      const s = val(p.entity);
      const pic = attr(p.entity, "entity_picture");
      const style = pic && conn.baseUrl ? ` style="background-image:url('${esc(conn.imageUrl(pic))}')"` : "";
      return `<div class="person ${s === "home" ? "home" : ""}"><span class="avatar"${style}>${style ? "" : esc(p.name[0].toUpperCase())}</span>${esc(p.name)} <span class="where">${esc(PERSON(s))}</span></div>`;
    }).join("");
    return `<section class="card hero s-8" data-period="${period}" data-k="hero">
      <div class="hero-top">
        <div><div class="hello">${hello}, ${esc(C.persons[0]?.name || "")}</div>
          <div class="clock">${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div>
          <div class="date">${esc(d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }))}</div></div>
        ${w ? `<button class="wx-now link" data-act="sheet" data-sheet="weather" aria-label="Météo détaillée">${icon(wIcon)}<div class="t">${fmt(w.attributes.temperature, 0)}°</div><div class="c">${esc(wLabel)}</div>
          <div class="m">${icon("water-percent")}${fmt(w.attributes.humidity, 0)} % · ${fmt(w.attributes.wind_speed, 0)} km/h</div></button>` : ""}
      </div>
      ${people ? `<button class="people link" data-act="sheet" data-sheet="map" aria-label="Carte du foyer">${people}</button>` : ""}
      ${fc ? `<button class="forecast link" data-act="sheet" data-sheet="weather" aria-label="Prévisions détaillées">${fc}</button>` : ""}
    </section>`;
  }

  // « En un coup d'œil » : l'état de la maison en une carte, chaque ligne mène à sa page.
  function summaryCard() {
    const line = (to, ic, tone, title, value) => `<button class="row link ${tone ? "is-on" : ""}" data-act="nav" data-view="${to}">
      <span class="chip-icon ${tone}">${icon(ic)}</span><div class="txt"><div class="title">${title}</div></div><span class="val">${value}</span>${chev()}</button>`;
    const heating = rooms().filter((r) => roomHeat(r) === "heating").length;
    const on = lights().filter((l) => val(l.entity) === "on").length;
    const va = num(C.energy.power);
    const ptec = String(val(C.energy.period) || "");
    const open = C.security.openings.filter((o) => val(o.entity) === "on");
    const vac = C.vacuum ? st(C.vacuum.entity) : null;
    const bat = C.vacuum ? num(C.vacuum.battery) : NaN;
    const unit = attr(C.energy.power, "unit_of_measurement") || "W";
    const lines = [
      pageOn("chauffage") && line("chauffage", "fire", heating ? "heat" : "", "Chauffage", heating ? `${heating} pièce${heating > 1 ? "s" : ""} en chauffe` : "Au repos"),
      pageOn("lumieres") && lights().length && line("lumieres", "lightbulb-outline", on ? "warm" : "", "Lumières", on ? `${on} allumée${on > 1 ? "s" : ""}` : "Tout est éteint"),
      pageOn("conso") && C.energy.power && line("conso", "lightning-bolt-outline", "", "Consommation", Number.isFinite(va) ? `${fmt(va / 1000, 2)} k${unit === "VA" ? "VA" : "W"}${/^HP/i.test(ptec) ? " · HP" : /^HC/i.test(ptec) ? " · HC" : ""}` : "—"),
      pageOn("securite") && C.security.openings.length && line("securite", open.length ? "door-open" : "door", open.length ? "heat" : "", "Ouvertures", open.length === 1 ? esc(open[0].name) + " ouverte" : open.length ? `${open.length} ouvertes` : "Tout est fermé"),
      pageOn("menage") && line("menage", "robot-vacuum", "", "Aspirateur", `${esc(VAC_STATE[vac?.state] || vac?.state || "—")}${Number.isFinite(bat) ? ` · ${fmt(bat, 0)} %` : ""}`),
    ].filter(Boolean);
    if (!lines.length) return "";
    return card("summary", "s-4 summary", head("En un coup d'œil") + `<div class="rows">${lines.join("")}</div>`);
  }

  function roomCard(r, i) {
    const t = r.temp ? num(r.temp) : NaN;
    const hum = r.hum ? num(r.hum) : NaN;
    const heat = roomHeat(r);
    const badge = heat ? `<span class="heat-badge ${heat}" role="img" aria-label="${HEAT_BADGE[heat][1]}" title="${HEAT_BADGE[heat][1]}">${icon(HEAT_BADGE[heat][0])}</span>` : "";
    return `<section class="card room link press ${heat === "heating" ? "heat-on" : ""}" data-k="room-${slugify(r.name)}" ${roomLink(r)} role="link" tabindex="0" aria-label="${esc(r.name)} : ${fmt(t)} degrés">${badge}
      <div class="name">${ticon(r.icon)}<span data-title>${esc(r.name)}</span></div>
      <div class="vals"><span class="t big">${fmt(t)}<span class="unit">°C</span></span>
        ${Number.isFinite(hum) ? `<span class="h">${icon("water-outline")}${fmt(hum, 0)} %</span>` : ""}</div>
      ${r.temp ? spark(r.temp, "var(--tc, var(--muted))", "room-" + i, 1) : ""}</section>`;
  }

  function viewAccueil() {
    const L = pageOn("lumieres") ? lights() : [];
    const R = rooms();
    const covers = pageOn("lumieres") ? C.covers : [];
    const on = L.filter((l) => val(l.entity) === "on").length;
    const heating = R.filter((r) => roomHeat(r) === "heating").length;
    const summary = summaryCard();
    return [
      hero().replace('class="card hero s-8"', `class="card hero ${summary ? "s-8" : ""}"`),
      summary,
      R.length ? group("g-rooms", "", section("h-rooms", "Pièces", C.climates.length ? (heating ? `${heating} pièce${heating > 1 ? "s" : ""} en chauffe` : "Chauffage au repos") : "")
        + `<div class="hscroll rooms" ${cols(R.length)}>${R.map((r) => roomCard(r, C.rooms.indexOf(r))).join("")}</div>`) : "",
      L.length ? group("g-lights", "", section("h-lights", "Lumières", on ? `${on} allumée${on > 1 ? "s" : ""}` : "Tout est éteint", "lumieres")
        + `<div class="tiles" ${cols(L.length)}>${L.map(lightTile).join("")}</div>`) : "",
      // Volets sur une demi-largeur, à côté de la carte « En cours ».
      covers.length ? group("g-covers", "s-6", section("h-covers", "Volets", "", "lumieres")
        + `<div class="tiles" style="--cols-t:2;--cols-d:2">${covers.map(coverTile).join("")}</div>`) : "",
      nowPlaying() || "",
    ].join("");
  }

  // ---------- Lumières ----------
  function viewLumieres() {
    const L = lights();
    return [
      L.length ? group("l-lights", "", section("h-l", "Lumières", "Appui long pour régler") + `<div class="tiles" ${cols(L.length)}>${L.map(lightTile).join("")}</div>`) : "",
      C.covers.length ? group("l-covers", "", section("h-c", "Volets") + `<div class="tiles" ${cols(C.covers.length)}>${C.covers.map(coverTile).join("")}</div>`) : "",
      C.media.length ? card("media", "", head("Multimédia") + `<div class="rows">${C.media.map(mediaRow).join("")}</div>`) : "",
    ].join("");
  }

  // ---------- Chauffage ----------
  function climateCard(c, { inRoom = false } = {}) {
    const s = st(c.entity);
    if (!s) return `<section class="card climate" data-k="cl-${esc(c.entity)}"><div class="muted">${esc(c.name)} : entité introuvable</div></section>`;
    const a = s.attributes;
    const off = s.state === "off", unav = s.state === "unavailable";
    const cur = c.temp ? num(c.temp) : a.current_temperature;
    const target = pendingTarget[c.entity] ?? a.temperature;
    // « Chauffe » seulement en mode Confort ; sinon l'étiquette indique le mode (Éco, Hors-gel…) ou « En veille ».
    const heating = isHeating(s);
    const mode = a.preset_mode;
    const tag = unav ? "Indisponible" : off ? "Arrêt" : heating ? "Chauffe"
      : mode && mode !== "none" && !COMFORT_PRESETS.includes(mode) ? PRESET_LABEL[mode] || mode : "En veille";
    const tone = unav ? "bad" : off ? "" : heating ? "heat" : mode === "eco" ? "ok" : mode === "frost_protection" ? "cool" : /^(auto|prog)$/.test(mode || "") ? "violet" : "";
    const canTarget = (a.supported_features & 1) === 1;
    const presets = C.climatePresets.filter((p) => (a.preset_modes || []).includes(p.id));
    const dis = off || unav ? "disabled" : "";
    return `<section class="card climate ${heating ? "is-on" : ""}" data-k="cl-${esc(c.entity)}">
      <div class="head"><span class="chip-icon heat">${ticon("radiator")}</span>
        ${(() => {
          const r = !inRoom && roomOfClimate(c.entity);
          // Sur la page d'une pièce, « Salon gauche » devient « Gauche » : la pièce est déjà dans le titre.
          const room = roomOfClimate(c.entity);
          let name = c.name;
          if (inRoom && room && slug(name).startsWith(slug(room.name) + "-")) {
            name = name.slice(room.name.length).trim();
            name = name.charAt(0).toUpperCase() + name.slice(1);
          }
          const sub = inRoom ? "Radiateur" : (r ? r.name : c.room) + (r ? " ›" : "");
          const txt = `<div data-title>${esc(name)}</div><div class="muted" style="font-size:13px">${esc(sub)}</div>`;
          return r ? `<button class="txt link" ${roomLink(r)}>${txt}</button>` : `<div class="txt">${txt}</div>`;
        })()}
        <span class="action-tag ${tone}">${esc(tag)}</span>
        <button class="switch" role="switch" aria-checked="${!off && !unav}" aria-label="Allumer ou éteindre ${esc(c.name)}" data-act="hvac" data-eid="${esc(c.entity)}" ${unav ? "disabled" : ""}></button></div>
      <div class="readout">
        <div><div class="muted" style="font-size:12px;margin-bottom:6px">Actuelle</div><div class="cur big">${fmt(cur)}<span class="unit">°C</span></div></div>
        ${canTarget ? `<div class="target">
          <button class="press" data-act="temp" data-eid="${esc(c.entity)}" data-d="-1" aria-label="Baisser la consigne" ${dis}>${icon("minus")}</button>
          <div class="v"><small>Consigne</small>${target != null ? fmt(target) + "°" : "—"}</div>
          <button class="press" data-act="temp" data-eid="${esc(c.entity)}" data-d="1" aria-label="Monter la consigne" ${dis}>${icon("plus")}</button>
        </div>` : ""}
      </div>
      ${presets.length ? `<div class="seg">${presets.map((p) => `<button aria-pressed="${a.preset_mode === p.id}" data-act="preset" data-eid="${esc(c.entity)}" data-p="${p.id}" ${dis}>${icon(p.icon)}<span>${esc(p.label)}</span></button>`).join("")}</div>` : ""}
    </section>`;
  }

  const PALETTE = ["#f4b860", "#7fb2ff", "#69d6a0", "#b59cff", "#ff8a5c", "#5fd0d6"];
  // Les graphiques sont dessinés à la taille réelle de leur cadre (mesurée à l'affichage),
  // pour que le texte des axes ne soit jamais étiré.
  const chartSize = {};
  const dims = (key, h) => chartSize[key] || { w: Math.round(clamp(window.innerWidth - (isDesktop() ? 160 : 64), 280, 1600)), h };
  const chartObserver = new ResizeObserver((entries) => {
    let changed = false;
    entries.forEach((e) => {
      const k = e.target.dataset.chart;
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      const cur = chartSize[k];
      if (w > 0 && h > 0 && (!cur || Math.abs(cur.w - w) > 1 || Math.abs(cur.h - h) > 1)) { chartSize[k] = { w, h }; changed = true; }
    });
    if (changed) scheduleRender();
  });
  function observeCharts() {
    chartObserver.disconnect();
    document.querySelectorAll("svg.chart[data-chart]").forEach((el) => chartObserver.observe(el));
  }
  function niceScale(min, max, ticks = 4) {
    if (!(max > min)) { min -= 1; max += 1; }
    const raw = (max - min) / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw * 0.999) || 10 * mag;
    return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
  }

  // Courbes sur 24 h (une ou plusieurs séries), dessinées à la taille réelle du cadre.
  function lineChart(key, series, { unit = "", height = 240, legend = true, label = "Courbe sur 24 heures" } = {}) {
    const { w: W, h: H } = dims(key, height), L = 40, B = 24, T = 10, R = 10;
    const now = Date.now() / 1000, t0 = now - 86400;
    series = series.map((x) => ({ ...x, pts: (x.pts || []).filter((p) => p[0] >= t0 && Number.isFinite(p[1])) })).filter((x) => x.pts.length > 1);
    if (!series.length) return `<div class="empty">Pas encore d'historique.</div>`;
    const vals = series.flatMap((x) => x.pts.map((p) => p[1]));
    const sc = niceScale(Math.min(...vals), Math.max(...vals));
    const dec = Math.max(0, -Math.floor(Math.log10(sc.step) + 1e-9));
    const x = (t) => L + ((t - t0) / 86400) * (W - L - R);
    const y = (v) => T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - T - B);
    let g = "";
    for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
      g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v, dec)}${unit}</text>`;
    }
    for (let hb = 24; hb >= 0; hb -= W < 500 ? 8 : 6) {
      const t = now - hb * 3600;
      const lbl = hb === 0 ? "maint." : new Date(t * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      g += `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${hb === 0 ? "end" : "middle"}">${lbl}</text>`;
    }
    // Courbe en escalier : la valeur reste la même jusqu'au changement suivant.
    const path = (pts) => pts.map((p, i) => (i ? `H${x(p[0]).toFixed(1)}V${y(p[1]).toFixed(1)}` : `M${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)).join("") + `H${x(now).toFixed(1)}`;
    const lines = series.map((sr) => `<path d="${path(sr.pts)}" fill="none" style="stroke:${sr.color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`).join("");
    return `<svg class="chart" data-chart="${key}" style="height:${height}px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${g}${lines}</svg>
      ${legend ? `<div class="legend">${series.map((sr) => `<span><i style="background:${sr.color}"></i>${esc(sr.name)} ${fmt(sr.pts[sr.pts.length - 1][1])}${unit}</span>`).join("")}</div>` : ""}`;
  }

  const tempChart = () => lineChart("temp", rooms().filter((r) => r.temp).map((r, i) => ({ name: r.name, color: PALETTE[i % PALETTE.length], pts: hist[r.temp] })), { unit: "°", height: isDesktop() ? 240 : 200, label: "Températures des pièces sur 24 heures" });

  function viewChauffage() {
    const plans = C.schedules.map((id) => `<div class="row link ${val(id) === "on" ? "is-on" : ""}" role="button" tabindex="0" ${info(id)}><span class="chip-icon heat">${icon("calendar-clock")}</span>
      <div class="txt"><div class="title">${esc(fname(id))}</div><div class="sub">${val(id) === "on" ? "Créneau actif" : "Hors créneau"}</div></div>${chev()}</div>`).join("");
    const autos = C.heatingAutomations.map((id) => `<div class="row"><div class="txt"><div class="title">${esc(fname(id))}</div><div class="sub">${val(id) === "on" ? "Activée" : "Désactivée"}</div></div>${sw(id, val(id) === "on", "", fname(id))}</div>`).join("");
    return [
      group("c-climates", "", `<div class="climates">${C.climates.map((c) => climateCard(c)).join("")}</div>`),
      rooms().some((r) => r.temp) ? card("chart", plans || autos ? "s-8" : "", head("Températures — 24 h", `<span class="hint">touche une pièce sur l'accueil pour le détail</span>`) + tempChart()) : "",
      plans || autos ? card("plans", "s-4", (plans ? head("Plannings") + `<div class="rows">${plans}</div>` : "") + (autos ? `<div class="card-head" style="${plans ? "margin-top:16px" : ""}"><h2>Automatisations</h2></div><div class="rows">${autos}</div>` : "")) : "",
    ].join("");
  }

  // ---------- Ménage ----------
  function viewMenage() {
    const v = C.vacuum;
    if (!v) return card("vac-none", "", `<div class="empty">Aucun aspirateur trouvé dans Home Assistant.</div>`);
    const s = st(v.entity);
    const a = s?.attributes || {};
    const bat = num(v.battery);
    const state = s?.state || "unavailable";
    const fans = (a.fan_speed_list || []).map((f) => `<button class="chip press" aria-pressed="${a.fan_speed === f}" data-act="svc" data-svc="vacuum.set_fan_speed" data-eid="${v.entity}" data-data='${esc(JSON.stringify({ fan_speed: f }))}'>${esc(f)}</button>`).join("");
    const main = card("vac", "s-7", `
      <div class="vac-hero"><button class="ring-link" ${info(v.battery, "Batterie de l'aspirateur")} aria-label="Historique de la batterie">${ring(bat, bat < 20 ? "var(--danger)" : "var(--ok)", Number.isFinite(bat) ? Math.round(bat) + "%" : "—", "batterie")}</button>
        <div style="flex:1;min-width:0"><div class="vac-state">${esc(VAC_STATE[state] || state)}</div>
          <div class="muted" style="font-size:13px;margin-top:2px">${esc(fname(v.entity))}${s ? " · " + esc(ago(s.last_changed)) : ""}</div></div></div>
      <div class="btn-row" style="margin-top:16px">
        ${state === "cleaning"
          ? `<button class="btn primary" data-act="svc" data-svc="vacuum.pause" data-eid="${v.entity}">${icon("pause")}Pause</button>`
          : `<button class="btn primary" data-act="svc" data-svc="vacuum.start" data-eid="${v.entity}" data-label="Aspirateur lancé">${icon("play")}Démarrer</button>`}
        <button class="btn" data-act="svc" data-svc="vacuum.return_to_base" data-eid="${v.entity}" aria-label="Retour à la base">${icon("home-import-outline")}</button>
        <button class="btn" data-act="svc" data-svc="vacuum.locate" data-eid="${v.entity}" aria-label="Localiser">${icon("map-marker-radius-outline")}</button>
      </div>
      ${fans ? `<div class="label">Puissance</div><div class="chips">${fans}</div>` : ""}`);
    const rooms = v.rooms.map((r) => `<button class="chip press" data-act="svc" data-svc="script.turn_on" data-eid="${r.script}" data-label="Nettoyage ${esc(r.label)}">${icon(r.icon)}${esc(r.label)}</button>`).join("");
    const selects = v.selects.map((se) => {
      const opts = attr(se.entity, "options") || [];
      return `<div class="label">${esc(se.label)}</div><div class="chips">${opts.map((o) => `<button class="chip press" aria-pressed="${val(se.entity) === o}" data-act="svc" data-svc="select.select_option" data-eid="${se.entity}" data-data='${esc(JSON.stringify({ option: o }))}'>${esc(o)}</button>`).join("")}</div>`;
    }).join("");
    const sws = v.switches.map((x) => `<div class="row"><div class="txt"><div class="title">${esc(x.label)}</div></div>${sw(x.entity, val(x.entity) === "on", "", x.label)}</div>`).join("");
    const opts = rooms || selects || sws ? card("vac-opts", "s-5", (rooms ? head("Nettoyer une pièce") + `<div class="chips">${rooms}</div>` : head("Options")) + `${selects}<div class="rows" style="margin-top:10px">${sws}</div>`) : "";
    const mapUrl = v.map ? attr(v.map, "entity_picture") : null;
    const mapOn = val(v.map) !== "off";
    const map = `<section class="card" data-k="vac-map" data-lock="1">${head("Carte")}${mapUrl && conn.baseUrl && mapOn
      ? `<img class="map-img" data-refresh="${esc(v.map)}" src="${esc(conn.imageUrl(mapUrl))}" alt="Carte de l'aspirateur">`
      : `<div class="placeholder">${conn.baseUrl ? "Carte indisponible pour le moment." : "La carte s'affiche une fois connecté à Home Assistant."}</div>`}</section>`;
    return main.replace('class="card s-7"', `class="card ${opts ? "s-7" : ""}"`) + opts + (v.map ? map : "");
  }

  // ---------- Sécurité ----------
  function viewSecurite() {
    const S = C.security;
    const camPic = S.camera ? attr(S.camera, "entity_picture") : null;
    const cam = `<section class="card s-8" data-k="cam" data-lock="1">${head("Caméra salon")}<div class="cam">${camPic && conn.baseUrl
      ? `<img data-refresh="${esc(S.camera)}" src="${esc(conn.imageUrl(camPic))}" alt="Image de la caméra du salon"><span class="live">Direct</span>`
      : `<div class="placeholder">Le flux caméra s'affiche une fois connecté à Home Assistant.</div>`}</div></section>`;
    const sensorRow = (o, onTxt, offTxt) => {
      const on = val(o.entity) === "on";
      return `<div class="row link ${on ? "is-alert" : ""}" role="button" tabindex="0" ${info(o.entity, o.name)}><span class="chip-icon">${icon(on && o.icon === "door" ? "door-open" : o.icon)}</span>
        <div class="txt"><div class="title">${esc(o.name)}</div><div class="sub">${esc(ago(st(o.entity)?.last_changed))}</div></div>
        <span class="val ${on ? "status-bad" : "status-ok"}">${isUnav(o.entity) ? "—" : on ? onTxt : offTxt}</span>${chev()}</div>`;
    };
    const hasAccess = S.openings.length || S.motion.length || S.illuminance;
    const access = hasAccess ? card("access", "", head("Accès & mouvements") + `<div class="rows">
      ${S.openings.map((o) => sensorRow(o, "Ouverte", "Fermée")).join("")}
      ${S.motion.map((o) => sensorRow(o, "Détecté", "Calme")).join("")}
      ${S.illuminance ? `<div class="row link" role="button" tabindex="0" ${info(S.illuminance, S.illuminanceName || "Luminosité")}><span class="chip-icon">${icon("brightness-5")}</span><div class="txt"><div class="title">${esc(S.illuminanceName || "Luminosité")}</div></div><span class="val">${fmt(num(S.illuminance), 0)} lx</span>${chev()}</div>` : ""}</div>`) : "";
    const people = card("people", "", head("Présence", `<button class="hint link" data-act="sheet" data-sheet="map">Carte ›</button>`) + `<div class="rows">${C.persons.map((p) => {
      const s = val(p.entity);
      return `<div class="row link ${s === "home" ? "is-on" : ""}" role="button" tabindex="0" ${info(p.entity, p.name)}><span class="chip-icon ok">${icon(s === "home" ? "home-account" : "account-arrow-right-outline")}</span>
        <div class="txt"><div class="title">${esc(p.name)}</div><div class="sub">depuis ${esc(ago(st(p.entity)?.last_changed).replace("il y a ", ""))}</div></div><span class="val">${esc(PERSON(s))}</span>${chev()}</div>`;
    }).join("")}</div>`);
    const peopleCard = C.persons.length ? people : "";
    if (!S.camera) return `<div class="stack s-6">${access || peopleCard}</div>` + (access && peopleCard ? `<div class="stack s-6">${peopleCard}</div>` : "");
    return cam + `<div class="stack s-4">${access}${peopleCard}</div>`;
  }

  // ---------- Système ----------
  const speed = (id) => {
    const v = num(id);
    if (!Number.isFinite(v)) return "—";
    return v >= 1000 ? `${fmt(v / 1000)}<span class="unit">Mo/s</span>` : `${fmt(v, 0)}<span class="unit">ko/s</span>`;
  };
  const pendingUpdates = () => Object.values(conn.states).filter((s) => s.entity_id.startsWith("update.") && s.state === "on");

  function viewSysteme() {
    const S = C.system, n = S.nas || {};
    const vol = num(n.volume), cpu = num(n.cpu), mem = num(n.memory);
    const drives = (n.drives || []).map((d, i) => `<div class="row"><span class="chip-icon">${icon("harddisk")}</span><div class="txt"><div class="title">Disque ${i + 1}</div></div>
      <span class="val ${val(d) === "normal" ? "status-ok" : "status-bad"}">${esc(val(d) === "normal" ? "Sain" : val(d) || "—")}</span></div>`).join("");
    const ringBtn = (eid, label, p, sub) => `<button class="ring-link" ${info(eid, label)} aria-label="Historique : ${esc(label)}">${ring(p, sev(p), fmt(p, 0) + "%", sub, "sm")}</button>`;
    const nas = card("nas", "s-6", head("NAS", `<button class="hint link" ${info(n.temp, "Température du NAS")}>${fmt(num(n.temp), 0)} °C ›</button>`) + `<div class="rings">
      ${ringBtn(n.volume, "Stockage du NAS", vol, "stockage")}${ringBtn(n.cpu, "Processeur du NAS", cpu, "processeur")}${ringBtn(n.memory, "Mémoire du NAS", mem, "mémoire")}</div>
      <div class="rows" style="margin-top:10px">${drives}</div>`);
    const fb = !S.freebox ? "" : card("freebox", "s-3", head("Internet") + `
      <div class="stat link" ${info(S.freebox.down, "Débit en réception")}><span class="k">${icon("download")} Réception ›</span><span class="v big">${speed(S.freebox.down)}</span></div>
      <div style="margin:0 -16px">${spark(S.freebox.down, "var(--cool)", "fbd", 10)}</div>
      <div class="stat link" style="margin-top:8px" ${info(S.freebox.up, "Débit en envoi")}><span class="k">${icon("upload")} Envoi ›</span><span class="v big">${speed(S.freebox.up)}</span></div>
      <div style="margin:0 -16px">${spark(S.freebox.up, "var(--violet)", "fbu", 10)}</div>
      <div class="muted" style="font-size:13px;margin-top:6px">${icon("phone-missed")} ${fmt(num(S.freebox.calls), 0)} appels manqués</div>`);
    const p = S.waterHeater ? num(S.waterHeater.power) : NaN;
    const wh = !S.waterHeater ? "" : card("water", "s-3", head("Chauffe-eau") + `
      <div class="stat link" ${info(S.waterHeater.power, "Puissance du chauffe-eau")}><span class="k">Puissance ›</span><span class="v big">${fmt(p, 0)}<span class="unit">W</span></span></div>
      <div class="muted" style="font-size:13px">${p > 5 ? "En chauffe" : "Au repos"}</div>
      <div style="margin:6px -16px 0">${spark(S.waterHeater.power, "var(--heat)", "wh", 50)}</div>
      <div class="stat" style="margin-top:8px"><span class="k">Compteur total</span><span class="v big" style="font-size:22px">${fmt(num(S.waterHeater.energy), 0)}<span class="unit">kWh</span></span></div>`);
    const updates = pendingUpdates();
    const up = card("updates", "s-6", head("Mises à jour", `<span class="hint">${updates.length || "aucune"}</span>`) + (updates.length
      ? `<div class="rows">${updates.map((u) => `<div class="row"><span class="chip-icon">${icon("package-up")}</span><div class="txt"><div class="title">${esc((u.attributes.friendly_name || u.entity_id).replace(/ Mise à jour$/, ""))}</div>
          <div class="sub">${esc(u.attributes.installed_version || "")} → ${esc(u.attributes.latest_version || "")}</div></div></div>`).join("")}</div>`
      : `<div class="empty">Tout est à jour.</div>`));
    const autos = Object.values(conn.states).filter((s) => s.entity_id.startsWith("automation.")).sort((a, b) => fname(a.entity_id).localeCompare(fname(b.entity_id), "fr"));
    const au = card("all-autos", "s-6", head("Automatisations", `<span class="hint">${autos.filter((a) => a.state === "on").length}/${autos.length} actives</span>`) +
      `<div class="rows">${autos.map((a) => `<div class="row"><div class="txt"><div class="title">${esc(fname(a.entity_id))}</div><div class="sub">${esc(a.attributes.last_triggered ? "Déclenchée " + ago(a.attributes.last_triggered) : "Jamais déclenchée")}</div></div>${sw(a.entity_id, a.state === "on", "", fname(a.entity_id))}</div>`).join("")}</div>`);
    return (S.nas ? nas : "") + (S.freebox ? fb : "") + (S.waterHeater ? wh : "") + up + au;
  }

  // ---------- Consommation ----------
  const energy = { range: "day", prefs: null, data: null, loading: false, tried: 0, error: null };
  const RANGES = [["day", "Aujourd'hui"], ["week", "7 jours"], ["month", "30 jours"], ["year", "12 mois"]];

  // Sources réseau (heures creuses / pleines) et appareils suivis, lus dans le tableau Énergie de HA.
  function normalizePrefs(p) {
    const fb = C.energy.fallback;
    if (!p) return { sources: fb.sources, devices: fb.devices };
    const sources = [];
    (p.energy_sources || []).filter((x) => x.type === "grid").forEach((g) => {
      (g.flow_from || [g]).forEach((f) => {
        if (f.stat_energy_from) sources.push({ stat: f.stat_energy_from, price: f.number_energy_price ?? null, priceEntity: f.entity_energy_price || null });
      });
    });
    const devices = (p.device_consumption || []).map((d) => ({ stat: d.stat_consumption, name: d.name || null }));
    return { sources: sources.length ? sources : fb.sources, devices: devices.length ? devices : fb.devices };
  }
  const sourceName = (x) => (/hchc/i.test(x.stat) ? "Heures creuses" : /hchp/i.test(x.stat) ? "Heures pleines" : fname(x.stat));
  const sourceColor = (x, i) => (/hchc/i.test(x.stat) ? "var(--cool)" : /hchp/i.test(x.stat) ? "var(--warm)" : ["var(--violet)", "var(--ok)", "var(--heat)"][i % 3]);
  const sourcePrice = (x) => (x.price != null ? x.price : x.priceEntity ? num(x.priceEntity) : null);
  const deviceIcon = (n) => (/radiat/i.test(n) ? "radiator" : /chauffe|ballon|eau/i.test(n) ? "water-boiler" : "power-plug-outline");
  const sum = (a) => a.reduce((t, v) => t + v, 0);
  const euro = (v) => v.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const kwh = (v) => `${fmt(v, v >= 100 ? 0 : 1)}<span class="unit">kWh</span>`;

  function rangeSpec(range) {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    if (range === "day") return { period: "hour", n: 24, start: new Date(y, m, d), at: (i) => new Date(y, m, d, i), label: (t, i) => (i % 6 === 0 ? `${i} h` : "") };
    if (range === "week") return { period: "day", n: 7, start: new Date(y, m, d - 6), at: (i) => new Date(y, m, d - 6 + i), label: (t) => t.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "") };
    if (range === "month") return { period: "day", n: 30, start: new Date(y, m, d - 29), at: (i) => new Date(y, m, d - 29 + i), label: (t, i) => ((29 - i) % 7 === 0 ? String(t.getDate()) : "") };
    return { period: "month", n: 12, start: new Date(y, m - 11, 1), at: (i) => new Date(y, m - 11 + i, 1), label: (t) => t.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "") };
  }
  const bucketKey = (t, period) => {
    const d = new Date(t);
    return period === "hour" ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}` : period === "day" ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : `${d.getFullYear()}-${d.getMonth()}`;
  };

  async function loadEnergy(force) {
    if (!conn || energy.loading) return;
    const fresh = energy.data && energy.data.range === energy.range && Date.now() - energy.tried < 120e3;
    if (!force && (fresh || (energy.error && Date.now() - energy.tried < 30e3))) return;
    energy.loading = true;
    energy.tried = Date.now();
    try {
      if (!energy.prefs) {
        try { energy.prefs = normalizePrefs(await conn.energyPrefs()); } catch { energy.prefs = normalizePrefs(null); }
      }
      const range = energy.range, spec = rangeSpec(range);
      const all = [...new Set([...energy.prefs.sources, ...energy.prefs.devices].map((x) => x.stat))];
      const res = await conn.statistics(all, spec.start, spec.period);
      const buckets = Array.from({ length: spec.n }, (_, i) => spec.at(i));
      const byStat = {};
      all.forEach((id) => {
        const map = {};
        (res?.[id] || []).forEach((p) => {
          const k = bucketKey(typeof p.start === "number" ? p.start : Date.parse(p.start), spec.period);
          map[k] = (map[k] || 0) + Math.max(0, Number(p.change) || 0);
        });
        byStat[id] = buckets.map((b) => map[bucketKey(b, spec.period)] || 0);
      });
      if (range === energy.range) energy.data = { range, spec, buckets, byStat };
      energy.error = null;
    } catch (e) {
      energy.error = e.message;
    }
    energy.loading = false;
    scheduleRender();
  }

  function energyChart(D, sources) {
    const { w: W, h: H } = dims("energy", 220), L = 38, B = 24, T = 10, R = 6;
    const n = D.buckets.length;
    const stacks = D.buckets.map((_, i) => sources.map((x) => D.byStat[x.stat]?.[i] || 0));
    const top = Math.max(0.1, ...stacks.map(sum));
    const stepV = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((v) => top / v <= 4) || 1000;
    const max = Math.ceil(top / stepV) * stepV;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const slot = (W - L - R) / n, bw = Math.max(3, slot * 0.64);
    let g = "";
    for (let v = 0; v <= max + 1e-9; v += stepV) {
      g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v, stepV < 1 ? 1 : 0)}</text>`;
    }
    let bars = "";
    stacks.forEach((vals, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      let acc = 0;
      const tip = `${D.spec.label(D.buckets[i], i) || D.buckets[i].toLocaleDateString("fr-FR")} : ${fmt(sum(vals))} kWh`;
      vals.forEach((v, k) => {
        if (v <= 0) return;
        const y0 = y(acc), y1 = y(acc + v);
        bars += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y0 - y1).toFixed(1)}" rx="2" style="fill:${sourceColor(sources[k], k)}"><title>${esc(tip)}</title></rect>`;
        acc += v;
      });
      const lbl = D.spec.label(D.buckets[i], i);
      if (lbl) g += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(lbl)}</text>`;
    });
    return `<svg class="chart" data-chart="energy" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Consommation électrique par ${D.spec.period === "hour" ? "heure" : D.spec.period === "day" ? "jour" : "mois"}">${g}${bars}</svg>
      <div class="legend">${sources.map((x, k) => `<span><i style="background:${sourceColor(x, k)}"></i>${esc(sourceName(x))}</span>`).join("")}<span class="faint">en kWh</span></div>`;
  }

  function viewConso() {
    loadEnergy();
    const E = C.energy;
    const va = num(E.power), amps = num(E.current), sub = num(E.subscription) || 45;
    const maxVA = sub * 200;
    const pct = Number.isFinite(va) ? (va / maxVA) * 100 : 0;
    const ptec = String(val(E.period) || "");
    const tier = /^HP/i.test(ptec) ? ["hp", "Heures pleines"] : /^HC/i.test(ptec) ? ["hc", "Heures creuses"] : null;
    const liveUnit = attr(E.power, "unit_of_measurement") || "W";
    const live = !E.power ? "" : !E.subscription ? card("e-live", "s-5", head("En ce moment", tier ? `<span class="action-tag ${tier[0]}">${tier[1]}</span>` : "") + `
      <div class="stat link" ${info(E.power, "Puissance appelée")}><span class="k">Puissance appelée ›</span><span class="v big">${fmt(va, 0)}<span class="unit">${esc(liveUnit)}</span></span></div>
      <div style="margin:10px -16px -16px">${spark(E.power, "var(--warm)", "papp", 300)}</div>`) : card("e-live", "s-5", head("En ce moment", tier ? `<span class="action-tag ${tier[0]}">${tier[1]}</span>` : "") + `
      <div class="vac-hero">${ring(pct, sev(pct), Number.isFinite(va) ? fmt(va / 1000, 2) : "—", "kVA")}
        <div style="flex:1;min-width:0"><div class="stat link" ${info(E.power, "Puissance appelée")}><span class="k">Puissance appelée ›</span><span class="v big">${fmt(va, 0)}<span class="unit">VA</span></span></div>
          <div class="muted" style="font-size:13px;margin-top:4px">${Number.isFinite(amps) ? fmt(amps, 0) + " A sur " : ""}${fmt(sub, 0)} A souscrits (${fmt(maxVA / 1000, 0)} kVA)</div></div></div>
      <div style="margin:10px -16px -16px">${spark(E.power, "var(--warm)", "papp", 300)}</div>`);

    const seg = `<div class="seg">${RANGES.map(([k, l]) => `<button aria-pressed="${energy.range === k}" data-act="erange" data-r="${k}">${l}</button>`).join("")}</div>`;
    const D = energy.data && energy.data.range === energy.range ? energy.data : null;
    if (!D) {
      const msg = energy.error ? `Données indisponibles : ${esc(energy.error)}` : "Chargement…";
      return live + card("e-sum", "s-7", head("Consommation") + seg + `<div class="empty" style="margin-top:16px">${msg}</div>`);
    }
    const { sources, devices } = energy.prefs;
    const totals = sources.map((x) => sum(D.byStat[x.stat] || []));
    const total = sum(totals);
    const priced = sources.some((x) => sourcePrice(x) != null);
    const cost = sum(sources.map((x, i) => (sourcePrice(x) || 0) * totals[i]));
    const avgPrice = total > 0 ? cost / total : 0;
    const until = energy.range === "day" ? `jusqu'à ${new Date().getHours()} h` : "";
    const summary = card("e-sum", "s-7", head("Consommation", until ? `<span class="hint">${until}</span>` : "") + seg + `
      <div class="energy-total"><span class="v big">${kwh(total)}</span>${priced ? `<span class="cost">≈ ${euro(cost)}</span>` : ""}</div>
      ${total > 0 ? `<div class="split">${sources.map((x, i) => `<i style="width:${((totals[i] / total) * 100).toFixed(1)}%;background:${sourceColor(x, i)}"></i>`).join("")}</div>` : ""}
      <div class="rows">${sources.map((x, i) => `<div class="row"><span class="dot-k" style="background:${sourceColor(x, i)}"></span>
        <div class="txt"><div class="title">${esc(sourceName(x))}</div><div class="sub">${sourcePrice(x) != null ? fmt(sourcePrice(x), 4).replace(/0+$/, "") + " €/kWh" : "Prix non renseigné"}</div></div>
        <span class="val" style="text-align:right">${fmt(totals[i], 1)} kWh${sourcePrice(x) != null ? `<div class="sub">${euro(totals[i] * sourcePrice(x))}</div>` : ""}</span></div>`).join("")}</div>`);

    const chart = card("e-chart", "", head(energy.range === "day" ? "Par heure" : energy.range === "year" ? "Par mois" : "Par jour") + energyChart(D, sources));

    const devs = devices.map((d) => ({ ...d, name: d.name || fname(d.stat), v: sum(D.byStat[d.stat] || []) })).sort((a, b) => b.v - a.v);
    const other = Math.max(0, total - sum(devs.map((d) => d.v)));
    const ref = Math.max(total, ...devs.map((d) => d.v), 0.001);
    const devLink = (name) => (/radiat/i.test(name) && pageOn("chauffage") ? 'data-act="nav" data-view="chauffage"' : /chauffe|ballon|eau/i.test(name) && C.system.waterHeater?.power ? info(C.system.waterHeater.power, "Puissance du chauffe-eau") : "");
    const devRow = (ic, name, v, color) => `<div class="row ${devLink(name) ? "link" : ""}" ${devLink(name) ? `role="button" tabindex="0" ${devLink(name)}` : ""}><span class="chip-icon">${icon(ic)}</span>
      <div class="txt"><div class="title">${esc(name)}</div><div class="ebar"><i style="width:${((v / ref) * 100).toFixed(1)}%;background:${color}"></i></div></div>
      <span class="val" style="text-align:right">${fmt(v, 1)} kWh<div class="sub">${total > 0 ? fmt((v / total) * 100, 0) + " %" : ""}${priced ? " · " + euro(v * avgPrice) : ""}</div></span></div>`;
    const devCard = card("e-devices", "", head("Par appareil") + `<div class="rows">
      ${devs.map((d) => devRow(deviceIcon(d.name), d.name, d.v, "var(--heat)")).join("")}
      ${total > 0 ? devRow("home-lightning-bolt-outline", "Reste de la maison", other, "var(--violet)") : ""}</div>
      ${priced ? `<div class="faint" style="font-size:12.5px;margin-top:8px">Coût par appareil estimé au prix moyen de la période.</div>` : ""}`);
    return live + summary + chart + devCard;
  }

  // ---------- Détail d'une pièce ----------
  let viewParam = "";
  let pieceBack = "accueil";
  const currentRoom = () => C.rooms.find((r) => slug(r.name) === viewParam);

  // Pastilles de la carte Ambiance : état du chauffage, puis alerte d'humidité si besoin.
  const PRESET_LABEL = { eco: "Éco", comfort: "Confort", "comfort-1": "Confort -1°", "comfort-2": "Confort -2°", frost_protection: "Hors-gel", auto: "Programme", prog: "Programme", boost: "Boost" };
  function heatChip(r, heat) {
    if (!heat) return `<span class="mini-chip">${icon("radiator-off")}Pas de radiateur</span>`;
    if (heat === "unav") return `<span class="mini-chip bad">${icon("fire-alert")}Radiateur indisponible</span>`;
    if (heat === "off") return `<span class="mini-chip cool">${icon("fire-off")}Chauffage éteint</span>`;
    const on = (r.climates || []).map(st).find((x) => x && x.state !== "off" && x.state !== "unavailable");
    const mode = on?.attributes?.preset_mode;
    const preset = PRESET_LABEL[mode] || "";
    if (heat === "heating") return `<span class="mini-chip heat">${icon("fire")}Chauffage en marche${preset ? " · " + preset : ""}</span>`;
    // Allumé sans chauffer en Confort : la couleur suit le mode (Éco vert, Confort ambre, Hors-gel bleu, Programme violet).
    const tone = mode === "eco" ? "ok" : /^comfort/.test(mode || "") ? "warm" : mode === "frost_protection" ? "cool" : mode === "boost" ? "heat" : "violet";
    return `<span class="mini-chip ${tone}">${icon("fire")}Chauffage allumé${preset ? " · " + preset : ""}</span>`;
  }
  function roomChips(r, t, hum, heat) {
    const out = [heatChip(r, heat)];
    if (Number.isFinite(hum)) {
      if (hum > 65) out.push(`<span class="mini-chip cool">${icon("water-alert-outline")}Air humide</span>`);
      else if (hum < 40) out.push(`<span class="mini-chip heat">${icon("water-off-outline")}Air sec</span>`);
    }
    return out.join("");
  }
  function statsRow(label, vals, unit, d) {
    if (!vals.length) return "";
    const cell = (k, v) => `<div><span>${k}</span><b>${fmt(v, d)}${unit}</b></div>`;
    return `<div class="label">${label} sur 24 h</div><div class="duo-stats">${cell("Min", Math.min(...vals))}${cell("Moyenne", sum(vals) / vals.length)}${cell("Max", Math.max(...vals))}</div>`;
  }

  function viewPiece() {
    const r = currentRoom();
    if (!r) return card("p-none", "", `<div class="empty">Pièce introuvable.</div>`);
    const i = C.rooms.indexOf(r);
    const t = r.temp ? num(r.temp) : NaN, hum = r.hum ? num(r.hum) : NaN;
    const heat = roomHeat(r);
    const day = (id) => (hist[id] || []).filter((p) => p[0] >= Date.now() / 1000 - 86400).map((p) => p[1]);
    const temps = r.temp ? day(r.temp) : [], hums = r.hum ? day(r.hum) : [];
    const climates = (r.climates || []).map((id) => C.climates.find((c) => c.entity === id) || { entity: id, name: fname(id), room: r.name, temp: r.temp });
    const lights = C.lights.filter((l) => (editMode || !cardOpt("lt-" + l.entity).hidden) && sameRoom(l.room, r.name));
    const covers = C.covers.filter((c) => sameRoom(c.room || c.name, r.name));
    const sensors = [...C.security.openings, ...C.security.motion].filter((o) => sameRoom(o.room, r.name));
    const ambiance = card("p-amb", "room-hero", `
      <div class="room-hero-grid">
        <div>
          ${head("Ambiance")}
          <div class="room-now">
            ${r.temp ? `<button class="stat link" ${info(r.temp, "Température " + r.name)}><span class="k">Température ›</span><span class="v big">${fmt(t)}<span class="unit">°C</span></span></button>` : ""}
            ${Number.isFinite(hum) ? `<button class="stat link" ${info(r.hum, "Humidité " + r.name)}><span class="k">Humidité ›</span><span class="v big">${fmt(hum, 0)}<span class="unit">%</span></span></button>` : ""}
          </div>
          <div class="chips room-chips">${roomChips(r, t, hum, heat)}</div>
          ${statsRow("Température", temps, "°", 1)}
          ${r.hum ? statsRow("Humidité", hums, " %", 0) : ""}
        </div>
        ${r.temp || r.hum ? `<div>
          ${r.temp ? `<div class="label" style="margin-top:0">Température — 24 h</div>` + lineChart("room-" + i, [{ name: "Température", color: heat === "heating" ? "#ff8a5c" : "#7fb2ff", pts: hist[r.temp] }], { unit: "°", height: 180, legend: false, label: "Température sur 24 heures" }) : ""}
          ${r.hum ? `<div class="label">Humidité — 24 h</div>` + lineChart("hum-" + i, [{ name: "Humidité", color: "#5fd0d6", pts: hist[r.hum] }], { unit: " %", height: 110, legend: false, label: "Humidité sur 24 heures" }) : ""}
        </div>` : ""}
      </div>`);

    // Blocs de la pièce : ce qu'on commande (chauffage, lumières, volets) et ce qu'on surveille (capteurs).
    const groups = [];
    if (climates.length) groups.push(group("p-climates", "", section("p-h-cl", "Chauffage", "", "chauffage") + `<div class="climates">${climates.map((c) => climateCard(c, { inRoom: true })).join("")}</div>`));
    if (lights.length) groups.push(group("p-lights", "", section("p-h-l", "Lumières", "", "lumieres") + `<div class="tiles" ${cols(lights.length)}>${lights.map(lightTile).join("")}</div>`));
    if (covers.length) groups.push(group("p-covers", "", section("p-h-c", "Volets", "", "lumieres") + `<div class="tiles" ${cols(covers.length)}>${covers.map(coverTile).join("")}</div>`));
    const side = sensors.length ? card("p-sensors", "", head("Capteurs") + `<div class="rows">${sensors.map((o) => {
      const on = val(o.entity) === "on";
      return `<div class="row link ${on ? "is-alert" : ""}" role="button" tabindex="0" ${info(o.entity, o.name)}><span class="chip-icon">${icon(on && o.icon === "door" ? "door-open" : o.icon)}</span>
        <div class="txt"><div class="title">${esc(o.name)}</div><div class="sub">${esc(stateLabel(o.entity, val(o.entity)))} · ${esc(ago(st(o.entity)?.last_changed))}</div></div>${chev()}</div>`;
    }).join("")}</div>`) : "";

    // Disposition sur ordinateur :
    // - avec capteurs : commandes à gauche, capteurs à droite (moitié/moitié si la pièce a peu de commandes) ;
    // - sans capteurs : les blocs se rangent deux par deux au lieu de s'étirer sur toute la largeur.
    let body;
    if (side) {
      const few = !climates.length && lights.length + covers.length <= 3;
      body = groups.length
        ? `<div class="stack ${few ? "s-6" : "s-8"}">${groups.join("")}</div><div class="stack ${few ? "s-6" : "s-4"} side">${side}</div>`
        : `<div class="stack s-6">${side}</div>`;
    } else {
      body = groups.map((g) => `<div class="stack s-6">${g}</div>`).join("");
    }
    return ambiance + body;
  }

  // ---------- Plus (téléphone) ----------
  function viewPlus() {
    const S = C.security;
    const open = S.openings.filter((o) => val(o.entity) === "on").length;
    const ups = pendingUpdates().length;
    const link = (v, ic, title, sub) => `<button class="row link" data-act="nav" data-view="${v}"><span class="chip-icon">${icon(ic)}</span>
      <div class="txt"><div class="title">${title}</div><div class="sub">${esc(sub)}</div></div>${icon("chevron-right").replace('class="mdi', 'class="chev mdi')}</button>`;
    const install = !isStandalone() && conn.baseUrl
      ? card("install", "", head("Installer l'application") + `<div class="muted" style="font-size:14px">Sur iPhone : dans Safari, touche ${icon("export-variant")} <b>Partager</b> puis <b>Sur l'écran d'accueil</b>. L'app s'ouvrira en plein écran, comme une vraie application.</div>`)
      : "";
    const vac = C.vacuum ? st(C.vacuum.entity) : null;
    const bat = C.vacuum ? num(C.vacuum.battery) : NaN;
    return card("plus-nav", "", `<div class="rows">
        ${["lumieres", "chauffage", "conso"].filter((v) => pageOn(v) && !TABS().includes(v)).map((v) => link(v, VIEWS[v].icon, VIEWS[v].title, "")).join("")}
        ${pageOn("menage") ? link("menage", "robot-vacuum", "Ménage", `${VAC_STATE[vac?.state] || vac?.state || "—"}${Number.isFinite(bat) ? ` · batterie ${fmt(bat, 0)} %` : ""}`) : ""}
        ${pageOn("securite") ? link("securite", "shield-home-outline", "Sécurité", (S.openings.length ? (open ? `${open} ouverture${open > 1 ? "s" : ""}` : "Tout est fermé") : "Présence") + (S.camera ? " · caméra" : "")) : ""}
        ${pageOn("systeme") ? link("systeme", "server-outline", "Système", `${C.system.nas ? `NAS ${fmt(num(C.system.nas.volume), 0)} % · ` : ""}${ups ? ups + " mise" + (ups > 1 ? "s" : "") + " à jour" : "à jour"}`) : ""}
        <button class="row link" data-act="settings"><span class="chip-icon">${icon("tune-variant")}</span><div class="txt"><div class="title">Réglages</div><div class="sub">Thème, connexion</div></div>${icon("chevron-right").replace('class="mdi', 'class="chev mdi')}</button>
      </div>`) + install;
  }

  // ---------- Feuilles du bas ----------
  // Libellé lisible d'un état selon le type d'entité.
  function stateLabel(eid, s) {
    if (s == null) return "—";
    if (s === "unavailable") return "Indisponible";
    if (s === "unknown") return "Inconnu";
    const d = eid.split(".")[0], dc = attr(eid, "device_class");
    if (d === "binary_sensor") {
      if (["door", "window", "opening", "garage_door"].includes(dc) || /contact/.test(eid)) return s === "on" ? "Ouverte" : "Fermée";
      if (["motion", "occupancy", "presence"].includes(dc) || /motion|occupancy/.test(eid)) return s === "on" ? "Détecté" : "Calme";
      return s === "on" ? "Activé" : "Désactivé";
    }
    if (d === "person" || d === "device_tracker") return PERSON(s);
    if (d === "schedule") return s === "on" ? "Créneau actif" : "Hors créneau";
    if (["automation", "switch", "input_boolean", "light"].includes(d)) return s === "on" ? "Activé" : "Désactivé";
    const n = parseFloat(s);
    if (Number.isFinite(n)) return `${fmt(n, Math.abs(n) < 100 && n % 1 ? 1 : 0)} ${attr(eid, "unit_of_measurement") || ""}`.trim();
    return s;
  }
  function entityIcon(eid) {
    const d = eid.split(".")[0], u = attr(eid, "unit_of_measurement") || "", dc = attr(eid, "device_class");
    if (d === "person") return "account";
    if (d === "schedule") return "calendar-clock";
    if (d === "binary_sensor") return /contact/.test(eid) || ["door", "window"].includes(dc) ? "door" : "motion-sensor";
    if (u === "°C") return "thermometer";
    if (u === "%") return /humid/.test(eid) ? "water-percent" : "gauge";
    if (u === "W" || u === "VA") return "flash-outline";
    if (/B\/s$/.test(u)) return "speedometer";
    if (u === "lx") return "brightness-5";
    return "chart-line";
  }

  const sheetHist = {};
  async function loadSheetHistory(eid) {
    try {
      const res = await conn.history([eid], 24);
      sheetHist[eid] = (res?.[eid] || []).map((p) => [p.lu ?? p.lc ?? 0, p.s]).filter((p) => p[0]);
    } catch {
      sheetHist[eid] = [];
    }
    renderSheet();
  }

  // ---------- Carte du foyer (OpenStreetMap via Leaflet, chargé seulement quand on ouvre la carte) ----------
  let leafletReady = null, householdMap = null, mapMarkers = {};
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletReady) return leafletReady;
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      js.onload = resolve;
      js.onerror = () => { leafletReady = null; reject(new Error("Carte indisponible")); };
      document.head.appendChild(js);
    });
    return leafletReady;
  }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const coords = (eid) => {
    const lat = attr(eid, "latitude"), lon = attr(eid, "longitude");
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  };
  function distanceKm(a, b) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function personPin(p) {
    const home = val(p.entity) === "home";
    const pic = attr(p.entity, "entity_picture");
    const img = pic && conn.baseUrl ? `<img src="${esc(conn.imageUrl(pic))}" alt="">` : `<span>${esc(p.name[0].toUpperCase())}</span>`;
    return window.L.divIcon({ className: "", html: `<div class="map-pin ${home ? "home" : ""}">${img}</div><div class="map-label">${esc(p.name)}</div>`, iconSize: [44, 44], iconAnchor: [22, 22] });
  }
  async function initHouseholdMap() {
    const el = document.getElementById("householdMap");
    if (!el) return;
    try { await loadLeaflet(); } catch {
      el.innerHTML = `<div class="placeholder" style="height:100%">Carte indisponible : vérifie la connexion internet.</div>`;
      return;
    }
    if (!document.body.contains(el) || sheet?.type !== "map") return;
    if (householdMap) householdMap.remove();
    mapMarkers = {};
    const L = window.L;
    householdMap = L.map(el, { zoomControl: false });
    // Fond OpenStreetMap ; en thème sombre il est assombri en CSS (classe map-dark).
    // OpenStreetMap exige l'adresse du site appelant ; Home Assistant demande au navigateur de la masquer
    // (Referrer-Policy: no-referrer), donc on la réautorise pour les images de la carte uniquement.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap", referrerPolicy: "strict-origin-when-cross-origin" }).addTo(householdMap);
    el.classList.toggle("map-dark", document.documentElement.dataset.theme !== "light");
    L.control.zoom({ position: "bottomright" }).addTo(householdMap);
    const home = coords("zone.home");
    if (home) {
      L.circle(home, { radius: attr("zone.home", "radius") || 100, color: cssVar("--ok"), weight: 1.5, fillOpacity: 0.12 }).addTo(householdMap);
      L.marker(home, { icon: L.divIcon({ className: "", html: `<div class="map-home"><i class="mdi mdi-home"></i></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false }).addTo(householdMap);
    }
    updateHouseholdMap(true);
    setTimeout(() => householdMap?.invalidateSize(), 420);
  }
  function updateHouseholdMap(fit) {
    if (!householdMap) return;
    const pts = [];
    C.persons.forEach((p) => {
      const c = coords(p.entity);
      if (!c) { mapMarkers[p.entity]?.remove(); delete mapMarkers[p.entity]; return; }
      pts.push(c);
      if (mapMarkers[p.entity]) mapMarkers[p.entity].setLatLng(c).setIcon(personPin(p));
      else mapMarkers[p.entity] = window.L.marker(c, { icon: personPin(p), zIndexOffset: 1000 }).addTo(householdMap);
    });
    const home = coords("zone.home");
    if (home) pts.push(home);
    if (!fit) return;
    if (pts.length > 1) householdMap.fitBounds(pts, { padding: [56, 56], maxZoom: 16 });
    else if (pts.length === 1) householdMap.setView(pts[0], 15);
    else householdMap.setView([46.6, 2.4], 5);
  }

  // Réglages d'affichage : règle de chauffage, pages, pièces et lumières visibles.
  const openDetails = new Set();
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.dataset?.det) d.open ? openDetails.add(d.dataset.det) : openDetails.delete(d.dataset.det);
  }, true);
  function displaySettings() {
    const prefSwitch = (kind, key, on, label) =>
      `<div class="row"><div class="txt"><div class="title">${esc(label)}</div></div><button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="pref" data-kind="${kind}" data-key="${esc(key)}"></button></div>`;
    const pgroup = (id, title, count, rows) => rows
      ? `<details class="pref-group" data-det="${id}" ${openDetails.has(id) ? "open" : ""}><summary><span>${esc(title)}</span><span class="faint">${count}</span></summary><div class="rows">${rows}</div></details>`
      : "";
    const PAGE_NAMES = { lumieres: "Lumières", chauffage: "Chauffage", conso: "Consommation", menage: "Ménage", securite: "Sécurité", systeme: "Système" };
    const pages = Object.keys(PAGE_NAMES).filter((v) => PAGE_AVAILABLE[v]());
    const roomHidden = (r) => !!cardOpt("room-" + slugify(r.name)).hidden;
    const lightHidden = (l) => !!cardOpt("lt-" + l.entity).hidden;
    const shownRooms = C.rooms.filter((r) => !roomHidden(r)).length;
    const shownLights = C.lights.filter((l) => !lightHidden(l)).length;
    const shownPages = pages.filter((v) => !custom.hiddenPages.includes(v)).length;
    return `
      ${C.climates.length ? `<div class="label">Pièce « en chauffe »</div>
        <div class="seg">${[["any", "Dès qu'un radiateur chauffe"], ["comfort", "Seulement en Confort"]].map(([k, l]) => `<button aria-pressed="${heatingRule() === k}" data-act="pref" data-kind="heat" data-value="${k}">${l}</button>`).join("")}</div>` : ""}
      <div class="label">Affichage</div>
      <button class="btn block" data-act="edit-start" style="margin:4px 0 12px">${icon("pencil-outline")}Personnaliser les cartes</button>
      ${pgroup("pages", "Pages", `${shownPages}/${pages.length}`, pages.map((v) => prefSwitch("page", v, !custom.hiddenPages.includes(v), PAGE_NAMES[v])).join(""))}
      ${pgroup("rooms", "Pièces", `${shownRooms}/${C.rooms.length}`, C.rooms.map((r) => prefSwitch("card", "room-" + slugify(r.name), !roomHidden(r), r.name)).join(""))}
      ${pgroup("lights", "Lumières", `${shownLights}/${C.lights.length}`, C.lights.map((l) => prefSwitch("card", "lt-" + l.entity, !lightHidden(l), l.room ? `${l.name} · ${l.room}` : l.name)).join(""))}`;
  }

  const SHEETS = {
    cust(cid) {
      const card = findCard(cid);
      const o = cardOpt(cid);
      const origT = card?.dataset.origTitle || "", origI = card?.dataset.origIcon || "";
      const hasT = !!(card && ownEl(card, "[data-title]")), hasI = !!(card && ownEl(card, "[data-icon]"));
      return `<div data-k="sheet-cust" data-lock="1">
        <div class="sheet-head"><span class="chip-icon">${icon(o.icon || origI || "pencil-outline")}</span><div class="txt"><h3>Modifier la carte</h3><p>${esc(origT || "Carte")}</p></div></div>
        ${hasT ? `<div class="field"><label for="custTitle">Nom</label><input id="custTitle" type="text" value="${esc(o.title || "")}" placeholder="${esc(origT)}" autocomplete="off"></div>` : ""}
        ${hasI ? `<div class="field"><label for="custIcon">Icône</label><input id="custIcon" type="text" value="${esc(o.icon || "")}" placeholder="${esc(origI)}" autocapitalize="off" autocomplete="off" spellcheck="false"></div>
          <div class="icon-picks">${ICON_PICKS.map((n) => `<button class="icon-pick" data-act="cust-icon" data-icon="${n}" aria-label="${n}">${icon(n)}</button>`).join("")}</div>
          <p class="faint" style="font-size:12.5px;margin:6px 0 0">Tous les noms d'icônes Material Design fonctionnent (ex. « lamp-outline »).</p>` : ""}
        <div class="btn-row" style="margin-top:18px"><button class="btn" data-act="cust-reset" data-cid="${esc(cid)}">Rétablir</button><button class="btn primary" data-act="cust-save" data-cid="${esc(cid)}">Enregistrer</button></div>
      </div>`;
    },
    map() {
      const home = coords("zone.home");
      const here = C.persons.filter((p) => val(p.entity) === "home").length;
      const rows = C.persons.map((p) => {
        const s = val(p.entity), c = coords(p.entity);
        const where = s === "home" ? "À la maison" : s === "not_home" ? "Dehors" : s === "unknown" ? "Position inconnue" : s;
        const dist = c && home && s !== "home" ? ` · à ${fmt(distanceKm(home, c), distanceKm(home, c) < 10 ? 1 : 0)} km` : "";
        return `<button class="row link ${s === "home" ? "is-on" : ""}" ${c ? `data-act="mapfocus" data-eid="${esc(p.entity)}"` : ""}>
          <span class="chip-icon ok">${icon(s === "home" ? "home-account" : "account-arrow-right-outline")}</span>
          <div class="txt"><div class="title">${esc(p.name)}</div><div class="sub">${esc(where + dist)} · ${esc(ago(st(p.entity)?.last_changed))}</div></div>
          ${c ? icon("crosshairs-gps") : `<span class="val muted">—</span>`}</button>`;
      }).join("");
      return `<div data-k="sheet-map-wrap" data-lock="1">
          <div class="sheet-head"><span class="chip-icon">${icon("map-marker-account-outline")}</span><div class="txt"><h3>Le foyer</h3><p>Positions des téléphones</p></div></div>
          <div id="householdMap" class="household-map"></div>
        </div>
        <div data-k="sheet-map-list"><div class="label">${here ? `${here} à la maison` : "Personne à la maison"}</div><div class="rows">${rows}</div></div>`;
    },
    weather() {
      const w = st(C.weather);
      const [ic, lbl] = wx(w?.state);
      const days = forecast.slice(0, 7).map((f, i) => {
        const d = new Date(f.datetime);
        const name = i === 0 ? "Aujourd'hui" : i === 1 ? "Demain" : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric" });
        return `<div class="row"><span class="chip-icon">${icon(wx(f.condition)[0])}</span>
          <div class="txt"><div class="title" style="text-transform:capitalize">${esc(name)}</div><div class="sub">${esc(wx(f.condition)[1])}${f.precipitation ? ` · ${fmt(f.precipitation, 1)} mm` : ""}${f.precipitation_probability != null ? ` · ${f.precipitation_probability} %` : ""}</div></div>
          <span class="val">${Math.round(f.temperature)}°<span class="muted"> / ${f.templow != null ? Math.round(f.templow) + "°" : "—"}</span></span></div>`;
      }).join("");
      return `<div data-k="sheet-weather">
        <div class="sheet-head"><span class="chip-icon">${icon(ic)}</span><div class="txt"><h3>Météo</h3>
          <p>${esc(lbl)}${w ? ` · ${fmt(w.attributes.temperature, 0)}° · humidité ${fmt(w.attributes.humidity, 0)} % · vent ${fmt(w.attributes.wind_speed, 0)} km/h` : ""}</p></div></div>
        ${days ? `<div class="rows">${days}</div>` : `<div class="empty">Prévisions indisponibles.</div>`}</div>`;
    },
    entity(eid, sh) {
      const s = st(eid);
      const name = sh?.label || fname(eid);
      const h = sheetHist[eid];
      const numeric = s && !eid.startsWith("binary_sensor.") && Number.isFinite(parseFloat(s.state));
      const unit = attr(eid, "unit_of_measurement") || "";
      let body;
      if (!h) body = `<div class="empty">Chargement de l'historique…</div>`;
      else if (numeric) {
        const pts = h.map(([t, v]) => [t, parseFloat(v)]).filter((p) => Number.isFinite(p[1]));
        const vs = pts.map((p) => p[1]);
        const d = vs.length && Math.max(...vs) < 100 ? 1 : 0;
        body = lineChart("sheet", [{ name, color: "#f4b860", pts }], { unit: unit === "°C" ? "°" : "", height: 200, legend: false, label: name + " sur 24 heures" }) +
          (vs.length ? `<div class="duo-stats"><div><span>Min</span><b>${fmt(Math.min(...vs), d)} ${esc(unit)}</b></div><div><span>Moyenne</span><b>${fmt(sum(vs) / vs.length, d)} ${esc(unit)}</b></div><div><span>Max</span><b>${fmt(Math.max(...vs), d)} ${esc(unit)}</b></div></div>` : "");
      } else {
        const changes = h.filter((p, i) => i === 0 || p[1] !== h[i - 1][1]);
        const rows = changes.map((p, i) => ({ t: p[0], s: p[1], until: changes[i + 1]?.[0] })).reverse().slice(0, 15);
        const when = (t) => {
          const d = new Date(t * 1000), today = new Date().toDateString() === d.toDateString();
          return (today ? "" : "hier ") + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        };
        const dur = (a, b) => { const m = Math.round(((b || Date.now() / 1000) - a) / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
        body = rows.length ? `<div class="label" style="margin-top:0">Dernières 24 h</div><div class="rows timeline">${rows.map((x) => `<div class="row"><span class="tl-dot ${x.s === "on" || x.s === "home" ? "on" : ""}"></span>
            <div class="txt"><div class="title">${esc(stateLabel(eid, x.s))}</div><div class="sub">${x.until ? "pendant " + dur(x.t, x.until) : "depuis " + dur(x.t)}</div></div><span class="val muted">${when(x.t)}</span></div>`).join("")}</div>`
          : `<div class="empty">Aucun changement sur 24 h.</div>`;
      }
      return `<div data-k="sheet-entity">
        <div class="sheet-head"><span class="chip-icon">${icon(entityIcon(eid))}</span><div class="txt"><h3>${esc(name)}</h3>
          <p>${esc(stateLabel(eid, s?.state))}${s ? " · " + esc(ago(s.last_changed)) : ""}</p></div></div>${body}</div>`;
    },
    light(eid) {
      const l = C.lights.find((x) => x.entity === eid) || { entity: eid, name: fname(eid), room: "", icon: "lightbulb-outline" };
      const L = lightInfo(l);
      const kmin = L.a.min_color_temp_kelvin || 2200, kmax = L.a.max_color_temp_kelvin || 6500;
      const k = L.a.color_temp_kelvin || Math.round((kmin + kmax) / 2);
      const kp = clamp(((k - kmin) / (kmax - kmin)) * 100, 0, 100);
      return `<div data-k="sheet-light" class="${L.on ? "is-on" : ""}">
        <div class="sheet-head"><span class="chip-icon warm">${icon(l.icon)}</span>
          <div class="txt"><h3>${esc(l.name)}</h3><p>${esc(l.room)}${l.room ? " · " : ""}${L.label}</p></div>${sw(eid, L.on, "warm", l.name)}</div>
        ${L.dimmable ? `<div class="slider v" data-slider="brightness" data-eid="${esc(eid)}" role="slider" aria-label="Luminosité" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${L.bri}">
          <div class="fill" style="height:${L.bri}%"></div><div class="lbl">${icon("brightness-6")}<span class="pct">${L.bri} %</span></div></div>` : ""}
        ${L.ct ? `<div class="label" style="margin-top:22px">Température de couleur</div><div class="slider kelvin ${L.on ? "" : "disabled"}" data-slider="kelvin" data-eid="${esc(eid)}" data-min="${kmin}" data-max="${kmax}" role="slider" aria-label="Température de couleur">
          <div class="thumb" style="left:${kp.toFixed(1)}%"></div><div class="lbl"><span></span><span class="pct">${k} K</span></div></div>` : ""}
      </div>`;
    },
    settings() {
      const theme = store.get(STORE.theme) || "auto";
      const saved = store.get(STORE.conn);
      const demo = conn instanceof window.DemoConnection;
      return `<div data-k="sheet-settings">
        <div class="sheet-head"><span class="chip-icon">${icon("tune-variant")}</span><div class="txt"><h3>Réglages</h3>
          <p>${demo ? "Mode démonstration" : esc(saved?.url || "")}</p></div></div>
        <div class="label" style="margin-top:0">Thème</div>
        <div class="seg">${[["auto", "Auto"], ["dark", "Sombre"], ["light", "Clair"]].map(([k, l]) => `<button aria-pressed="${theme === k}" data-act="theme" data-theme="${k}">${l}</button>`).join("")}</div>
        ${displaySettings()}
        <div class="label">Connexion</div>
        <div class="muted" style="font-size:14px;margin-bottom:14px">${demo ? "Données simulées, rien n'est envoyé à Home Assistant." : saved?.mode === "oauth" ? "Connecté avec ton compte Home Assistant." : "Connecté avec un jeton d'accès longue durée."}</div>
        <button class="btn block danger" data-act="logout">${icon("logout")}${demo ? "Quitter le mode démo" : "Se déconnecter"}</button>
      </div>`;
    },
  };

  function openSheet(type, eid, label) {
    sheet = { type, eid, label };
    if (type === "entity" && conn) { delete sheetHist[eid]; loadSheetHistory(eid); }
    if (type === "map") setTimeout(initHouseholdMap, 30);
    const el = $("#sheet"), bd = $("#sheetBackdrop");
    $("#sheetBody").innerHTML = "";
    renderSheet();
    el.hidden = false;
    bd.hidden = false;
    el.style.transform = "";
    requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.add("open"); bd.classList.add("open"); }));
    document.documentElement.style.overflow = "hidden";
  }

  function closeSheet() {
    if (!sheet) return;
    if (householdMap) { householdMap.remove(); householdMap = null; mapMarkers = {}; }
    sheet = null;
    const el = $("#sheet"), bd = $("#sheetBackdrop");
    el.style.transform = "";
    el.classList.remove("open");
    bd.classList.remove("open");
    document.documentElement.style.overflow = "";
    setTimeout(() => { if (!sheet) { el.hidden = true; bd.hidden = true; $("#sheetBody").innerHTML = ""; } }, 380);
  }

  function renderSheet() {
    if (!sheet) return;
    patch($("#sheetBody"), SHEETS[sheet.type](sheet.eid, sheet), "sheet-" + sheet.type + sheet.eid);
    observeCharts();
  }

  // Glisser vers le bas pour fermer
  (function sheetDrag() {
    let startY = null, dy = 0;
    document.addEventListener("pointerdown", (e) => {
      const el = $("#sheet");
      if (!sheet || !el.contains(e.target) || e.target.closest(".slider, button, input, .household-map") || el.scrollTop > 0) return;
      startY = e.clientY; dy = 0;
      el.style.transition = "none";
    });
    document.addEventListener("pointermove", (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.clientY - startY);
      $("#sheet").style.transform = isDesktopSheet() ? `translate(-50%, ${dy}px)` : `translateY(${dy}px)`;
    });
    const end = () => {
      if (startY === null) return;
      const el = $("#sheet");
      el.style.transition = "";
      startY = null;
      if (dy > 110) closeSheet(); else el.style.transform = "";
    };
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  })();
  const isDesktopSheet = () => window.matchMedia("(min-width: 760px)").matches;

  // ---------- Vues & navigation ----------
  const VIEWS = {
    accueil: { title: "Accueil", icon: "home-outline", render: viewAccueil },
    lumieres: { title: "Lumières", icon: "lightbulb-outline", render: viewLumieres },
    chauffage: { title: "Chauffage", icon: "radiator", render: viewChauffage },
    conso: { title: "Conso", icon: "lightning-bolt-outline", render: viewConso },
    menage: { title: "Ménage", icon: "robot-vacuum", render: viewMenage, parent: "plus" },
    securite: { title: "Sécurité", icon: "shield-home-outline", render: viewSecurite, parent: "plus" },
    systeme: { title: "Système", icon: "server-outline", render: viewSysteme, parent: "plus" },
    plus: { title: "Plus", icon: "dots-horizontal-circle-outline", render: viewPlus },
    piece: { title: "Pièce", icon: "door-open", render: viewPiece },
  };
  const parentOf = (v) => (v === "piece" ? pieceBack : inPlus(v) ? "plus" : undefined);
  function topLevel(v) {
    for (let i = 0; i < 4 && parentOf(v); i++) v = parentOf(v);
    return v;
  }
  // Onglets et menu latéral : seulement les pages disponibles (5 onglets au maximum sur téléphone).
  const TABS = () => {
    const main = ["lumieres", "chauffage", "conso", "menage", "securite"].filter(pageOn);
    return ["accueil", ...main.slice(0, 3), "plus"];
  };
  const inPlus = (v) => ["menage", "securite", "systeme", "lumieres", "chauffage", "conso"].includes(v) && !TABS().includes(v);
  const RAIL = () => ["accueil", "lumieres", "chauffage", "conso", "menage", "securite", "systeme"].filter(pageOn);

  function renderNav() {
    const activeTab = topLevel(view);
    $("#tabbar").innerHTML = TABS().map((k) => `<button class="tab" data-act="nav" data-view="${k}" ${k === activeTab ? 'aria-current="page"' : ""}>${icon(VIEWS[k].icon)}<span>${VIEWS[k].title}</span></button>`).join("");
    $("#rail").innerHTML = `<div class="brand">${icon("home-heart")}</div>` +
      RAIL().map((k) => `<button class="nav-btn" data-act="nav" data-view="${k}" ${k === view || k === parentOf(view) ? 'aria-current="page"' : ""}>${icon(VIEWS[k].icon)}<span>${VIEWS[k].title}</span></button>`).join("") +
      `<div class="spacer"></div><button class="nav-btn" data-act="settings">${icon("tune-variant")}<span>Réglages</span></button>`;
    const parent = parentOf(view);
    $("#back").hidden = !parent || (isDesktop() && parent === "plus");
    if (parent) $("#back").querySelector("span").textContent = VIEWS[parent].title;
  }

  // ---------- Moteur de personnalisation ----------
  // Chaque carte a un identifiant (data-cid, sinon data-k). Avant affichage, on applique les choix de
  // l'utilisateur : carte masquée, nom (élément data-title), icône (élément data-icon) et position.
  const isCid = (el) => el.nodeType === 1 && !!(el.dataset.cid || (el.dataset.k && !el.classList.contains("section-title")));
  const cidOf = (el) => el.dataset.cid || el.dataset.k;
  function nearestCid(el) {
    for (let x = el.parentElement; x; x = x.parentElement) if (isCid(x)) return x;
    return null;
  }
  const ownEl = (card, sel) => [...card.querySelectorAll(sel)].find((x) => nearestCid(x) === card);
  const ICON_PICKS = ["sofa-outline", "bed-outline", "silverware-fork-knife", "shower-head", "desk", "teddy-bear", "lightbulb-outline", "ceiling-light-outline",
    "floor-lamp-outline", "lamp-outline", "led-strip-variant", "string-lights", "pine-tree", "radiator", "fire", "window-shutter", "television", "speaker", "flower-outline", "garage", "stairs", "door", "home-outline", "star-outline"];
  function editBar(cid, hidden, editable, horizontal) {
    const b = (op, ic, label) => `<button data-act="cust" data-op="${op}" data-cid="${esc(cid)}" aria-label="${label}">${icon(ic)}</button>`;
    return `<div class="cust-bar">${b("up", horizontal ? "arrow-left" : "arrow-up", "Déplacer avant")}${b("down", horizontal ? "arrow-right" : "arrow-down", "Déplacer après")}${editable ? b("edit", "pencil-outline", "Renommer ou changer l'icône") : ""}${b("hide", hidden ? "eye-off-outline" : "eye-outline", hidden ? "Afficher" : "Masquer")}</div>`;
  }
  function customize(root) {
    const cards = [...root.querySelectorAll("[data-cid],[data-k]")].filter(isCid);
    for (const el of cards) {
      const cid = cidOf(el);
      const o = cardOpt(cid);
      const t = ownEl(el, "[data-title]"), ic = ownEl(el, "[data-icon]");
      if (t) { el.dataset.origTitle = t.textContent; if (o.title) t.textContent = o.title; }
      if (ic) {
        const m = [...ic.classList].find((c) => c.startsWith("mdi-"));
        el.dataset.origIcon = m ? m.slice(4) : "";
        if (o.icon && m) { ic.classList.remove(m); ic.classList.add("mdi-" + o.icon); }
      }
      if (o.hidden && !editMode) { el.remove(); continue; }
      if (editMode) {
        if (o.hidden) el.classList.add("cust-hidden");
        const horizontal = !!el.parentElement?.matches?.(".tiles, .rooms");
        el.insertAdjacentHTML("beforeend", editBar(cid, !!o.hidden, !!(t || ic), horizontal));
      }
    }
    // Position : on réordonne les cartes entre elles, sans toucher aux autres éléments de la page.
    const parents = new Set(cards.filter((el) => el.parentNode).map((el) => el.parentNode));
    for (const parent of parents) {
      const kids = [...parent.children].filter(isCid);
      if (kids.length < 2 || !kids.some((k) => cardOpt(cidOf(k)).order != null)) continue;
      const sorted = kids.map((k, i) => ({ k, o: cardOpt(cidOf(k)).order ?? i })).sort((a, b) => a.o - b.o).map((x) => x.k);
      const marks = kids.map((k) => { const m = document.createComment(""); parent.replaceChild(m, k); return m; });
      marks.forEach((m, i) => parent.replaceChild(sorted[i], m));
    }
  }
  const findCard = (cid) => [...$("#view").querySelectorAll("[data-cid],[data-k]")].find((x) => isCid(x) && cidOf(x) === cid);
  // Reconstruction complète de la page (les blocs regroupés ne sont pas mis à jour individuellement).
  const rerender = () => { $("#view").dataset.view = ""; render(); };
  function setEditMode(on) {
    editMode = on;
    document.body.classList.toggle("editing", on);
    $("#editBanner").hidden = !on;
    $("#view").dataset.view = ""; // reconstruction complète de la page
    render();
  }

  // Ne remplace que les éléments qui ont changé (clé data-k) : pas de scintillement.
  function patch(root, html, key) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    if (root.id === "view") customize(tpl.content);
    const next = [...tpl.content.querySelectorAll("[data-k]")];
    const prev = [...root.querySelectorAll("[data-k]")];
    const same = root.dataset.view === key && next.length === prev.length && next.every((n, i) => n.dataset.k === prev[i].dataset.k);
    if (!same) {
      root.replaceChildren(tpl.content); // version personnalisée (et non le HTML brut)
      root.dataset.view = key;
      return;
    }
    next.forEach((n, i) => {
      const o = prev[i];
      if (o.dataset.lock) return;
      if (o.outerHTML !== n.outerHTML) o.replaceWith(n);
    });
  }

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }
  function render() {
    if (!conn || $("#app").hidden) return;
    if (view === "plus" && isDesktop()) view = "accueil";
    $("#title").textContent = view === "piece" ? currentRoom()?.name || "Pièce" : VIEWS[view].title;
    patch($("#view"), VIEWS[view].render(), view + "/" + viewParam);
    renderSheet();
    observeCharts();
  }

  function go(v, { replace = false, param = "" } = {}) {
    if (!VIEWS[v] || (PAGE_AVAILABLE[v] && !pageOn(v))) v = "accueil";
    if (v === "piece" && view !== "piece") pieceBack = view;
    if (v !== "piece") param = "";
    const changed = v !== view || param !== viewParam;
    view = v;
    viewParam = param;
    const url = "#/" + v + (param ? "/" + param : "");
    if (location.hash !== url) (replace ? history.replaceState : history.pushState).call(history, null, "", url);
    renderNav();
    render();
    if (changed) window.scrollTo({ top: 0 });
  }

  function goHash(replace = true) {
    const [v, p] = (location.hash || "").replace(/^#\/?/, "").split("/");
    go(v || "accueil", { replace, param: p || "" });
  }

  // ---------- Actions ----------
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 2400);
  }

  async function call(svc, target, data = {}, okMsg) {
    const [domain, service] = svc.split(".");
    try {
      await conn.callService(domain, service, data, { entity_id: ids(target) });
      if (okMsg) toast("✓ " + okMsg);
    } catch (e) {
      toast("Échec : " + e.message);
    }
  }


  function bumpTemp(eid, dir) {
    const a = st(eid).attributes;
    const step = a.target_temp_step || 0.5;
    const cur = pendingTarget[eid] ?? a.temperature ?? 19;
    const nv = clamp(Math.round((cur + dir * step) / step) * step, a.min_temp ?? 7, a.max_temp ?? 30);
    pendingTarget[eid] = nv;
    render();
    clearTimeout(tempTimers[eid]);
    tempTimers[eid] = setTimeout(async () => {
      await call("climate.set_temperature", eid, { temperature: nv });
      setTimeout(() => { delete pendingTarget[eid]; scheduleRender(); }, 3500);
    }, 700);
  }

  async function logout() {
    closeSheet();
    const saved = store.get(STORE.conn);
    if (saved?.mode === "oauth" && saved.oauth?.refresh_token) window.HAOAuth.revoke(saved.url, saved.oauth.refresh_token);
    store.del(STORE.conn);
    conn?.close();
    conn = null;
    showSetup();
  }

  // Appui long → feuille de réglages
  let longPress = null, suppressClick = false;
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-long]");
    if (!el || editMode || e.target.closest(".tile-more")) return;
    clearTimeout(longPress?.t);
    longPress = {
      x: e.clientX, y: e.clientY,
      t: setTimeout(() => { suppressClick = true; haptic(); openSheet(el.dataset.long, el.dataset.eid); longPress = null; }, 450),
    };
  });
  document.addEventListener("pointermove", (e) => {
    if (longPress && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 10) { clearTimeout(longPress.t); longPress = null; }
  });
  ["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => { if (longPress) { clearTimeout(longPress.t); longPress = null; } }));
  document.addEventListener("contextmenu", (e) => { if (e.target.closest("[data-long]")) e.preventDefault(); });
  document.addEventListener("click", (e) => { if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); } }, true);

  document.addEventListener("click", async (e) => {
    if (e.target.id === "sheetBackdrop") return closeSheet();
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act, eid = el.dataset.eid;
    // En mode personnalisation, les cartes ne pilotent plus les appareils : seuls les boutons d'édition répondent.
    if (editMode && el.closest("#view") && act !== "cust") return;
    if (act === "edit-start") { closeSheet(); return setEditMode(true); }
    if (act === "edit-done") return setEditMode(false);
    if (act === "edit-reset") {
      if (!window.confirm("Rétablir toutes les cartes (noms, icônes, positions, cartes masquées) ?")) return;
      custom.cards = {};
      saveCustom();
      return rerender();
    }
    if (act === "cust") {
      const cid = el.dataset.cid, op = el.dataset.op;
      const card = findCard(cid);
      if (op === "edit") return openSheet("cust", cid);
      if (op === "hide") custom.cards[cid] = { ...cardOpt(cid), hidden: !cardOpt(cid).hidden };
      if ((op === "up" || op === "down") && card?.parentElement) {
        const kids = [...card.parentElement.children].filter(isCid);
        const i = kids.indexOf(card), j = op === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= kids.length) return;
        [kids[i], kids[j]] = [kids[j], kids[i]];
        kids.forEach((k, n) => (custom.cards[cidOf(k)] = { ...cardOpt(cidOf(k)), order: n }));
      }
      haptic();
      saveCustom();
      return rerender();
    }
    if (act === "cust-icon") { const f = $("#custIcon"); if (f) f.value = el.dataset.icon; return; }
    if (act === "cust-save" || act === "cust-reset") {
      const cid = el.dataset.cid;
      const o = { ...cardOpt(cid) };
      if (act === "cust-save") {
        const t = $("#custTitle")?.value.trim(), i = $("#custIcon")?.value.trim().replace(/^mdi:/, "");
        if (t) o.title = t; else delete o.title;
        if (i) o.icon = i; else delete o.icon;
      } else { delete o.title; delete o.icon; delete o.hidden; }
      custom.cards[cid] = o;
      saveCustom();
      closeSheet();
      return rerender();
    }
    if (act === "nav") { closeSheet(); return go(el.dataset.view, { param: el.dataset.param || "" }); }
    if (act === "back") return go(parentOf(view) || "accueil");
    if (act === "settings") return openSheet("settings");
    if (act === "theme") { store.set(STORE.theme, el.dataset.theme); applyTheme(); return renderSheet(); }
    if (act === "pref") {
      const kind = el.dataset.kind, key = el.dataset.key;
      if (kind === "heat") custom.heatingRule = el.dataset.value;
      else if (kind === "card") custom.cards[key] = { ...cardOpt(key), hidden: !cardOpt(key).hidden };
      else {
        const i = custom.hiddenPages.indexOf(key);
        i >= 0 ? custom.hiddenPages.splice(i, 1) : custom.hiddenPages.push(key);
      }
      saveCustom();
      haptic();
      renderNav();
      return rerender();
    }
    if (act === "logout") return logout();
    if (!conn) return;
    if (act === "sheet") return openSheet(el.dataset.sheet, eid);
    if (act === "info") return openSheet("entity", eid, el.dataset.label);
    if (act === "mapfocus") {
      const c = coords(eid);
      if (c && householdMap) { householdMap.setView(c, 16); $("#sheet").scrollTo({ top: 0, behavior: "smooth" }); }
      return;
    }
    if (act === "erange") { energy.range = el.dataset.r; render(); return loadEnergy(true); }
    if (act === "toggle") {
      if (isUnav(eid)) return;
      haptic();
      const domain = eid.split(".")[0];
      return call(`${["light", "switch", "automation", "input_boolean", "fan"].includes(domain) ? domain : "homeassistant"}.toggle`, eid);
    }
    if (act === "svc") {
      haptic();
      return call(el.dataset.svc, eid, el.dataset.data ? JSON.parse(el.dataset.data) : {}, el.dataset.label);
    }
    if (act === "temp") { haptic(); return bumpTemp(eid, +el.dataset.d); }
    if (act === "preset") { haptic(); return call("climate.set_preset_mode", eid, { preset_mode: el.dataset.p }); }
    if (act === "hvac") {
      const s = st(eid);
      haptic();
      return call("climate.set_hvac_mode", eid, { hvac_mode: s.state === "off" ? (s.attributes.hvac_modes.includes("auto") ? "auto" : "heat") : "off" });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('[role="button"][data-act], [role="link"][data-act]')) { e.preventDefault(); e.target.click(); }
  });

  // Curseurs (horizontaux et verticaux)
  document.addEventListener("pointerdown", (e) => {
    const sl = e.target.closest(".slider");
    if (!sl || sl.classList.contains("disabled") || !conn) return;
    e.preventDefault();
    sl.setPointerCapture(e.pointerId);
    const holder = sl.closest("[data-k]");
    holder.dataset.lock = "1";
    const kind = sl.dataset.slider;
    const vertical = sl.classList.contains("v");
    const paint = (p) => {
      if (kind === "brightness") {
        sl.querySelector(".fill").style[vertical ? "height" : "width"] = p * 100 + "%";
        sl.querySelector(".pct").textContent = Math.round(p * 100) + " %";
      } else {
        sl.querySelector(".thumb").style.left = p * 100 + "%";
        sl.querySelector(".pct").textContent = Math.round(+sl.dataset.min + p * (sl.dataset.max - sl.dataset.min)) + " K";
      }
    };
    const update = (ev) => {
      const r = sl.getBoundingClientRect();
      sl._p = clamp(vertical ? 1 - (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width, 0, 1);
      paint(sl._p);
    };
    update(e);
    const end = () => {
      sl.removeEventListener("pointermove", update);
      sl.removeEventListener("pointerup", end);
      sl.removeEventListener("pointercancel", end);
      const eid = sl.dataset.eid;
      haptic();
      if (kind === "brightness") {
        const pct = Math.round(sl._p * 100);
        call(pct < 1 ? "light.turn_off" : "light.turn_on", eid, pct < 1 ? {} : { brightness_pct: pct });
      } else {
        call("light.turn_on", eid, { color_temp_kelvin: Math.round(+sl.dataset.min + sl._p * (sl.dataset.max - sl.dataset.min)) });
      }
      setTimeout(() => { delete holder.dataset.lock; scheduleRender(); }, 1200);
    };
    sl.addEventListener("pointermove", update);
    sl.addEventListener("pointerup", end);
    sl.addEventListener("pointercancel", end);
  });

  // Images caméra / carte rafraîchies sans reconstruire la carte
  setInterval(() => {
    if (document.hidden) return;
    document.querySelectorAll("img[data-refresh]").forEach((img) => {
      const pic = attr(img.dataset.refresh, "entity_picture");
      if (!pic || !conn?.baseUrl) return;
      const pre = new Image();
      pre.onload = () => (img.src = pre.src);
      pre.src = conn.imageUrl(pic) + "&t=" + Date.now();
    });
  }, 6000);

  setInterval(() => { if (view === "accueil" && !document.hidden) scheduleRender(); }, 15000);
  setInterval(() => { if (view === "conso" && !document.hidden) loadEnergy(true); }, 5 * 60e3);

  // Bandeau du mode personnalisation
  document.body.insertAdjacentHTML("beforeend", `<div class="edit-banner" id="editBanner" hidden>
    <div class="txt"><b>Personnalisation</b><span>Déplace, renomme ou masque les cartes de chaque page.</span></div>
    <button class="btn" data-act="edit-reset">Tout rétablir</button><button class="btn primary" data-act="edit-done">Terminé</button></div>`);

  // ---------- Thème ----------
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  function applyTheme() {
    const pref = store.get(STORE.theme) || "auto";
    const t = pref === "auto" ? (mq.matches ? "light" : "dark") : pref;
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]').content = t === "light" ? "#f2efe9" : "#0c0d10";
  }
  mq.addEventListener?.("change", applyTheme);
  applyTheme();

  // ---------- Connexion ----------
  function setStatus(s) {
    const shown = navigator.onLine === false ? "offline" : s;
    const pill = $("#status");
    pill.dataset.status = shown;
    pill.querySelector(".lbl").textContent = { connected: "Connecté", demo: "Démo", connecting: "Connexion…", reconnecting: "Reconnexion…", auth_invalid: "Session expirée", offline: "Hors ligne" }[shown] || shown;
    if (s === "auth_invalid") showSetup("Ta session a expiré. Reconnecte-toi.");
  }

  async function loadForecast() {
    if (!C.weather) return;
    try {
      const res = await conn.callService("weather", "get_forecasts", { type: "daily" }, { entity_id: C.weather }, true);
      forecast = res?.response?.[C.weather]?.forecast || [];
      scheduleRender();
    } catch (e) {
      console.warn("Prévisions indisponibles", e);
    }
  }

  // Détection automatique des sections absentes de config.js (pièces, lumières, radiateurs…).
  const AUTO_KEYS = ["persons", "weather", "rooms", "lights", "covers", "media", "climates", "schedules", "heatingAutomations", "vacuum", "security", "energy"];
  async function discover() {
    const missing = AUTO_KEYS.filter((k) => !USER_KEYS.has(k));
    if (!missing.length || !window.MaisonDiscovery) return;
    const [areas, devices, entsRaw, eprefs] = await Promise.all([
      conn.send({ type: "config/area_registry/list" }).catch(() => []),
      conn.send({ type: "config/device_registry/list" }).catch(() => []),
      conn.send({ type: "config/entity_registry/list_for_display" }).catch(() => null),
      conn.energyPrefs().catch(() => null),
    ]);
    const entities = window.MaisonDiscovery.normalizeEntities(entsRaw, devices);
    const auto = window.MaisonDiscovery.build({ areas, entities, states: conn.states, energyPrefs: eprefs });
    for (const k of missing) if (auto[k] !== undefined) C[k] = auto[k];
    normalizeConfig(C);
    if (!USER_KEYS.has("energy") && eprefs) energy.prefs = normalizePrefs(eprefs);
    loadHistory();
    loadForecast();
  }

  let timers = [];
  async function start(connection) {
    timers.forEach(clearInterval);
    timers = [];
    conn = connection;
    conn.onStatus((s) => {
      setStatus(s);
      // Après une reconnexion (ex. retour de l'arrière-plan), on rafraîchit courbes et météo si besoin.
      if (s === "connected" && Date.now() - lastHistory > 5 * 60e3) loadHistory();
      if (s === "connected" && !forecast.length) loadForecast();
    });
    conn.onState((id) => {
      if (id) {
        pushHistory(id);
        if (sheet?.type === "entity" && sheet.eid === id && sheetHist[id]) sheetHist[id].push([Date.now() / 1000, val(id)]);
        if (sheet?.type === "map" && (id.startsWith("person.") || id === "zone.home")) updateHouseholdMap(false);
        if (pendingTarget[id] !== undefined && attr(id, "temperature") === pendingTarget[id]) delete pendingTarget[id];
      }
      scheduleRender();
    });
    // Mode démo sans configuration : on affiche une maison d'exemple.
    if (conn instanceof window.DemoConnection && !C.rooms.length && window.MAISON_DEMO_CONFIG) {
      Object.assign(C, JSON.parse(JSON.stringify(window.MAISON_DEMO_CONFIG)));
      normalizeConfig(C);
    }
    await conn.connect();
    if (!(conn instanceof window.DemoConnection)) {
      await discover().catch((e) => console.warn("Détection automatique incomplète", e));
      await loadCustom();
    }
    $("#setup").hidden = true;
    $("#app").hidden = false;
    goHash(true);
    if (conn instanceof window.DemoConnection) { loadHistory(); loadForecast(); }
    timers.push(setInterval(loadHistory, 10 * 60e3), setInterval(loadForecast, 30 * 60e3));
  }

  function connectionFrom(saved) {
    const auth = saved.mode === "oauth" ? { mode: "oauth", oauth: saved.oauth } : { mode: "token", token: saved.token };
    return new window.HAConnection(saved.url, auth, (a) => store.set(STORE.conn, { ...saved, oauth: a.oauth }));
  }

  // L'app est-elle servie par Home Assistant lui-même (dossier /local/) ?
  const servedByHA = () => location.protocol === "https:" && /^\/(local|hacsfiles)\//.test(location.pathname);

  function startOAuth(url) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set(STORE.oauth, { state, url });
    location.href = window.HAOAuth.authorizeUrl(url, state);
  }

  async function finishOAuth(params) {
    const pending = store.get(STORE.oauth);
    store.del(STORE.oauth);
    history.replaceState(null, "", location.pathname + location.hash);
    if (!pending || pending.state !== params.get("state")) throw new Error("La connexion a échoué, réessaie.");
    const oauth = await window.HAOAuth.exchange(pending.url, params.get("code"));
    const saved = { url: pending.url, mode: "oauth", oauth };
    store.set(STORE.conn, saved);
    return saved;
  }

  function showSetup(error) {
    closeSheet();
    const saved = store.get(STORE.conn);
    $("#app").hidden = true;
    const s = $("#setup");
    s.hidden = false;
    const tokenFields = `
      ${servedByHA() ? "" : `<div class="field"><label for="url">Adresse de Home Assistant</label><input id="url" type="url" inputmode="url" autocapitalize="off" required value="${esc(saved?.url || C.defaultUrl || "")}" placeholder="https://…"></div>`}
      <div class="field"><label for="token">Jeton d'accès longue durée</label><textarea id="token" required placeholder="eyJhbGciOi…" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div>
      <button class="btn ${servedByHA() ? "" : "primary"}" type="submit">${icon("key-outline")}Se connecter avec le jeton</button>`;
    s.innerHTML = `<form class="setup-card" id="setupForm" novalidate>
      <div class="brand-mark">${icon("home-heart")}</div>
      <h1>Nido</h1>
      <p>${servedByHA() ? "Connecte-toi avec ton compte Home Assistant." : "Connecte cette application à ton Home Assistant."}</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ""}
      ${servedByHA()
        ? `<button class="btn primary" type="button" id="oauthBtn">${icon("login")}Se connecter</button>
           <details class="help"><summary>Utiliser plutôt un jeton d'accès</summary><div style="margin-top:12px">${tokenFields}</div></details>`
        : `${tokenFields}
           <details class="help"><summary>Comment obtenir un jeton ?</summary><ol>
             <li>Ouvre Home Assistant → ton profil (en bas à gauche).</li>
             <li>Onglet <b>Sécurité</b> → <b>Jetons d'accès longue durée</b> → <b>Créer un jeton</b>.</li>
             <li>Copie-le et colle-le ici. Il reste uniquement sur cet appareil.</li></ol></details>`}
      <button class="btn" type="button" id="demoBtn" style="margin-top:10px">${icon("eye-outline")}Voir en mode démo</button>
    </form>`;
    s.querySelector("#demoBtn").onclick = () => start(new window.DemoConnection(C));
    s.querySelector("#oauthBtn")?.addEventListener("click", () => startOAuth(location.origin));
    s.querySelector("#setupForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const url = (s.querySelector("#url")?.value || location.origin).trim().replace(/\/+$/, "");
      const token = s.querySelector("#token").value.trim();
      if (!token) return;
      const btn = s.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.innerHTML = `${icon("loading mdi-spin")}Connexion…`;
      const saved = { url, mode: "token", token };
      const c = connectionFrom(saved);
      try {
        await start(c);
        store.set(STORE.conn, saved);
      } catch (e) {
        c.close();
        conn = null;
        showSetup(e.message);
      }
    };
  }

  // ---------- Cycle de vie (iOS met l'app en pause en arrière-plan) ----------
  function resume() {
    if (!conn || document.hidden) return;
    conn.ensureConnected();
    if (Date.now() - lastHistory > 5 * 60e3) loadHistory();
    render();
  }
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", () => { setStatus(conn?.status || "connecting"); resume(); });
  window.addEventListener("offline", () => setStatus("offline"));
  window.addEventListener("popstate", () => {
    if (sheet) return closeSheet();
    const [v, p = ""] = location.hash.replace(/^#\/?/, "").split("/");
    if (conn && VIEWS[v] && (v !== view || p !== viewParam)) go(v, { replace: true, param: p });
  });
  window.matchMedia("(min-width: 1100px)").addEventListener?.("change", () => { renderNav(); render(); });
  let resizeT;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(scheduleRender, 200); });

  // ---------- Service worker (lancement instantané, hors ligne) ----------
  // Mise à jour automatique : iOS reprend l'app sans la recharger. À chaque retour au premier plan,
  // on demande au service worker de vérifier s'il existe une nouvelle version ; s'il en installe une,
  // la page se recharge d'elle-même (une seule fois, et jamais lors de la toute première installation).
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const check = () => { if (!document.hidden) reg.update().catch(() => {}); };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("focus", check);
      setInterval(check, 30 * 60e3);
    }).catch((e) => console.warn("Service worker non enregistré", e));
  }

  // ---------- Démarrage ----------
  (async function boot() {
    const params = new URLSearchParams(location.search);
    try {
      if (params.has("code") && params.has("state")) {
        const saved = await finishOAuth(params);
        return await start(connectionFrom(saved));
      }
      if (params.has("demo")) return await start(new window.DemoConnection(C));
      const saved = store.get(STORE.conn);
      if (saved?.url && (saved.token || saved.oauth)) {
        if (!saved.mode) saved.mode = "token";
        const c = connectionFrom(saved);
        try {
          return await start(c);
        } catch (e) {
          if (c.status === "auth_invalid") throw e;
          // Réseau indisponible au lancement : on garde la session et on réessaie en arrière-plan.
          $("#setup").hidden = true;
          $("#app").hidden = false;
          goHash(true);
          return;
        }
      }
      showSetup();
    } catch (e) {
      conn?.close();
      conn = null;
      showSetup(e.message);
    }
  })();
})();
