// Détection automatique : construit la configuration de l'app à partir des pièces (zones),
// appareils et entités de Home Assistant. Utilisée pour toutes les sections absentes de config.js.
(function () {
  "use strict";

  const domainOf = (id) => id.split(".")[0];
  const mdi = (icon) => (icon && icon.startsWith("mdi:") ? icon.slice(4) : null);
  const ROOM_ICONS = [
    [/salon|s[ée]jour|living/i, "sofa-outline"],
    [/cuisine|kitchen/i, "silverware-fork-knife"],
    [/bain|douche|bath|sdb|wc|toilette/i, "shower-head"],
    [/enfant|kid|b[ée]b[ée]|bebe/i, "teddy-bear"],
    [/chambre|bed/i, "bed-outline"],
    [/bureau|office/i, "desk"],
    [/entr[ée]e|hall/i, "door"],
    [/garage/i, "garage"],
    [/jardin|garden|ext[ée]rieur|terrasse|balcon/i, "flower-outline"],
    [/couloir|palier|escalier/i, "stairs"],
    [/buanderie|laundry|cellier/i, "washing-machine"],
    [/salle [àa] manger|dining/i, "table-chair"],
  ];

  // Registre des entités : accepte le format compact (« list_for_display ») comme le format complet.
  function normalizeEntities(raw, devices) {
    const cats = raw?.entity_categories || {};
    const list = Array.isArray(raw) ? raw : raw?.entities || [];
    const devArea = Object.fromEntries((devices || []).map((d) => [d.id, d.area_id]));
    return list
      .map((e) => {
        const id = e.ei ?? e.entity_id;
        const dev = e.di ?? e.device_id ?? null;
        const ec = e.ec !== undefined ? cats[e.ec] ?? e.ec : e.entity_category;
        return {
          entity_id: id,
          device_id: dev,
          area_id: (e.ai ?? e.area_id) || devArea[dev] || null,
          category: ec || null,
          hidden: !!(e.hb ?? e.hidden_by ?? e.hidden),
          disabled: !!e.disabled_by,
        };
      })
      .filter((e) => e.entity_id && !e.hidden && !e.disabled);
  }

  function build({ areas = [], entities = [], states = {}, energyPrefs = null }) {
    const S = (id) => states[id];
    const A = (id, k) => states[id]?.attributes?.[k];
    const name = (id) => A(id, "friendly_name") || id;
    const num = (id) => parseFloat(S(id)?.state);
    const ents = entities.filter((e) => S(e.entity_id));
    const userFacing = ents.filter((e) => !e.category);
    const byDomain = (d) => userFacing.filter((e) => domainOf(e.entity_id) === d);
    const dc = (e) => A(e.entity_id, "device_class");
    const areaName = Object.fromEntries(areas.map((a) => [a.area_id, a.name]));
    const roomOf = (e) => areaName[e.area_id] || "";
    // « Salon Plafonnier » dans la pièce Salon devient « Plafonnier ».
    const short = (e) => {
      let n = name(e.entity_id);
      const a = roomOf(e);
      if (a && n.toLowerCase().startsWith(a.toLowerCase() + " ") && n.length > a.length + 1) {
        n = n.slice(a.length + 1);
        n = n.charAt(0).toUpperCase() + n.slice(1);
      }
      return n;
    };
    const best = (list, score) => [...list].sort((a, b) => score(b) - score(a))[0];
    const sensorsIn = (areaId, cls) => userFacing.filter((e) => domainOf(e.entity_id) === "sensor" && e.area_id === areaId && dc(e) === cls && Number.isFinite(num(e.entity_id)));
    const deviceHas = (devId, cls) => !!devId && userFacing.some((e) => e.device_id === devId && dc(e) === cls);
    const cfg = {};

    cfg.persons = Object.keys(states).filter((id) => id.startsWith("person.")).map((id) => ({ entity: id, name: name(id) }));
    const weathers = Object.keys(states).filter((id) => id.startsWith("weather."));
    cfg.weather = weathers.includes("weather.forecast_home") ? "weather.forecast_home" : weathers[0] || null;

    // Pièces : toute zone qui a un capteur de température ou un radiateur / thermostat.
    const climateEnts = byDomain("climate");
    cfg.rooms = [];
    for (const a of areas) {
      // Un vrai capteur d'ambiance mesure souvent aussi l'humidité : on le préfère.
      const temp = best(sensorsIn(a.area_id, "temperature"), (e) => (deviceHas(e.device_id, "humidity") ? 2 : 0) + (A(e.entity_id, "state_class") === "measurement" ? 1 : 0));
      const humSame = temp && userFacing.find((e) => e.device_id === temp.device_id && dc(e) === "humidity");
      const hum = humSame || sensorsIn(a.area_id, "humidity")[0];
      const climates = climateEnts.filter((e) => e.area_id === a.area_id).map((e) => e.entity_id);
      if (!temp && !climates.length) continue;
      const icon = mdi(a.icon) || (ROOM_ICONS.find(([re]) => re.test(a.name)) || [null, "door-open"])[1];
      cfg.rooms.push({ name: a.name, icon, temp: temp?.entity_id, hum: hum?.entity_id, climates });
    }

    cfg.climates = climateEnts.map((e) => {
      const room = cfg.rooms.find((r) => r.climates.includes(e.entity_id));
      return { entity: e.entity_id, name: short(e), room: roomOf(e), temp: A(e.entity_id, "current_temperature") == null ? room?.temp : undefined };
    });

    // Les groupes de lumières (qui listent d'autres lumières) sont ignorés pour éviter les doublons.
    cfg.lights = byDomain("light").filter((e) => !Array.isArray(A(e.entity_id, "entity_id")))
      .map((e) => ({ entity: e.entity_id, name: short(e), room: roomOf(e), icon: mdi(A(e.entity_id, "icon")) || "lightbulb-outline" }));
    cfg.covers = byDomain("cover").map((e) => ({ entity: e.entity_id, name: short(e), room: roomOf(e) }));
    cfg.media = byDomain("media_player").map((e) => ({
      entity: e.entity_id, name: short(e), room: roomOf(e),
      icon: dc(e) === "tv" ? "television" : dc(e) === "speaker" ? "speaker" : "cast",
    }));

    const vac = byDomain("vacuum")[0];
    if (vac) {
      const bat = ents.find((e) => e.device_id && e.device_id === vac.device_id && dc(e) === "battery" && domainOf(e.entity_id) === "sensor");
      cfg.vacuum = { entity: vac.entity_id, battery: bat?.entity_id };
    }

    const bin = byDomain("binary_sensor");
    const cams = byDomain("camera").filter((e) => !/map/i.test(e.entity_id));
    cfg.security = {
      camera: cams[0]?.entity_id || null,
      openings: bin.filter((e) => ["door", "window", "garage_door", "opening"].includes(dc(e)))
        .map((e) => ({ entity: e.entity_id, name: name(e.entity_id), icon: dc(e) === "window" ? "window-closed-variant" : "door", room: roomOf(e) })),
      motion: bin.filter((e) => ["motion", "occupancy", "presence"].includes(dc(e)))
        .map((e) => ({ entity: e.entity_id, name: name(e.entity_id), icon: "motion-sensor", room: roomOf(e) })),
    };
    const lux = userFacing.find((e) => domainOf(e.entity_id) === "sensor" && dc(e) === "illuminance");
    if (lux) { cfg.security.illuminance = lux.entity_id; cfg.security.illuminanceName = name(lux.entity_id); }

    cfg.schedules = Object.keys(states).filter((id) => id.startsWith("schedule."));
    cfg.heatingAutomations = Object.keys(states).filter((id) => id.startsWith("automation.") && /chauff|radiat|thermo|heat/i.test(name(id)));

    // Puissance en direct : un capteur de puissance sur le même appareil que le compteur du tableau Énergie.
    cfg.energy = {};
    const gridStats = [];
    (energyPrefs?.energy_sources || []).filter((x) => x.type === "grid").forEach((g) => (g.flow_from || [g]).forEach((f) => f.stat_energy_from && gridStats.push(f.stat_energy_from)));
    const meterDevices = new Set(gridStats.map((id) => ents.find((e) => e.entity_id === id)?.device_id).filter(Boolean));
    const power = ents.find((e) => meterDevices.has(e.device_id) && ["power", "apparent_power"].includes(dc(e)));
    if (power) cfg.energy.power = power.entity_id;
    return cfg;
  }

  window.MaisonDiscovery = { normalizeEntities, build };
})();
