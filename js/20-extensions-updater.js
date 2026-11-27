/* Gestor de actualizaciones · ZIP (PC) + CRX (Móvil) */
(() => {
  const BUCKET = "extensions";
  const MAX_BYTES = 5 * 1024 * 1024;

  const EXTENSIONS = [
    { key: "chatgpt",     label: "ChatGPT",     color: "#10a37f" },
    { key: "gemini",      label: "Gemini",      color: "#4285f4" },
    { key: "capcut",      label: "CapCut",      color: "#30343b" },
    { key: "claude",      label: "Claude",      color: "#c7684f" },
    { key: "perplexity",  label: "Perplexity",  color: "#1f8291" },
    { key: "superprompt", label: "Superprompt", color: "#e09b3c" },
    { key: "codex",       label: "Codex",       color: "#7667df" },
  ];

  const KINDS = [
    { key: "zip", label: "ZIP · PC",    accept: ".zip,application/zip" },
    { key: "crx", label: "CRX · Móvil", accept: ".crx,application/x-chrome-extension" },
  ];

  /* Iconos SVG por formato (sin emojis) */
  const KIND_ICONS = {
    zip: `<svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <path d="M8 21h8M12 17v4"/>
          </svg>`,
    crx: `<svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="2" width="12" height="20" rx="2"/>
            <path d="M12 18h.01"/>
          </svg>`,
  };

  let cache = {};              // { chatgpt: { zip: {…}, crx: {…} } }
  let busy = false;
  let pendingReplace = null;   // { ext, kind, file }

  const log = (...a) => console.log("[extensions]", ...a);
  const warn = (...a) => console.warn("[extensions]", ...a);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtBytes = (n) => {
    if (!n) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("es-BO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
    } catch { return iso; }
  };
  const labelOf = (key) => EXTENSIONS.find((e) => e.key === key)?.label || key;

  function canManageUpdates() {
    return typeof isAdmin === "function" && isAdmin() && document.querySelector("#app")?.hidden === false;
  }
  function requireAdmin() {
    if (!canManageUpdates()) throw new Error("Solo los administradores pueden gestionar actualizaciones.");
  }
  function syncRole() {
    if (!canManageUpdates()) {
      document.getElementById("menuUpdates")?.remove();
      for (const id of ["updatesStandaloneBackdrop", "updateReplaceBackdrop"]) {
        const modal = document.getElementById(id);
        if (modal) modal.hidden = true;
      }
      cache = {}; pendingReplace = null;
      document.getElementById("updatesSection")?.remove();
      return;
    }
    addMenuEntry();
  }
  /* ═══════════ API ═══════════ */
  async function apiList() {
    requireAdmin();
    const res = await sbApi("extensions.list", "GET");
    const files = Array.isArray(res.files) ? res.files : [];
    cache = {};
    for (const f of files) {
      const name = String(f.name || "");
      const dot = name.lastIndexOf(".");
      if (dot < 0) continue;
      const base = name.slice(0, dot).toLowerCase();
      const ext = name.slice(dot + 1).toLowerCase();
      if (!KINDS.some((k) => k.key === ext)) continue;
      if (!cache[base]) cache[base] = {};
      cache[base][ext] = f;
    }
    log("lista:", Object.keys(cache).length, "extensiones");
    return cache;
  }
  async function apiDelete(ext, kind) {
    requireAdmin();
    return sbApi("extensions.delete", "POST", { extension: ext, kind });
  }

  /* ═══════════ Upload con progreso (XHR) ═══════════ */
  function getEndpoint() {
    let api = "", token = "";
    try { api = (typeof SUPABASE_API !== "undefined" && SUPABASE_API) || ""; } catch {}
    try { token = (typeof SUPABASE_TOKEN !== "undefined" && SUPABASE_TOKEN) || ""; } catch {}
    if (!token) token = window.sbGetStaffToken?.() || "";
    if (!api) {
      const base = (window.PANEL_CONFIG?.supabaseUrl || "").trim().replace(/\/+$/, "");
      api = base.endsWith("/functions/v1") ? base : base + "/functions/v1";
      if (api.endsWith("/admin")) api = api.slice(0, -6);
    }
    return { api, token };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
      reader.readAsDataURL(file);
    });
  }

  function uploadWithProgress(ext, kind, file, base64, onProgress) {
    if (!canManageUpdates()) return Promise.reject(new Error("Acceso reservado al administrador"));
    const { api, token } = getEndpoint();
    if (!api) return Promise.reject(new Error("URL de Supabase no disponible"));
    if (!token) return Promise.reject(new Error("Sesión expirada. Vuelve a iniciar sesión."));

    const url = api + "/admin?accion=" + encodeURIComponent("extensions.upload");
    const body = JSON.stringify({
      extension: ext,
      kind,
      filename: file.name,
      size: file.size,
      contentType: kind === "crx" ? "application/x-chrome-extension" : "application/zip",
      data: base64,
    });
    log(`POST → ${ext}.${kind} (${fmtBytes(body.length)})`);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.setRequestHeader("Authorization", token);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 120000;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && typeof onProgress === "function") {
          try { onProgress(e.loaded / e.total); } catch {}
        }
      };
      xhr.onload = () => {
        let data;
        try { data = JSON.parse(xhr.responseText); }
        catch { return reject(new Error("Respuesta inválida del servidor")); }
        if (xhr.status >= 200 && xhr.status < 300 && data.success !== false) resolve(data);
        else {
          const err = new Error(data.mensaje || `Error ${xhr.status}`);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error("Error de conexión"));
      xhr.ontimeout = () => reject(new Error("Tiempo de espera agotado"));
      xhr.onabort = () => reject(new Error("Subida cancelada"));
      xhr.send(body);
    });
  }

  /* ═══════════ Menú ═══════════ */
  function addMenuEntry() {
    if (!canManageUpdates()) return;
    const menu = document.getElementById("profileMenu");
    if (!menu || menu.querySelector("#menuUpdates")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "menuUpdates";
    btn.innerHTML = `
      <span class="menu-symbol">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/>
        </svg>
      </span>
      Actualizaciones`;
    btn.addEventListener("click", openUpdatesModal);
    const sep = menu.querySelector(".menu-separator");
    if (sep) sep.before(btn); else menu.appendChild(btn);
    log("entrada de menú añadida");
  }

  /* ═══════════ Modal ═══════════ */
  function ensureStandaloneModal() {
    let m = document.getElementById("updatesStandaloneBackdrop");
    if (m) return m;
    m = document.createElement("div");
    m.id = "updatesStandaloneBackdrop";
    m.className = "modal-backdrop";
    m.hidden = true;
    m.innerHTML = `
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="updatesModalTitle">
        <header class="dialog-head">
          <div><h2 id="updatesModalTitle">Actualizaciones de extensión</h2></div>
          <button type="button" class="close-btn" aria-label="Cerrar" data-close-updates>×</button>
        </header>
        <div id="updatesModalBody"></div>
      </section>
    `;
    document.body.appendChild(m);
    const close = () => { m.hidden = true; };
    m.querySelectorAll("[data-close-updates]").forEach((b) => b.addEventListener("click", close));
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    return m;
  }

  function openUpdatesModal() {
    if (!canManageUpdates()) return;
    document.getElementById("profileMenu")?.setAttribute("hidden", "");
    document.getElementById("profileMenuBtn")?.setAttribute("aria-expanded", "false");
    const modal = ensureStandaloneModal();
    const body = modal.querySelector("#updatesModalBody");
    let section = document.getElementById("updatesSection");
    if (!section) section = buildSection();
    if (section.parentNode !== body) body.appendChild(section);
    modal.hidden = false;
    refresh();
  }

  /* ═══════════ Sección ═══════════ */
  function buildSection() {
    let s = document.getElementById("updatesSection");
    if (s) return s;
    s = document.createElement("section");
    s.id = "updatesSection";
    s.className = "updates-section";
    s.innerHTML = `
      <div class="updates-head">
        <div>
          <h3>Extensiones en el bucket</h3>
          <p>Bucket público <code>${BUCKET}</code> · ZIP para PC, CRX para móvil. Reemplazar sobrescribe la versión anterior.</p>
        </div>
        <button type="button" class="updates-refresh" id="updatesRefreshBtn">↻ Actualizar</button>
      </div>
      <div id="updatesGrid" class="updates-grid"></div>
    `;
    s.querySelector("#updatesRefreshBtn").addEventListener("click", () => refresh(true));
    return s;
  }

  /* ═══════════ Render ═══════════ */
  function renderGrid() {
    const grid = document.getElementById("updatesGrid");
    if (!grid) return;
    grid.innerHTML = EXTENSIONS.map(({ key, label, color }) => {
      const files = cache[key] || {};
      const installed = KINDS.filter((k) => files[k.key]).length;
      const badge = installed === 2
        ? `<span class="update-badge update-ok">2/2 instalados</span>`
        : installed === 1
          ? `<span class="update-badge update-partial">1/2 instalados</span>`
          : `<span class="update-badge update-missing">Sin versión</span>`;
      return `
        <article class="update-card" data-ext="${key}" style="--ext-color:${color}">
          <div class="update-card-head">
            <i class="update-dot" aria-hidden="true"></i>
            <h4>${esc(label)}</h4>
            ${badge}
          </div>
          <div class="update-slots">
            ${KINDS.map((k) => renderSlot(key, k, files[k.key])).join("")}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderSlot(extKey, kind, file) {
    const slotId = `${extKey}:${kind.key}`;
    return `
      <div class="update-slot" data-slot="${kind.key}">
        <div class="update-slot-head">
          <span class="update-slot-icon" aria-hidden="true">${KIND_ICONS[kind.key]}</span>
          <span class="update-slot-title">${kind.label}</span>
          <span class="update-slot-status ${file ? "" : "is-missing"}">${file ? fmtBytes(file.size) : "Falta"}</span>
        </div>
        <dl class="update-meta">
          <div><dt>Archivo</dt><dd title="${file ? esc(file.name) : ""}">${file ? esc(file.name) : "—"}</dd></div>
          <div><dt>Fecha</dt><dd>${file ? fmtDate(file.updated_at) : "—"}</dd></div>
        </dl>
        <div class="update-file-row">
          <label class="update-file" data-file-label="${slotId}">
            <input type="file" accept="${kind.accept}" data-input="${extKey}" data-kind="${kind.key}" />
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            <span data-filename="${slotId}">Seleccionar ${kind.key.toUpperCase()}…</span>
          </label>
          <button type="button" class="update-cancel-selection" data-cancel="${slotId}" hidden aria-label="Cancelar selección" title="Cancelar selección">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="update-progress" hidden aria-live="polite">
          <div class="update-progress-header">
            <span class="update-progress-label">Preparando…</span>
            <span class="update-progress-pct">0%</span>
          </div>
          <div class="update-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="update-progress-fill"></div>
          </div>
        </div>
        <div class="update-actions">
          <button type="button" class="primary-btn" data-upload="${extKey}" data-kind="${kind.key}" disabled>Subir ${kind.key.toUpperCase()}</button>
          ${file ? `<button type="button" class="danger-btn" data-delete="${extKey}" data-kind="${kind.key}">Eliminar</button>` : ""}
        </div>
      </div>
    `;
  }

  /* ═══════════ Reset de slot (limpia selección local) ═══════════ */
  function resetSlot(ext, kind) {
    const slotId = `${ext}:${kind}`;
    const input = document.querySelector(`input[data-input="${ext}"][data-kind="${kind}"]`);
    if (input) input.value = "";
    const label = document.querySelector(`[data-file-label="${slotId}"]`);
    const nameEl = document.querySelector(`[data-filename="${slotId}"]`);
    const btn = document.querySelector(`[data-upload="${ext}"][data-kind="${kind}"]`);
    const cancelBtn = document.querySelector(`[data-cancel="${slotId}"]`);
    label?.classList.remove("has-file");
    if (nameEl) nameEl.textContent = `Seleccionar ${kind.toUpperCase()}…`;
    if (btn) { btn.disabled = true; btn.classList.remove("is-ready"); }
    if (cancelBtn) cancelBtn.hidden = true;
  }

  /* ═══════════ Delegación global ═══════════ */
  let _bound = false;
  function attachGlobalListeners() {
    if (_bound) return;
    _bound = true;
    log("listeners globales listos");

    document.addEventListener("change", (e) => {
      if (!canManageUpdates()) return;
      const input = e.target.closest?.("input[data-input]");
      if (!input) return;
      const ext = input.dataset.input;
      const kind = input.dataset.kind;
      const slotId = `${ext}:${kind}`;
      const file = input.files?.[0];
      log("selección:", slotId, "→", file?.name || "(vacío)");

      const label = document.querySelector(`[data-file-label="${slotId}"]`);
      const nameEl = document.querySelector(`[data-filename="${slotId}"]`);
      const btn = document.querySelector(`[data-upload="${ext}"][data-kind="${kind}"]`);
      const cancelBtn = document.querySelector(`[data-cancel="${slotId}"]`);

      const reset = () => resetSlot(ext, kind);

      if (!file) return reset();
      const expected = "." + kind.toLowerCase();
      if (!file.name.toLowerCase().endsWith(expected)) {
        const otherKind = kind === "zip" ? "crx" : "zip";
        const isOther = file.name.toLowerCase().endsWith("." + otherKind);
        if (typeof toast === "function") {
          toast(isOther
            ? `Ese archivo es un .${otherKind}. Usa el botón "${otherKind.toUpperCase()}" de al lado.`
            : `Debe ser un archivo .${kind}`,
            "error");
        }
        input.value = ""; return reset();
      }
      if (file.size > MAX_BYTES) {
        if (typeof toast === "function") toast(`Demasiado grande (máx ${fmtBytes(MAX_BYTES)})`, "error");
        input.value = ""; return reset();
      }

      label?.classList.add("has-file");
      if (nameEl) nameEl.textContent = `${file.name} · ${fmtBytes(file.size)}`;
      if (btn) { btn.disabled = false; btn.classList.add("is-ready"); }
      if (cancelBtn) cancelBtn.hidden = false;
      if (typeof toast === "function") toast(`${file.name} listo. Pulsa "Subir ${kind.toUpperCase()}".`);
    });

    document.addEventListener("click", async (e) => {
      if (!canManageUpdates()) return;
      /* Cancelar selección (limpia el input, no toca el bucket) */
      const cancel = e.target.closest?.("[data-cancel]");
      if (cancel) {
        e.preventDefault();
        const [ext, kind] = cancel.dataset.cancel.split(":");
        resetSlot(ext, kind);
        if (typeof toast === "function") toast("Selección cancelada");
        return;
      }

      /* Subir */
      const up = e.target.closest?.("[data-upload]");
      if (up && !up.disabled) {
        e.preventDefault();
        const ext = up.dataset.upload;
        const kind = up.dataset.kind;
        const input = document.querySelector(`input[data-input="${ext}"][data-kind="${kind}"]`);
        const file = input?.files?.[0];
        if (file) requestReplace(ext, kind, file);
        else if (typeof toast === "function") toast("Selecciona un archivo primero", "error");
        return;
      }

      /* Eliminar del bucket */
      const del = e.target.closest?.("[data-delete]");
      if (del && !del.disabled) {
        e.preventDefault();
        const ext = del.dataset.delete;
        const kind = del.dataset.kind;
        if (confirm(`¿Eliminar el ${kind.toUpperCase()} de "${labelOf(ext)}"?\n\nEl cliente dejará de poder actualizarse por ese canal.`)) {
          await doDelete(ext, kind);
        }
      }
    });
  }

  /* ═══════════ Modal confirmación ═══════════ */
  function ensureReplaceModal() {
    let m = document.getElementById("updateReplaceBackdrop");
    if (m) return m;
    m = document.createElement("div");
    m.id = "updateReplaceBackdrop";
    m.className = "modal-backdrop";
    m.hidden = true;
    m.innerHTML = `
      <div class="dialog compact update-replace-dialog" role="alertdialog" aria-modal="true" aria-labelledby="updateReplaceTitle">
        <div class="dialog-head">
          <div>
            <h2 id="updateReplaceTitle">Reemplazar archivo</h2>
            <p>Esta acción reemplaza la versión actual del bucket. No se puede deshacer.</p>
          </div>
          <button type="button" class="close-btn" aria-label="Cerrar" data-close-replace>×</button>
        </div>
        <p class="update-warn-lead">Vas a reemplazar <strong id="updateReplaceName">—</strong>.</p>
        <div class="update-warn-grid">
          <div><span>Versión actual (se reemplazará)</span><b id="updateReplaceOld">—</b></div>
          <div><span>Nueva versión</span><b id="updateReplaceNew">—</b></div>
        </div>
        <p class="update-warn-foot">El archivo anterior será <strong>sobrescrito</strong>. Asegúrate de que es el correcto.</p>
        <label class="update-check">
          <input type="checkbox" id="updateReplaceCheck" />
          <span>Revisé el archivo y confirmo que es la versión <strong>correcta</strong>.</span>
        </label>
        <div class="dialog-actions">
          <button type="button" class="secondary-btn" data-close-replace>Cancelar</button>
          <button type="button" class="danger-btn" id="updateReplaceConfirm" disabled>Sí, subir</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    const close = () => { m.hidden = true; pendingReplace = null; };
    m.querySelectorAll("[data-close-replace]").forEach((b) => b.addEventListener("click", close));
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    m.querySelector("#updateReplaceCheck").addEventListener("change", (e) => {
      m.querySelector("#updateReplaceConfirm").disabled = !e.target.checked;
    });
    m.querySelector("#updateReplaceConfirm").addEventListener("click", async () => {
      const job = pendingReplace;
      close();
      if (job) await doReplace(job.ext, job.kind, job.file);
    });
    return m;
  }

  function requestReplace(ext, kind, file) {
    if (!canManageUpdates()) return;
    if (busy) { if (typeof toast === "function") toast("Espera, hay una operación en curso"); return; }
    if (!window.sbConfigured?.()) { if (typeof toast === "function") toast("Supabase no configurado", "error"); return; }
    const current = cache[ext]?.[kind] || null;
    const m = ensureReplaceModal();
    m.querySelector("#updateReplaceName").textContent = `${labelOf(ext)} · ${kind.toUpperCase()}`;
    m.querySelector("#updateReplaceOld").textContent = current
      ? `${current.name} · ${fmtBytes(current.size)} · ${fmtDate(current.updated_at)}`
      : "Sin versión previa";
    m.querySelector("#updateReplaceNew").textContent = `${file.name} · ${fmtBytes(file.size)}`;
    m.querySelector("#updateReplaceCheck").checked = false;
    m.querySelector("#updateReplaceConfirm").disabled = true;
    m.hidden = false;
    pendingReplace = { ext, kind, file };
  }

  /* ═══════════ Reemplazo con progreso ═══════════ */
  async function doReplace(ext, kind, file) {
    if (!canManageUpdates()) return;
    busy = true;
    log("iniciando:", ext, kind, file.name);
    const slot = document.querySelector(`.update-card[data-ext="${ext}"] .update-slot[data-slot="${kind}"]`);
    const btn = slot?.querySelector(`[data-upload]`);
    const delBtn = slot?.querySelector(`[data-delete]`);
    const cancelBtn = slot?.querySelector(`[data-cancel]`);
    const progress = slot?.querySelector(".update-progress");
    const fill = slot?.querySelector(".update-progress-fill");
    const pct = slot?.querySelector(".update-progress-pct");
    const label = slot?.querySelector(".update-progress-label");
    const bar = slot?.querySelector(".update-progress-bar");
    const oldText = btn?.textContent;

    const showProgress = () => {
      if (progress) progress.hidden = false;
      if (btn) { btn.disabled = true; btn.textContent = "Subiendo…"; btn.classList.remove("is-ready"); }
      if (delBtn) delBtn.disabled = true;
      if (cancelBtn) cancelBtn.hidden = true;
      updateSbBadge?.("loading");
    };
    const setProgress = (p, text) => {
      const v = Math.max(0, Math.min(100, p));
      if (fill) fill.style.width = v.toFixed(1) + "%";
      if (pct) pct.textContent = Math.round(v) + "%";
      if (label && text) label.textContent = text;
      if (bar) bar.setAttribute("aria-valuenow", String(Math.round(v)));
    };
    const hideProgress = (delay = 0) => {
      setTimeout(() => {
        if (progress) progress.hidden = true;
        if (fill) fill.style.width = "0%";
        if (pct) pct.textContent = "0%";
        if (label) label.textContent = "Preparando…";
        if (bar) bar.setAttribute("aria-valuenow", "0");
        if (btn) { btn.disabled = true; btn.textContent = oldText || "Subir"; }
        if (delBtn) delBtn.disabled = false;
        resetSlot(ext, kind);
      }, delay);
    };

    try {
      showProgress();
      setProgress(2, "Preparando archivo…");
      const base64 = await fileToBase64(file);
      setProgress(8, "Conectando…");
      await uploadWithProgress(ext, kind, file, base64, (ratio) => {
        if (ratio < 0.99) setProgress(10 + ratio * 82, `Subiendo ${fmtBytes(file.size)}…`);
        else setProgress(94, "Procesando en el servidor…");
      });
      setProgress(98, "Actualizando lista…");
      await refresh();
      setProgress(100, "Listo ✓");
      if (typeof toast === "function") toast(`${kind.toUpperCase()} de "${labelOf(ext)}" actualizado`);
      updateSbBadge?.("ok");
      window.dispatchEvent(new CustomEvent("panel-synced", { detail: { command: "extensions.upload", ext, kind } }));
      hideProgress(1400);
    } catch (err) {
      console.error("[extensions] replace failed", err);
      setProgress(100, "Error ✗");
      if (fill) fill.style.background = "var(--danger)";
      if (typeof toast === "function") toast("Error al subir: " + err.message, "error");
      updateSbBadge?.("error");
      hideProgress(2500);
      if (fill) setTimeout(() => { fill.style.background = ""; }, 2600);
    } finally {
      busy = false;
    }
  }

  async function doDelete(ext, kind) {
    if (!canManageUpdates()) return;
    if (busy) return;
    busy = true;
    try {
      await apiDelete(ext, kind);
      if (typeof toast === "function") toast(`${kind.toUpperCase()} de "${labelOf(ext)}" eliminado`);
      await refresh();
    } catch (err) {
      if (typeof toast === "function") toast("Error al eliminar: " + err.message, "error");
    } finally { busy = false; }
  }

  async function refresh(showToast = false) {
    if (!canManageUpdates()) return;
    if (!window.sbConfigured?.()) { warn("Supabase no configurado aún"); return; }
    try {
      await apiList();
      renderGrid();
      if (showToast && typeof toast === "function") toast("Lista actualizada");
    } catch (err) {
      console.error("[extensions] list failed", err);
      if (typeof toast === "function") toast("No se pudieron cargar: " + err.message, "error");
    }
  }

  /* ═══════════ Ciclo de vida ═══════════ */
  window.novaExtensions = {
    syncRole, refresh, list: apiList, remove: apiDelete, upload: uploadWithProgress,
    open: openUpdatesModal,
    debug: () => ({ cache, busy, bound: _bound }),
  };

  function boot() {
    attachGlobalListeners();
    syncRole();
    log("Módulo listo · ZIP+CRX · listeners:", _bound);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 900));
  } else {
    setTimeout(boot, 900);
  }
  const obs = new MutationObserver(() => {
    if (canManageUpdates() && document.getElementById("profileMenu") && !document.getElementById("menuUpdates")) addMenuEntry();
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
