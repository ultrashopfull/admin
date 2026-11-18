/* UltraShop — service worker de la PWA.
   Estrategia:
   - Navegación: red primero y copia local (index.html) como respaldo sin conexión.
   - Recursos del panel: caché primero. Los archivos llevan ?v=hash, así que una
     versión nueva siempre pide una URL nueva y no se queda atascada.
   - Las llamadas a Supabase (*.supabase.co) nunca se interceptan ni se guardan. */
const CACHE = "ultrashop-shell-v1";
const CACHE_PREFIX = "ultrashop-";
const OFFLINE_FALLBACK = "./index.html";
const EXTRA_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./logo.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function absolute(url) {
  return new URL(url, self.registration.scope).href;
}

async function readIndexAssets(indexUrl) {
  const response = await fetch(indexUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("No se pudo leer index.html");
  // Clonar antes de leer el cuerpo: cache.put() necesita una respuesta viva.
  const cacheCopy = response.clone();
  const html = await response.text();
  const found = new Set(EXTRA_ASSETS.map(absolute));
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:")) continue;
    let url;
    try {
      url = new URL(raw, indexUrl);
    } catch {
      continue;
    }
    if (!sameOrigin(url) || !/^https?:$/.test(url.protocol)) continue;
    // El lector OCR y los recursos grandes se guardan solo cuando se usan.
    if (url.pathname.includes("/vendor/")) continue;
    if (url.pathname.endsWith("/sw.js")) continue;
    found.add(url.href);
  }
  return { response: cacheCopy, urls: [...found] };
}

async function precache() {
  const cache = await caches.open(CACHE);
  const indexUrl = absolute(OFFLINE_FALLBACK);
  try {
    const { response, urls } = await readIndexAssets(indexUrl);
    await cache.put(OFFLINE_FALLBACK, response.clone());
    await Promise.allSettled(
      urls.map(async (url) => {
        if (url === indexUrl) return;
        try {
          const cached = await cache.match(url);
          if (cached) return;
          const res = await fetch(url, { cache: "reload" });
          if (res && (res.ok || res.type === "opaque")) await cache.put(url, res);
        } catch {
          /* Un recurso ausente no debe impedir la instalación de la app. */
        }
      })
    );
  } catch {
    // Sin red durante la instalación: conservamos lo que ya estuviera cacheado.
    await Promise.allSettled(
      EXTRA_ASSETS.map(async (asset) => {
        try {
          if (!(await cache.match(asset))) await cache.add(asset);
        } catch {}
      })
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const shellPath = new URL(absolute(OFFLINE_FALLBACK)).pathname;
  const requestPath = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // Solo la propia página del panel reemplaza la copia sin conexión.
      if (requestPath === shellPath || requestPath.endsWith("/"))
        cache.put(OFFLINE_FALLBACK, response.clone()).catch(() => {});
      return response;
    }
    // Un 304 o un error del servidor/proxy no deben dejar una página en blanco:
    // si hay copia local, se usa. Solo se devuelve el error si no hay caché.
    const cached =
      (await cache.match(request)) || (await cache.match(OFFLINE_FALLBACK));
    if (cached) return cached;
    if (response && response.status !== 304) return response;
  } catch {
    const cached =
      (await cache.match(request)) || (await cache.match(OFFLINE_FALLBACK));
    if (cached) return cached;
  }
  return new Response("Sin conexión. Vuelve a abrir UltraShop cuando tengas internet.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === "opaque")) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response("", { status: 504, statusText: "Sin conexión" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!sameOrigin(url) || !/^https?:$/.test(url.protocol)) return;
  if (url.pathname.endsWith("/sw.js")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

self.addEventListener("message", (event) => {
  const action = event.data?.action;
  if (action === "SKIP_WAITING") self.skipWaiting();
  if (action === "CLEAR_CACHES") {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key))))
    );
  }
});
