/* Iconos de dispositivo · versión bulletproof
   - Inyecta su propio CSS (no depende de extensions.css)
   - Reemplaza los SVG rotos con estilos inline
   - Procesa los 5 tipos: windows, mac, iphone, android, pending */
(() => {
  const log = (...a) => console.log("[device-icons]", ...a);

  /* ═══════════════════════════════════════════════════════════════
     1) INYECTAR CSS
     ═══════════════════════════════════════════════════════════════ */
  if (!document.getElementById("device-icons-css")) {
    const s = document.createElement("style");
    s.id = "device-icons-css";
    s.textContent = `
      .user-table .device[data-device="Mac" i]         { --device-color: #a48dbd !important; }
      .user-table .device[data-device="macOS" i]       { --device-color: #a48dbd !important; }
      .user-table .device[data-device="OSX" i]         { --device-color: #a48dbd !important; }
      .user-table .device[data-device="iPhone" i]      { --device-color: #8c96ad !important; }
      .user-table .device[data-device="iPad" i]        { --device-color: #8c96ad !important; }
      .user-table .device[data-device="Android" i]     { --device-color: #51b987 !important; }
      .user-table .device[data-device="Tablet" i]      { --device-color: #51b987 !important; }
      .user-table .device[data-device="Windows" i]     { --device-color: #499bd8 !important; }
      .user-table .device[data-device="Pendiente" i]   { --device-color: var(--muted) !important; }
      .user-table .device[data-device="Por detectar" i]{ --device-color: var(--muted) !important; }
      .user-table .device-mark                         { color: var(--device-color, var(--muted)) !important; }
    `;
    document.head.appendChild(s);
  }

  /* ═══════════════════════════════════════════════════════════════
     2) ICONOS SVG (paths + color)
     ═══════════════════════════════════════════════════════════════ */
  const ICONS = {
    windows: {
      inner: `<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>`,
      color: "#499bd8",
    },
    mac: {
      inner: `<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 19h20"/><path d="M2 19l1.5 2h17l1.5-2"/>`,
      color: "#a48dbd",
    },
    iphone: {
      inner: `<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4"/><circle cx="12" cy="18" r="1" fill="currentColor"/>`,
      color: "#8c96ad",
    },
    android: {
      inner: `<path d="M5 13h14a7 7 0 0 0-14 0Z"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/><path d="m7 5 1.5 2"/><path d="m17 5-1.5 2"/><circle cx="9" cy="10" r=".7" fill="currentColor"/><circle cx="15" cy="10" r=".7" fill="currentColor"/>`,
      color: "#51b987",
    },
    pending: {
      inner: `<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><circle cx="12" cy="18" r=".9" fill="currentColor"/>`,
      color: "#888",
    },
  };

  /* Todos los tipos en FIXABLE — la comparación evita reemplazos innecesarios */
  const FIXABLE = new Set(["windows", "mac", "iphone", "android", "pending"]);

  /* ═══════════════════════════════════════════════════════════════
     3) NORMALIZACIÓN
     ═══════════════════════════════════════════════════════════════ */
  function normalize(raw) {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return "pending";
    if (/iphone|ipad|ipod|ios|apple ?phone/i.test(s)) return "iphone";
    if (/android|samsung|xiaomi|huawei|oneplus|pixel|motorola|redmi|oppo|vivo|realme|nokia|tablet/i.test(s)) return "android";
    if (/windows|win32|win64|winnt|win ?phone/i.test(s)) return "windows";
    if (/mac|macos|osx|apple ?computer|macbook/i.test(s)) return "mac";
    return "pending";
  }

  /* ═══════════════════════════════════════════════════════════════
     4) DETECTAR SVG ROTO
     ═══════════════════════════════════════════════════════════════ */
  function isBrokenSvg(svg) {
    if (!svg) return true;
    // "?" del panel: rect con borde punteado o path del signo de interrogación
    if (svg.querySelector("rect[stroke-dasharray]")) return true;
    if (svg.querySelector('path[d*="a2 2 0 1 1 3.5"]')) return true;
    // Si ya tiene stroke con color, asumir que está bien
    const stroke = svg.getAttribute("stroke");
    if (stroke && stroke !== "none") return false;
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════
     5) FIX DE UN ELEMENTO
     ═══════════════════════════════════════════════════════════════ */
  function fixDevice(el) {
    if (!el || !el.classList || !el.classList.contains("device")) return false;

    const kind = normalize(el.getAttribute("data-device"));
    if (!FIXABLE.has(kind)) return false;

    const mark = el.querySelector(".device-mark");
    if (!mark) return false;

    const icon = ICONS[kind];
    const svg = mark.querySelector("svg");

    // No hay SVG → crear uno con estilos inline
    if (!svg) {
      const newSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      newSvg.setAttribute("viewBox", "0 0 24 24");
      newSvg.setAttribute("fill", "none");
      newSvg.setAttribute("stroke", icon.color);
      newSvg.setAttribute("stroke-width", "1.7");
      newSvg.setAttribute("stroke-linecap", "round");
      newSvg.setAttribute("stroke-linejoin", "round");
      newSvg.setAttribute("aria-hidden", "true");
      newSvg.style.cssText = `width:20px;height:20px;display:block !important;color:${icon.color};`;
      newSvg.innerHTML = icon.inner;
      mark.appendChild(newSvg);
      return true;
    }

    // SVG roto → reemplazar contenido + forzar color inline
    if (isBrokenSvg(svg)) {
      svg.innerHTML = icon.inner;
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", icon.color);
      svg.setAttribute("stroke-width", "1.7");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.style.color = icon.color;
      svg.style.stroke = icon.color;
      svg.style.display = "block";
      return true;
    }

    return false;
  }

  /* ═══════════════════════════════════════════════════════════════
     6) APLICAR A TODOS
     ═══════════════════════════════════════════════════════════════ */
  function fixAll() {
    let n = 0;
    document.querySelectorAll(".device[data-device]").forEach((el) => {
      if (fixDevice(el)) n++;
    });
    if (n > 0) log(`✓ ${n} icono${n === 1 ? "" : "s"} corregido${n === 1 ? "" : "s"}`);
    return n;
  }

  /* ═══════════════════════════════════════════════════════════════
     7) OBSERVER
     ═══════════════════════════════════════════════════════════════ */
  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(fixAll, 50);
  }

  function observe() {
    const tbody = document.getElementById("userRows");
    if (!tbody || tbody.dataset.deviceObs === "1") return;
    tbody.dataset.deviceObs = "1";
    new MutationObserver(schedule).observe(tbody, { childList: true, subtree: true });
  }

  /* ═══════════════════════════════════════════════════════════════
     8) BOOT
     ═══════════════════════════════════════════════════════════════ */
  function boot() {
    fixAll();
    observe();
    [100, 300, 800, 1500, 3000, 5000].forEach((t) => setTimeout(fixAll, t));
    setInterval(fixAll, 3000);

    document.getElementById("tabs")?.addEventListener("click", (e) => {
      if (!e.target.closest(".tab[data-license]")) return;
      [50, 150, 500, 1000, 2000].forEach((t) => setTimeout(fixAll, t));
      setTimeout(observe, 2000);
    });

    log("módulo listo · CSS inyectado + SVG inline");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ═══════════════════════════════════════════════════════════════
     9) DEBUG API
     ═══════════════════════════════════════════════════════════════ */
  window.fixDeviceIcons = {
    fixAll,
    fixOne: fixDevice,
    normalize,
    diagnose() {
      console.table([...document.querySelectorAll(".device[data-device]")].map((el) => {
        const raw = el.getAttribute("data-device") || "";
        const kind = normalize(raw);
        const mark = el.querySelector(".device-mark");
        const svg = mark?.querySelector("svg");
        return {
          raw,
          kind,
          fixable: FIXABLE.has(kind),
          hasSvg: !!svg,
          broken: isBrokenSvg(svg),
          strokeColor: svg?.getAttribute("stroke") || "(none)",
          inlineColor: svg?.style.color || "(none)",
        };
      }));
    },
  };
})();
