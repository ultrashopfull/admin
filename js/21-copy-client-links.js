/* Botón maestro: copiar enlaces (chats/proyectos/cuadernos) de cada cliente */
(() => {
  const BTN_ID  = "copyClientLinksBtn";
  const MENU_ID = "copyClientLinksMenu";
  const WRAP_ID = "copyClientLinksWrap";

  const log = (...a) => console.log("[copy-client-links]", ...a);
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };

  /* ═══════════ Datos base ═══════════ */
  function getLicense() {
    return safe(() => current, null);
  }

  function getUsers(license) {
    return safe(() => Array.isArray(datasets[license]) ? datasets[license] : [], []);
  }

  async function getUserLinks(username) {
    if (!username) return [];
    try {
      const res = await sbApi("listar_enlaces_cliente", "GET", null, { username });
      return Array.isArray(res.enlaces) ? res.enlaces : [];
    } catch (err) {
      log("error al cargar enlaces de", username, err.message);
      return [];
    }
  }

  /* Carga en paralelo con límite de 5 concurrentes para no saturar */
  async function loadAllLinks(users) {
    const result = new Map();
    const queue = users.slice();
    const workers = Array.from({ length: Math.min(5, queue.length || 1) }, async () => {
      while (queue.length) {
        const u = queue.shift();
        if (!u) break;
        const username = String(u.email || u.usuario || "").trim();
        if (!username) continue;
        const links = await getUserLinks(username);
        result.set(username, { user: u, links });
      }
    });
    await Promise.all(workers);
    return result;
  }

  /* ═══════════ Formateo ═══════════ */
  const TYPE_LABELS = {
    chats: "Chats",
    chat: "Chats",
    proyectos: "Proyectos",
    proyecto: "Proyectos",
    cuadernos: "Cuadernos",
    cuaderno: "Cuadernos",
    notebook: "Cuadernos",
    notebooklm: "Cuadernos",
    resources: "Recursos",
    recurso: "Recursos",
  };

  const TYPE_EMOJI = {
    chats: "💬", chat: "💬",
    proyectos: "📁", proyecto: "📁",
    cuadernos: "📓", cuaderno: "📓",
    notebook: "📓", notebooklm: "📓",
    resources: "📎", recurso: "📎",
  };

  function typeLabel(tipo) {
    const key = String(tipo || "").toLowerCase().trim();
    return TYPE_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Otros");
  }

  function typeEmoji(tipo) {
    const key = String(tipo || "").toLowerCase().trim();
    return TYPE_EMOJI[key] || "🔗";
  }

  /* Agrupa los enlaces de un cliente por tipo */
  function groupByType(links) {
    const map = new Map();
    for (const l of links) {
      const tipo = String(l.tipo || "otros").toLowerCase();
      if (!map.has(tipo)) map.set(tipo, []);
      map.get(tipo).push(l);
    }
    return map;
  }

  /* ── Formato A: por cliente, luego por tipo ── */
  function buildByClient(license, entries) {
    const lines = [`📋 ${license} · Enlaces de clientes\n`];

    let totalLinks = 0, clientsWithLinks = 0;

    for (const [username, { user, links }] of entries) {
      if (!links.length) continue;
      clientsWithLinks++;
      const grouped = groupByType(links);
      const count = links.length;
      totalLinks += count;

      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`👤 ${username} · ${count} enlace${count === 1 ? "" : "s"}`);
      lines.push(``);

      for (const [tipo, list] of grouped) {
        lines.push(`${typeEmoji(tipo)} ${typeLabel(tipo)} (${list.length}):`);
        for (const l of list) {
          const url = l.resource_url || "";
          const title = l.title ? ` — ${l.title}` : "";
          lines.push(`   • ${url}${title}`);
        }
        lines.push(``);
      }
    }

    if (!totalLinks) {
      lines.push(`⚠️ Ningún cliente de ${license} tiene enlaces guardados.`);
      lines.push(`   Los enlaces se añaden desde el botón 🔗 de cada cliente.`);
      return { text: lines.join("\n"), count: 0, clients: 0 };
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`✅ Total: ${totalLinks} enlace${totalLinks === 1 ? "" : "s"} de ${clientsWithLinks} cliente${clientsWithLinks === 1 ? "" : "s"}`);

    return { text: lines.join("\n"), count: totalLinks, clients: clientsWithLinks };
  }

  /* ── Formato B: por tipo, luego por cliente ── */
  function buildByType(license, entries) {
    const byType = new Map();

    for (const [username, { links }] of entries) {
      for (const l of links) {
        const tipo = String(l.tipo || "otros").toLowerCase();
        if (!byType.has(tipo)) byType.set(tipo, []);
        byType.get(tipo).push({ username, link: l });
      }
    }

    const lines = [`📋 ${license} · Enlaces agrupados por tipo\n`];

    let totalLinks = 0;

    for (const [tipo, items] of byType) {
      totalLinks += items.length;
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`${typeEmoji(tipo)} ${typeLabel(tipo)} · ${items.length} enlace${items.length === 1 ? "" : "s"}`);
      lines.push(``);

      for (const { username, link } of items) {
        const url = link.resource_url || "";
        const title = link.title ? ` — ${link.title}` : "";
        lines.push(`• ${username}`);
        lines.push(`  ${url}${title}`);
      }
      lines.push(``);
    }

    if (!totalLinks) {
      lines.push(`⚠️ No hay enlaces guardados en ${license}.`);
      return { text: lines.join("\n"), count: 0, clients: 0 };
    }

    const clients = new Set(entries.keys()).size;
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`✅ Total: ${totalLinks} enlace${totalLinks === 1 ? "" : "s"}`);

    return { text: lines.join("\n"), count: totalLinks, clients };
  }

  /* ── Formato C: solo URLs (plano) ── */
  function buildUrlsOnly(license, entries) {
    const urls = [];
    for (const [username, { links }] of entries) {
      for (const l of links) {
        if (l.resource_url) urls.push(l.resource_url);
      }
    }
    return {
      text: urls.join("\n"),
      count: urls.length,
      clients: new Set(entries.keys()).size,
    };
  }

  /* ── Formato D: URLs agrupadas por cliente ── */
  function buildUrlsByClient(license, entries) {
    const lines = [];
    let total = 0;

    for (const [username, { links }] of entries) {
      if (!links.length) continue;
      const urls = links.map(l => l.resource_url).filter(Boolean);
      if (!urls.length) continue;
      total += urls.length;
      lines.push(`${username}:`);
      for (const u of urls) lines.push(u);
      lines.push(``);
    }

    return {
      text: lines.join("\n"),
      count: total,
      clients: new Set(entries.keys()).size,
    };
  }

  /* ═══════════ Portapapeles ═══════════ */
  async function copyToClipboard(text) {
    if (typeof copyText === "function") {
      try { await copyText(text); return true; } catch {}
    }
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function toastSafe(msg, kind) {
    if (typeof toast === "function") toast(msg, kind);
    else log(msg);
  }

  /* ═══════════ Botón y menú ═══════════ */
  function ensureButton() {
    if (document.getElementById(BTN_ID)) return document.getElementById(WRAP_ID);

    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.className = "copy-links-wrap";
    wrap.innerHTML = `
      <button type="button" class="copy-links-btn admin-action" id="${BTN_ID}" title="Copiar enlaces de los clientes de esta licencia" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5"/>
          <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5"/>
        </svg>
        <span>Enlaces</span>
        <svg class="copy-links-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="copy-links-menu" id="${MENU_ID}" role="menu" hidden>
        <div class="copy-links-header">Enlaces de clientes · <strong id="copyLinksLicense">—</strong></div>
        <button type="button" data-mode="client" role="menuitem">
          <span>
            <b>Por cliente</b>
            <small>Agrupados por cliente y tipo</small>
          </span>
          <small>📋</small>
        </button>
        <button type="button" data-mode="type" role="menuitem">
          <span>
            <b>Por tipo</b>
            <small>Chats · Proyectos · Cuadernos</small>
          </span>
          <small>🗂</small>
        </button>
        <div class="copy-links-sep"></div>
        <button type="button" data-mode="urls-client" role="menuitem">
          <span>
            <b>Solo URLs (por cliente)</b>
            <small>Formato compacto: usuario + urls</small>
          </span>
          <small>🔗</small>
        </button>
        <button type="button" data-mode="urls-only" role="menuitem">
          <span>
            <b>Solo URLs (planas)</b>
            <small>Una URL por línea, sin agrupar</small>
          </span>
          <small>#</small>
        </button>
      </div>
    `;

    const toolbar = document.querySelector(".toolbar-right") || document.querySelector(".toolbar");
    const createBtn = document.getElementById("createUserBtn");
    if (createBtn && createBtn.parentNode) createBtn.before(wrap);
    else if (toolbar) toolbar.appendChild(wrap);

    const btn = wrap.querySelector(`#${BTN_ID}`);
    const menu = wrap.querySelector(`#${MENU_ID}`);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) {
        const lic = getLicense();
        const label = menu.querySelector("#copyLinksLicense");
        if (label) label.textContent = lic || "—";
      }
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });

    menu.addEventListener("click", async (e) => {
      const item = e.target.closest("[data-mode]");
      if (!item) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      await handleAction(item.dataset.mode);
    });

    return wrap;
  }

  /* ═══════════ Acción principal ═══════════ */
  async function handleAction(mode) {
    if (typeof isAdmin === "function" && !isAdmin()) {
      toastSafe("Solo administradores", "error");
      return;
    }

    const license = getLicense();
    if (!license) { toastSafe("Sin licencia activa", "error"); return; }

    const users = getUsers(license);
    if (!users.length) {
      toastSafe(`No hay clientes en ${license}`);
      return;
    }

    const btn = document.getElementById(BTN_ID);
    if (btn) btn.disabled = true;
    toastSafe(`Cargando enlaces de ${users.length} cliente${users.length === 1 ? "" : "s"}…`);

    try {
      const entries = await loadAllLinks(users);

      let result;
      if (mode === "client")       result = buildByClient(license, entries);
      else if (mode === "type")    result = buildByType(license, entries);
      else if (mode === "urls-client") result = buildUrlsByClient(license, entries);
      else if (mode === "urls-only")   result = buildUrlsOnly(license, entries);
      else return;

      if (!result.count) {
        toastSafe(`Ningún cliente de ${license} tiene enlaces guardados`);
        return;
      }

      const ok = await copyToClipboard(result.text);
      if (ok) {
        toastSafe(`✓ ${result.count} enlace${result.count === 1 ? "" : "s"} copiado${result.count === 1 ? "" : "s"}`, "success");
      } else {
        toastSafe("No se pudo copiar. Revisa los permisos del portapapeles.", "error");
      }
    } catch (err) {
      console.error("[copy-client-links]", err);
      toastSafe("Error: " + err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ═══════════ Ciclo de vida ═══════════ */
  let attempts = 0;
  function boot() {
    const toolbar = document.querySelector(".toolbar-right");
    const tabs = document.getElementById("tabs");
    if (!toolbar || !tabs) {
      if (++attempts < 30) return setTimeout(boot, 200);
      log("Toolbar no encontrado");
      return;
    }
    ensureButton();
    log("Botón 'Enlaces' listo");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* Debug API: window.copyClientLinks.run("client") */
  window.copyClientLinks = {
    run: handleAction,
    async preview(mode = "client") {
      const license = getLicense();
      const users = getUsers(license);
      const entries = await loadAllLinks(users);
      let result;
      if (mode === "client") result = buildByClient(license, entries);
      else if (mode === "type") result = buildByType(license, entries);
      else if (mode === "urls-client") result = buildUrlsByClient(license, entries);
      else if (mode === "urls-only") result = buildUrlsOnly(license, entries);
      console.log(result?.text);
      return result;
    }
  };
})();
