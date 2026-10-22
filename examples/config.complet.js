// Exemple complet de configuration de Nido.
//
// Tu n'as normalement besoin d'aucune configuration : Nido détecte tout seul tes pièces et tes appareils.
// Copie seulement les sections que tu veux forcer dans www/nido/config.js ; une section présente ici
// remplace la détection automatique, les sections absentes restent détectées.
// Les identifiants (entity_id) se trouvent dans Home Assistant : Paramètres → Appareils et services → Entités.
window.HOME_CONFIG = {
  // Une pièce est « en chauffe » : "any" = dès qu'un radiateur chauffe (par défaut),
  // "comfort" = seulement s'il chauffe en mode Confort (pratique avec des radiateurs à fil pilote).
  heatingRule: "any",

  // Adresse proposée sur l'écran de connexion quand l'app n'est pas servie par Home Assistant.
  defaultUrl: "https://ma-maison.duckdns.org:8123",

  persons: [
    { entity: "person.alex", name: "Alex" },
    { entity: "person.sam", name: "Sam" },
  ],

  weather: "weather.forecast_home",

  // Pièces de l'accueil : température, humidité (facultative) et radiateurs de la pièce.
  rooms: [
    { name: "Salon", icon: "sofa-outline", temp: "sensor.salon_temperature", hum: "sensor.salon_humidite", climates: ["climate.salon"] },
    { name: "Cuisine", icon: "silverware-fork-knife", temp: "sensor.cuisine_temperature", climates: ["climate.cuisine"] },
    { name: "Chambre", icon: "bed-outline", temp: "sensor.chambre_temperature", hum: "sensor.chambre_humidite" },
  ],

  // Radiateurs : `temp` sert quand le radiateur ne mesure pas lui-même la température.
  climates: [
    { entity: "climate.salon", name: "Salon", room: "Salon" },
    { entity: "climate.cuisine", name: "Cuisine", room: "Cuisine", temp: "sensor.cuisine_temperature" },
  ],
  // Modes proposés sur les cartes radiateur (seuls ceux que le radiateur accepte s'affichent).
  climatePresets: [
    { id: "eco", label: "Éco", icon: "leaf" },
    { id: "comfort", label: "Confort", icon: "sofa-single-outline" },
    { id: "frost_protection", label: "Hors-gel", icon: "snowflake" },
    { id: "auto", label: "Auto", icon: "calendar-clock" },
  ],
  schedules: ["schedule.chauffage_semaine"],
  heatingAutomations: ["automation.chauffage_matin"],

  lights: [
    { entity: "light.salon_plafonnier", name: "Plafonnier", room: "Salon", icon: "ceiling-light-outline" },
    { entity: "light.chambre_bandeau", name: "Bandeau LED", room: "Chambre", icon: "led-strip-variant" },
  ],
  covers: [
    { entity: "cover.volet_salon", name: "Salon", room: "Salon" },
  ],
  media: [
    { entity: "media_player.tv_salon", name: "TV Salon", icon: "television", room: "Salon" },
  ],

  vacuum: {
    entity: "vacuum.robot",
    battery: "sensor.robot_batterie",
    map: "camera.robot_carte", // image de la carte (ex. Xiaomi Cloud Map Extractor)
    rooms: [{ label: "Salon", script: "script.aspirer_salon", icon: "sofa-outline" }],
    selects: [{ entity: "select.robot_niveau_eau", label: "Niveau d'eau" }],
    switches: [{ entity: "switch.robot_double_passage", label: "Double passage" }],
  },

  security: {
    camera: "camera.salon",
    openings: [{ entity: "binary_sensor.porte_entree", name: "Porte d'entrée", icon: "door", room: "Entrée" }],
    motion: [{ entity: "binary_sensor.mouvement_salon", name: "Mouvement salon", icon: "motion-sensor", room: "Salon" }],
    illuminance: "sensor.salon_luminosite",
    illuminanceName: "Luminosité salon",
  },

  // Page Système : cartes facultatives (NAS Synology, box internet, chauffe-eau…).
  system: {
    nas: {
      volume: "sensor.nas_volume_1_volume_used",
      cpu: "sensor.nas_cpu_utilization_total",
      memory: "sensor.nas_memory_usage_real",
      temp: "sensor.nas_temperature",
      drives: ["sensor.nas_drive_1_status", "sensor.nas_drive_2_status"],
    },
    freebox: { down: "sensor.freebox_download_speed", up: "sensor.freebox_upload_speed", calls: "sensor.freebox_missed_calls" },
    waterHeater: { power: "sensor.chauffe_eau_puissance", energy: "sensor.chauffe_eau_energie" },
  },

  // Consommation : les prix et les appareils viennent du tableau Énergie de Home Assistant.
  // Ici, seulement la puissance en direct et, pour un compteur Linky, la période tarifaire et l'abonnement.
  energy: {
    power: "sensor.linky_puissance_apparente",
    period: "sensor.linky_periode_tarifaire",
    subscription: "sensor.linky_intensite_souscrite",
    current: "sensor.linky_intensite",
  },
};
