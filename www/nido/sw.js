// Service worker : lancement instantané et fonctionnement hors ligne de la coque de l'app.
// Les fichiers de l'app sont toujours revalidés auprès du serveur (le cache /local/ de HA dure 31 jours),
// et la copie locale ne sert que si le réseau est indisponible.
const VERSION = "nido-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./ha.js",
  "./discovery.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];
const RUNTIME_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);

  // Fichiers de l'app : réseau d'abord (revalidé), copie locale en secours.
  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)) {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req.mode === "navigate" ? "./index.html" : new Request(url.pathname), copy));
          }
          return res;
        })
        .catch(() => caches.match(req.mode === "navigate" ? "./index.html" : new Request(url.pathname)).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Polices et icônes : cache d'abord.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
  // Tout le reste (API Home Assistant, caméra, connexion) passe directement au réseau.
});
