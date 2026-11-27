/* ═══════════════════════════════════════════════════════════════════
   Mantener presionado 4 segundos → editor compartido del mensaje
   ───────────────────────────────────────────────────────────────────
   - Toque corto en Copiar: conserva copyAccess() y su portapapeles.
   - Toque corto en WhatsApp: conserva contactWhatsApp().
   - Mantener presionado 4 segundos: abre la plantilla del botón correspondiente.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  const HOLD_MS = 4000;
  const MOVE_CANCEL_PX = 12;
  const SELECTOR = ".action.copy, .action.whatsapp";

  const log = (...args) => console.log("[longpress-editor]", ...args);
  const warn = (...args) => console.warn("[longpress-editor]", ...args);
  const err = (...args) => console.error("[longpress-editor]", ...args);

  function ensureStyles() {
    if (document.getElementById("longpress-editor-styles")) return;

    const style = document.createElement("style");
    style.id = "longpress-editor-styles";
    style.textContent = `
      .action.copy, .action.whatsapp {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        user-select: none;
        touch-action: pan-y;
      }
      .action.copy.longpress-holding, .action.whatsapp.longpress-holding {
        transform: scale(.96);
        box-shadow: 0 0 0 2px var(--accent, #16a37b);
        transition: transform .12s ease, box-shadow .12s ease;
      }
      .longpress-hint {
        position: fixed;
        z-index: 9999;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        background: rgba(17,24,28,.92);
        color: #fff;
        padding: 8px 16px;
        border-radius: 999px;
        font-size: 12px;
        line-height: 1.25;
        box-shadow: 0 6px 20px rgba(0,0,0,.35);
        pointer-events: none;
        opacity: 0;
        transition: opacity .15s ease;
        text-align: center;
        max-width: calc(100vw - 32px);
      }
      .longpress-hint.is-visible { opacity: 1; }
      @media (prefers-reduced-motion: reduce) {
        .action.copy.longpress-holding,
        .action.whatsapp.longpress-holding { transition: none; }
      }
    `;
    document.head.appendChild(style);

    const hint = document.createElement("div");
    hint.id = "longpressEditorHint";
    hint.className = "longpress-hint";
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    document.body.appendChild(hint);
  }

  let hintTimer = 0;
  let activeHold = null;
  const suppressClicks = new WeakMap();

  function showHint(message, duration = 1400) {
    const hint = document.getElementById("longpressEditorHint");
    if (!hint) return;
    hint.textContent = message;
    hint.classList.add("is-visible");
    clearTimeout(hintTimer);
    if (duration > 0) {
      hintTimer = setTimeout(() => hint.classList.remove("is-visible"), duration);
    }
  }

  function hideHint() {
    const hint = document.getElementById("longpressEditorHint");
    if (hint) hint.classList.remove("is-visible");
    clearTimeout(hintTimer);
  }

  function clearActiveHold() {
    if (!activeHold) return;
    clearTimeout(activeHold.timer);
    activeHold.button.classList.remove("longpress-holding");
    activeHold = null;
  }

  function rowIndexFromButton(button) {
    const row = button.closest("tr[data-index]");
    if (!row) return -1;
    const index = Number(row.dataset.index);
    return Number.isInteger(index) && index >= 0 ? index : -1;
  }

  function canEdit() {
    try {
      return typeof isAdmin === "function" && !!isAdmin();
    } catch (error) {
      warn("No se pudo comprobar el permiso de edición:", error);
      return false;
    }
    return false;
  }

  function getClient(index) {
    try {
      const source = typeof datasets !== "undefined" ? datasets : window.datasets;
      const license = typeof current !== "undefined" ? current : window.current;
      return source && license && Array.isArray(source[license]) ? source[license][index] || null : null;
    } catch (error) {
      warn("No se pudieron leer los datos del cliente:", error);
      return null;
    }
  }

  // El botón pulsado determina cuál plantilla independiente se edita.
  function openEditor(index, kind = "access") {
    if (!canEdit()) {
      showHint("No tienes permiso para editar este mensaje", 1800);
      return false;
    }
    try {
      if (typeof openWhatsAppMessageEditor !== "function") return false;
      openWhatsAppMessageEditor(index, kind);
      const modal = document.querySelector("#whatsappMsgBackdrop");
      return !!modal && !modal.hidden;
    } catch (error) {
      err("Falló el editor:", error);
      return false;
    }
  }

  function handlePointerDown(event) {
    const button = event.target.closest?.(SELECTOR);
    if (!button || !button.closest("#userRows")) return;
    if (event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const index = rowIndexFromButton(button);
    if (index < 0) return;

    clearActiveHold();

    const state = {
      button,
      index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      fired: false,
      cancelled: false,
    };

    activeHold = state;
    button.classList.add("longpress-holding");
    showHint("Mantén presionado 4 segundos para editar el mensaje", HOLD_MS + 500);

    state.timer = setTimeout(() => {
      if (activeHold !== state || state.cancelled || !button.isConnected) return;
      state.fired = true;
      button.classList.remove("longpress-holding");

      try { navigator.vibrate?.(35); } catch {}

      if (openEditor(index, button.matches(".action.whatsapp") ? "renewal" : "access")) {
        showHint("Editor de mensaje abierto", 1500);
      } else {
        showHint("No se pudo abrir el editor", 2200);
      }
    }, HOLD_MS);
  }

  function handlePointerMove(event) {
    const state = activeHold;
    if (!state || state.pointerId !== event.pointerId || state.fired || state.cancelled) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
      clearTimeout(state.timer);
      state.cancelled = true;
      state.button.classList.remove("longpress-holding");
      hideHint();
    }
  }

  function handlePointerUp(event) {
    const state = activeHold;
    if (!state || state.pointerId !== event.pointerId) return;

    clearTimeout(state.timer);
    state.button.classList.remove("longpress-holding");

    // Al completar los 4 segundos, evita que el click generado al soltar
    // vuelva a copiar o abra WhatsApp además de abrir el editor.
    if (state.fired) suppressClicks.set(state.button, Date.now() + 900);

    activeHold = null;
    hideHint();
  }

  function handlePointerCancel(event) {
    if (!activeHold || activeHold.pointerId !== event.pointerId) return;
    clearActiveHold();
    hideHint();
  }

  function handleClickCapture(event) {
    const button = event.target.closest?.(SELECTOR);
    if (!button || !button.closest("#userRows")) return;

    const expiresAt = suppressClicks.get(button) || 0;
    if (!expiresAt) return;

    suppressClicks.delete(button);
    if (Date.now() <= expiresAt) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  }

  function boot() {
    ensureStyles();
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerCancel, true);
    document.addEventListener("click", handleClickCapture, true);
    document.addEventListener("contextmenu", (event) => {
      if (event.target.closest?.(SELECTOR)) event.preventDefault();
    }, true);

    log("Activo: mantén Copiar o WhatsApp presionado 4 segundos para editar.");
    log("Copiar y WhatsApp tienen plantillas independientes.");
  }

  window.longPressEditor = {
    HOLD_MS,
    MOVE_CANCEL_PX,
    SELECTOR,
    fire(index, kind) { return openEditor(index, kind); },
    open(index, kind) { return openEditor(index, kind); },
    debug() {
      const modal = document.querySelector("#whatsappMsgBackdrop");
      const textarea = document.querySelector("#whatsappMsgValue");
      console.log("LONG-PRESS EDITOR", {
        holdMs: HOLD_MS,
        whatsappMessageText: typeof whatsappMessageText,
        whatsappMessageTemplate: typeof whatsappMessageTemplate,
        openWhatsAppMessageEditor: typeof openWhatsAppMessageEditor,
        modalFound: !!modal,
        modalHidden: modal ? modal.hidden : null,
        textareaFound: !!textarea,
        currentLicense: typeof current !== "undefined" ? current : window.current,
      });
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
