// Client WebSocket Home Assistant (jeton longue durée ou connexion OAuth) + backend de démonstration.
(function () {
  "use strict";

  // ---------- OAuth (connexion avec le compte Home Assistant) ----------
  async function fetchToken(baseUrl, data) {
    const res = await fetch(baseUrl + "/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    });
    if (!res.ok) throw new Error(res.status === 400 ? "Session expirée, reconnecte-toi." : "Erreur d'authentification (" + res.status + ")");
    const j = await res.json();
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token || data.refresh_token,
      expires: Date.now() + j.expires_in * 1000,
    };
  }

  const OAuth = {
    clientId: () => location.origin + "/",
    redirectUri: () => location.origin + location.pathname,
    authorizeUrl(baseUrl, state) {
      return `${baseUrl}/auth/authorize?response_type=code&client_id=${encodeURIComponent(this.clientId())}&redirect_uri=${encodeURIComponent(this.redirectUri())}&state=${encodeURIComponent(state)}`;
    },
    exchange(baseUrl, code) {
      return fetchToken(baseUrl, { grant_type: "authorization_code", code, client_id: this.clientId() });
    },
    refresh(baseUrl, refreshToken) {
      return fetchToken(baseUrl, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.clientId() });
    },
    revoke(baseUrl, refreshToken) {
      return fetch(baseUrl + "/auth/revoke", { method: "POST", body: new URLSearchParams({ token: refreshToken }) }).catch(() => {});
    },
  };

  class HAConnection {
    // auth : { mode: "token", token } ou { mode: "oauth", oauth: { access_token, refresh_token, expires } }
    constructor(baseUrl, auth, onAuthUpdate) {
      this.baseUrl = baseUrl.replace(/\/+$/, "");
      this.auth = auth;
      this.onAuthUpdate = onAuthUpdate || (() => {});
      this.states = {};
      this.listeners = new Set();
      this.statusListeners = new Set();
      this.pending = new Map();
      this.nextId = 1;
      this.retry = 0;
      this.closed = false;
      this.status = "connecting";
    }

    get wsUrl() { return this.baseUrl.replace(/^http/i, "ws") + "/api/websocket"; }

    onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    onStatus(fn) { this.statusListeners.add(fn); fn(this.status); return () => this.statusListeners.delete(fn); }
    setStatus(s, detail) { this.status = s; this.statusListeners.forEach((fn) => fn(s, detail)); }

    async accessToken() {
      if (this.auth.mode === "token") return this.auth.token;
      const o = this.auth.oauth;
      if (Date.now() > o.expires - 60e3) {
        this.auth.oauth = await OAuth.refresh(this.baseUrl, o.refresh_token);
        this.onAuthUpdate(this.auth);
      }
      return this.auth.oauth.access_token;
    }

    connect() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (e) => { if (!settled) { settled = true; reject(e); } };
        this.setStatus(this.retry ? "reconnecting" : "connecting");
        let ws;
        try { ws = new WebSocket(this.wsUrl); } catch (e) { return fail(e); }
        this.ws = ws;

        ws.onmessage = async (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "auth_required") {
            try {
              ws.send(JSON.stringify({ type: "auth", access_token: await this.accessToken() }));
            } catch (e) {
              this.closed = true;
              this.setStatus("auth_invalid", e.message);
              ws.close();
              fail(e);
            }
          } else if (msg.type === "auth_invalid") {
            this.closed = true;
            this.setStatus("auth_invalid", msg.message);
            ws.close();
            fail(new Error("Accès refusé par Home Assistant"));
          } else if (msg.type === "auth_ok") {
            this.retry = 0;
            try {
              const states = await this.send({ type: "get_states" });
              this.states = {};
              states.forEach((s) => (this.states[s.entity_id] = s));
              await this.send({ type: "subscribe_events", event_type: "state_changed" });
              this.setStatus("connected");
              this.emit(null);
              if (!settled) { settled = true; resolve(); }
            } catch (e) { fail(e); }
          } else if (msg.type === "result" || msg.type === "pong") {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              msg.type === "pong" || msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message || "Erreur"));
            }
          } else if (msg.type === "event" && msg.event?.event_type === "state_changed") {
            const { entity_id, new_state } = msg.event.data;
            if (new_state) this.states[entity_id] = new_state;
            else delete this.states[entity_id];
            this.emit(entity_id);
          }
        };

        ws.onerror = () => fail(new Error("Connexion impossible à " + this.baseUrl));

        ws.onclose = () => {
          if (this.ws !== ws) return;
          this.pending.forEach((p) => p.reject(new Error("Connexion fermée")));
          this.pending.clear();
          if (this.closed) return;
          this.setStatus("reconnecting");
          const delay = Math.min(30000, 1000 * 2 ** this.retry++);
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { if (!this.closed) this.connect().catch(() => {}); }, delay);
        };
      });
    }

    // iOS coupe les WebSockets quand l'app passe en arrière-plan : on vérifie au retour.
    async ensureConnected() {
      if (this.closed) return;
      const ws = this.ws;
      if (!ws || ws.readyState > 1) {
        clearTimeout(this.timer);
        this.retry = 0;
        return this.connect().catch(() => {});
      }
      if (ws.readyState === 1) {
        const ok = await Promise.race([
          this.send({ type: "ping" }).then(() => true, () => false),
          new Promise((r) => setTimeout(() => r(false), 3000)),
        ]);
        if (!ok && this.ws === ws) {
          this.ws = null;
          ws.close();
          clearTimeout(this.timer);
          this.retry = 0;
          return this.connect().catch(() => {});
        }
      }
    }

    close() {
      this.closed = true;
      clearTimeout(this.timer);
      if (this.ws) this.ws.close();
    }

    emit(entityId) { this.listeners.forEach((fn) => fn(entityId)); }

    send(msg) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) return reject(new Error("Non connecté"));
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, ...msg }));
      });
    }

    callService(domain, service, data = {}, target, returnResponse = false) {
      const msg = { type: "call_service", domain, service, service_data: data };
      if (target) msg.target = target;
      if (returnResponse) msg.return_response = true;
      return this.send(msg);
    }

    history(entityIds, hours = 24) {
      return this.send({
        type: "history/history_during_period",
        start_time: new Date(Date.now() - hours * 3600e3).toISOString(),
        entity_ids: entityIds,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
    }

    // Statistiques long terme (variation par heure / jour / mois), converties en kWh.
    statistics(statisticIds, start, period, end) {
      const msg = {
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        statistic_ids: statisticIds,
        period,
        types: ["change"],
        units: { energy: "kWh" },
      };
      if (end) msg.end_time = end.toISOString();
      return this.send(msg);
    }

    energyPrefs() { return this.send({ type: "energy/get_prefs" }); }

    imageUrl(path) { return path ? this.baseUrl + path : ""; }
  }

  // ---------------------------------------------------------------------
  // Mode démo : états simulés à partir de la configuration.
  // ---------------------------------------------------------------------
  class DemoConnection {
    constructor(config) {
      this.config = config;
      this.listeners = new Set();
      this.statusListeners = new Set();
      this.status = "demo";
      this.baseUrl = "";
      this.states = {};
    }
    onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    onStatus(fn) { this.statusListeners.add(fn); fn(this.status); return () => this.statusListeners.delete(fn); }
    emit(id) { this.listeners.forEach((fn) => fn(id)); }
    close() { clearInterval(this.timer); }
    ensureConnected() {}
    imageUrl() { return ""; }

    set(entity_id, state, attributes = {}) {
      const now = new Date().toISOString();
      this.states[entity_id] = { entity_id, state: String(state), attributes, last_changed: now, last_updated: now };
    }

    async connect() {
      const c = this.config;
      // Les entités absentes de la configuration sont simplement ignorées.
      const s = (id, st, at) => { if (id) this.set(id, st, at); };
      s("zone.home", "1", { latitude: 48.8566, longitude: 2.3522, radius: 100, friendly_name: "Maison" });
      const spots = [[48.8567, 2.3524, "home"], [48.8738, 2.2950, "not_home"], [48.8462, 2.3371, "not_home"]];
      c.persons.forEach((p, i) => {
        const [lat, lon, where] = spots[i % spots.length];
        s(p.entity, where, { friendly_name: p.name, latitude: lat, longitude: lon, gps_accuracy: 15 });
      });
      s(c.weather, "cloudy", { temperature: 12.1, humidity: 96, wind_speed: 13.3 });
      const temps = [18.3, 18.5, 19.7, 19.3, 19.3, 20.1];
      c.rooms.forEach((r, i) => {
        s(r.temp, temps[i % temps.length], { unit_of_measurement: "°C" });
        s(r.hum, [55, 57, 59, 60][i % 4], { unit_of_measurement: "%" });
      });
      c.climates.forEach((cl, i) => {
        if (cl.temp && !this.states[cl.temp]) s(cl.temp, 17.8, { unit_of_measurement: "°C" });
        const prog = i < 3;
        s(cl.entity, prog ? "auto" : "heat", {
          hvac_modes: prog ? ["heat", "off", "auto"] : ["heat", "off"],
          preset_modes: ["none", "frost_protection", "eco", "comfort", "comfort-1", "comfort-2", "auto", "boost"],
          preset_mode: prog ? "auto" : "comfort",
          temperature: prog ? 17.5 : 19,
          current_temperature: prog ? [18.2, 17.8, 18.5][i] : null,
          min_temp: 7, max_temp: 28, target_temp_step: 0.5,
          supported_features: prog ? 401 : 400,
          hvac_action: i === 0 || i === 2 ? "heating" : prog ? "idle" : undefined,
          friendly_name: cl.name,
        });
      });
      c.rooms.forEach((r) => (r.climates || []).forEach((id) => {
        if (!this.states[id]) s(id, "heat", {});
      }));
      const e = c.energy || {};
      s(e.power, 1590, { unit_of_measurement: "VA" });
      s(e.period, "HP..", {});
      s(e.subscription, 45, { unit_of_measurement: "A" });
      s(e.current, 6, { unit_of_measurement: "A" });
      c.schedules.forEach((id, i) => s(id, i === 3 ? "off" : "on", { friendly_name: `Planning ${i + 1}` }));
      c.heatingAutomations.forEach((id, i) => s(id, i === 2 ? "on" : "off", { friendly_name: `Chauffage ${i + 1}` }));
      c.lights.forEach((l, i) => {
        const dimmable = i < 2;
        s(l.entity, i === 0 ? "on" : "off", dimmable
          ? { brightness: 150, color_temp_kelvin: 3200, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, supported_color_modes: i === 0 ? ["color_temp", "xy"] : ["color_temp"], color_mode: "color_temp" }
          : { supported_color_modes: ["onoff"] });
      });
      c.covers.forEach((cv) => s(cv.entity, "open", { supported_features: 11 }));
      c.media.forEach((m, i) => s(m.entity, i === 1 ? "playing" : i === 0 ? "off" : "idle", i === 1 ? { media_title: "Clair de lune", media_artist: "Claude Debussy", volume_level: 0.3 } : {}));
      const v = c.vacuum;
      if (v) {
        s(v.entity, "docked", { fan_speed: "Basic", fan_speed_list: ["Silent", "Basic", "Strong", "Full Speed"], friendly_name: "Aspirateur" });
        s(v.battery, 92, { unit_of_measurement: "%" });
        s(v.map, "idle", {});
        (v.rooms || []).forEach((r) => s(r.script, "off", {}));
        (v.selects || []).forEach((se, i) => s(se.entity, ["Sweep", "First"][i] || "A", { options: [["Sweep", "Mop", "Sweep and mop"], ["First", "Second", "Third"]][i] || ["A", "B"] }));
        (v.switches || []).forEach((sw, i) => s(sw.entity, i < 2 ? "on" : "off", {}));
      }
      const sec = c.security || {};
      s(sec.camera, "idle", {});
      (sec.openings || []).forEach((o, i) => s(o.entity, i === 1 ? "on" : "off", { device_class: "door" }));
      (sec.motion || []).forEach((m) => s(m.entity, "off", {}));
      s(sec.illuminance, 43, { unit_of_measurement: "lx" });
      [["automation.depart", "Départ"], ["automation.entree_si_absent", "Entrée si absent"], ["automation.notification_presence", "Notification présence"], ["automation.bonne_nuit", "Bonne nuit"], ["automation.matin", "Matin"]]
        .forEach(([a, n]) => s(a, "on", { friendly_name: n }));
      const sys = c.system || {};
      if (sys.nas) {
        s(sys.nas.volume, 78, { unit_of_measurement: "%" });
        s(sys.nas.cpu, 4, { unit_of_measurement: "%" });
        s(sys.nas.memory, 48, { unit_of_measurement: "%" });
        s(sys.nas.temp, 40, { unit_of_measurement: "°C" });
        (sys.nas.drives || []).forEach((d) => s(d, "normal", {}));
      }
      if (sys.freebox) {
        s(sys.freebox.down, 3451.9, { unit_of_measurement: "kB/s" });
        s(sys.freebox.up, 70.3, { unit_of_measurement: "kB/s" });
        s(sys.freebox.calls, 30, {});
      }
      if (sys.waterHeater) {
        s(sys.waterHeater.power, 0, { unit_of_measurement: "W" });
        s(sys.waterHeater.energy, 4050.36, { unit_of_measurement: "kWh" });
      }
      s("update.home_assistant_core_update", "on", { friendly_name: "Home Assistant Core", installed_version: "2026.10.2", latest_version: "2026.10.3" });
      s("update.browser_mod_update", "on", { friendly_name: "browser_mod", installed_version: "v3.3.0", latest_version: "v3.4.0" });

      const withTemp = c.rooms.filter((r) => r.temp);
      this.timer = withTemp.length && setInterval(() => {
        const r = withTemp[Math.floor(Math.random() * withTemp.length)];
        const cur = parseFloat(this.states[r.temp].state);
        this.set(r.temp, (cur + (Math.random() - 0.5) * 0.2).toFixed(1), this.states[r.temp].attributes);
        this.emit(r.temp);
      }, 4000);
      this.emit(null);
    }

    async callService(domain, service, data = {}, target) {
      const ids = [].concat(target?.entity_id || []);
      if (domain === "weather" && service === "get_forecasts") {
        const days = ["cloudy", "rainy", "partlycloudy", "sunny", "rainy", "cloudy", "partlycloudy"];
        const forecast = days.map((cond, i) => ({
          datetime: new Date(Date.now() + i * 864e5).toISOString(),
          condition: cond,
          temperature: 13 + Math.round(Math.sin(i) * 3),
          templow: 6 + Math.round(Math.cos(i) * 2),
        }));
        return { response: { [ids[0]]: { forecast } } };
      }
      ids.forEach((id) => {
        const st = this.states[id];
        if (!st) return;
        const a = { ...st.attributes };
        let state = st.state;
        if (service === "toggle") state = state === "on" ? "off" : "on";
        if (service === "turn_on" && !/^(scene|script)\./.test(id)) state = "on";
        if (service === "turn_off") state = "off";
        if (service === "open_cover") state = "open";
        if (service === "close_cover") state = "closed";
        if (service === "set_temperature") a.temperature = data.temperature;
        if (service === "set_preset_mode") a.preset_mode = data.preset_mode;
        if (service === "set_hvac_mode") state = data.hvac_mode;
        if (service === "select_option") state = data.option;
        if (service === "set_fan_speed") a.fan_speed = data.fan_speed;
        if (service === "start") state = "cleaning";
        if (service === "pause") state = "paused";
        if (service === "return_to_base") state = "returning";
        if (service === "media_play_pause") state = state === "playing" ? "paused" : "playing";
        if (data.brightness_pct !== undefined) a.brightness = Math.round(data.brightness_pct * 2.55);
        if (data.color_temp_kelvin !== undefined) a.color_temp_kelvin = data.color_temp_kelvin;
        this.set(id, state, a);
        this.emit(id);
      });
      return {};
    }

    async energyPrefs() { throw new Error("démo"); }

    // Statistiques simulées : heures creuses la nuit, pleines le jour, chauffage le matin et le soir.
    async statistics(statisticIds, start, period) {
      const out = {};
      const step = period === "hour" ? 3600e3 : period === "day" ? 864e5 : 0;
      const now = Date.now();
      const buckets = [];
      for (let i = 0; i < 400; i++) {
        const t = period === "month" ? new Date(start.getFullYear(), start.getMonth() + i, 1).getTime() : start.getTime() + i * step;
        if (t > now) break;
        buckets.push(t);
      }
      statisticIds.forEach((id, k) => {
        out[id] = buckets.map((t) => {
          const d = new Date(t), h = d.getHours();
          const night = h < 7 || h >= 23;
          const winter = [0, 1, 2, 10, 11].includes(d.getMonth()) ? 1.6 : d.getMonth() >= 5 && d.getMonth() <= 7 ? 0.4 : 1;
          let v;
          if (period === "hour") {
            const base = /hchc/.test(id) ? (night ? 0.9 : 0) : /hchp/.test(id) ? (night ? 0 : 0.55 + ((h >= 7 && h < 9) || (h >= 18 && h < 22) ? 0.9 : 0)) : 0.06 + 0.02 * k;
            v = base * (0.8 + Math.random() * 0.4);
          } else {
            const daily = /hchc/.test(id) ? 7.5 : /hchp/.test(id) ? 11 : 1.2 + k * 0.4;
            v = daily * winter * (0.75 + Math.random() * 0.5) * (period === "month" ? 30 : 1);
          }
          return { start: t, end: t + (step || 30 * 864e5), change: Math.round(v * 100) / 100 };
        });
      });
      return out;
    }

    async history(entityIds, hours = 24) {
      const out = {};
      const now = Date.now() / 1000;
      entityIds.forEach((id, k) => {
        const cur = this.states[id]?.state;
        if (cur !== undefined && !Number.isFinite(parseFloat(cur))) {
          // État texte (porte, présence…) : quelques changements simulés sur la journée.
          const other = { on: "off", off: "on", home: "not_home", not_home: "home" }[cur] || cur;
          out[id] = [0, 5, 9, 14, 17, 21].map((h, i) => ({ s: i % 2 ? cur : other, lu: now - hours * 3600 + h * 3600 + k * 600 }));
          return;
        }
        const base = parseFloat(cur) || 0;
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const t = now - hours * 3600 + (i * hours * 3600) / 48;
          const hour = new Date(t * 1000).getHours();
          const big = base > 100;
          const wave = Math.sin(((hour - 6) / 24) * Math.PI * 2) * (big ? base * 0.4 : 1.1);
          pts.push({ s: String((base + wave + Math.sin(i * 1.7 + k) * (big ? base * 0.2 : 0.25)).toFixed(2)), lu: t });
        }
        out[id] = pts;
      });
      return out;
    }
  }

  // Maison d'exemple pour le mode démo quand config.js est vide (installation chez quelqu'un d'autre).
  window.MAISON_DEMO_CONFIG = {
    homeName: "Maison",
    persons: [{ entity: "person.alex", name: "Alex" }, { entity: "person.sam", name: "Sam" }],
    weather: "weather.maison",
    rooms: [
      { name: "Salon", icon: "sofa-outline", temp: "sensor.salon_temperature", hum: "sensor.salon_humidite", climates: ["climate.salon"] },
      { name: "Cuisine", icon: "silverware-fork-knife", temp: "sensor.cuisine_temperature", climates: ["climate.cuisine"] },
      { name: "Chambre", icon: "bed-outline", temp: "sensor.chambre_temperature", hum: "sensor.chambre_humidite", climates: ["climate.chambre"] },
      { name: "Salle de bain", icon: "shower-head", temp: "sensor.sdb_temperature", hum: "sensor.sdb_humidite", climates: ["climate.sdb"] },
    ],
    climates: [
      { entity: "climate.salon", name: "Salon", room: "Salon" },
      { entity: "climate.cuisine", name: "Cuisine", room: "Cuisine" },
      { entity: "climate.chambre", name: "Chambre", room: "Chambre", temp: "sensor.chambre_temperature" },
      { entity: "climate.sdb", name: "Salle de bain", room: "Salle de bain", temp: "sensor.sdb_temperature" },
    ],
    lights: [
      { entity: "light.salon", name: "Plafonnier", room: "Salon", icon: "ceiling-light-outline" },
      { entity: "light.chambre", name: "Lampe de chevet", room: "Chambre", icon: "lamp-outline" },
      { entity: "light.cuisine", name: "Spots", room: "Cuisine", icon: "lightbulb-group-outline" },
    ],
    covers: [{ entity: "cover.salon", name: "Volet salon", room: "Salon" }],
    media: [{ entity: "media_player.tv", name: "Télévision", icon: "television", room: "Salon" }, { entity: "media_player.enceinte", name: "Enceinte", icon: "speaker", room: "Cuisine" }],
    vacuum: { entity: "vacuum.aspirateur", battery: "sensor.aspirateur_batterie" },
    security: {
      openings: [{ entity: "binary_sensor.porte_entree", name: "Porte d'entrée", icon: "door", room: "Salon" }],
      motion: [{ entity: "binary_sensor.mouvement_salon", name: "Mouvement salon", icon: "motion-sensor", room: "Salon" }],
    },
    energy: { power: "sensor.puissance_maison" },
  };

  window.HAConnection = HAConnection;
  window.DemoConnection = DemoConnection;
  window.HAOAuth = OAuth;
})();
