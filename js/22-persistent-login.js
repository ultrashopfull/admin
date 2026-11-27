/* Sesión persistente + auto-huella al cargar el panel */
(() => {
  const PERSIST_KEY = "nova-persistent-session-v1";
  const log = (...a) => console.log("[persistent-login]", ...a);
  const warn = (...a) => console.warn("[persistent-login]", ...a);

  /* ═══════════════════════════════════════════════════════════════════
     1) PERSISTENCIA DEL TOKEN
     - Intercepta sbSetStaffToken para guardar también en localStorage
     - Al cargar, si hay credenciales guardadas y no hay sesión, las restaura
     - Al cerrar sesión, las elimina
     ═══════════════════════════════════════════════════════════════════ */

  function persistCredentials(username, password) {
    if (!username || !password) return;
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        username: String(username).trim(),
        password: String(password),
        savedAt: Date.now(),
      }));
      log("✓ credenciales persistidas para", username);
    } catch (e) {
      warn("no se pudo persistir:", e.message);
    }
  }

  function readPersisted() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.username === "string" && typeof obj.password === "string") {
        return obj;
      }
    } catch {}
    return null;
  }

  function clearPersisted() {
    try {
      localStorage.removeItem(PERSIST_KEY);
      log("persistencia eliminada");
    } catch {}
  }

  /* Interceptar sbSetStaffToken */
  function hookTokenSetter() {
    if (typeof window.sbSetStaffToken !== "function") return;
    if (window.sbSetStaffToken.__persisted) return;

    const original = window.sbSetStaffToken;
    window.sbSetStaffToken = function (username, password) {
      try {
        original.call(this, username, password);
      } catch (e) {
        warn("sbSetStaffToken original falló:", e.message);
      }
      if (username && password) persistCredentials(username, password);
    };
    window.sbSetStaffToken.__persisted = true;
    log("hook sbSetStaffToken instalado");
  }

  /* Restaurar token al cargar */
  function restoreSession() {
    // Si ya hay token en sessionStorage, no tocar
    const current = (() => {
      try { return window.sbGetStaffToken?.() || ""; } catch { return ""; }
    })();
    if (current) {
      log("ya hay sesión activa, no se restaura");
      return true;
    }

    const saved = readPersisted();
    if (!saved) {
      log("sin credenciales persistidas");
      return false;
    }

    try {
      if (typeof window.sbSetStaffToken === "function") {
        window.sbSetStaffToken(saved.username, saved.password);
        log("✓ sesión restaurada para", saved.username);
        return true;
      }
    } catch (e) {
      warn("error al restaurar sesión:", e.message);
    }
    return false;
  }

  /* Limpiar al cerrar sesión */
  function hookLogout() {
    // Interceptar confirmLogout (nombre habitual del panel)
    const originalConfirm = window.confirmLogout;
    if (typeof originalConfirm === "function" && !originalConfirm.__persisted) {
      window.confirmLogout = function () {
        clearPersisted();
        return originalConfirm.apply(this, arguments);
      };
      window.confirmLogout.__persisted = true;
      log("hook confirmLogout instalado");
    }

    // Interceptar sbDisconnect también
    const originalDisconnect = window.sbDisconnect;
    if (typeof originalDisconnect === "function" && !originalDisconnect.__persisted) {
      window.sbDisconnect = function () {
        clearPersisted();
        return originalDisconnect.apply(this, arguments);
      };
      window.sbDisconnect.__persisted = true;
    }

    // Interceptar botón "Cerrar sesión" del menú si existe
    document.addEventListener("click", (e) => {
      const btn = e.target.closest?.("#menuLogout, #confirmLogout, [data-logout]");
      if (btn) {
        // Esperar un tick para que el handler original se ejecute primero
        setTimeout(clearPersisted, 100);
      }
    }, true);
  }

  /* ═══════════════════════════════════════════════════════════════════
     2) AUTO-HUELLA
     - Detecta si el login screen está visible
     - Si el botón de huella está VISIBLE (no hidden) → hay passkey registrado
     - Dispara el botón automáticamente
     - Si falla por NotAllowedError (falta user gesture), resalta el botón
     ═══════════════════════════════════════════════════════════════════ */

  function isLoginScreenVisible() {
    const screen = document.getElementById("loginScreen");
    const app = document.getElementById("app");
    if (!screen) return false;
    if (screen.hidden) return false;
    if (app && !app.hidden) return false;
    return true;
  }

  function isBiometricAvailable() {
    const btn = document.getElementById("biometricBtn");
    if (!btn) return false;
    // Si el código lo oculta (hidden) o display:none → no hay passkey
    if (btn.hidden) return false;
    if (btn.offsetParent === null) return false;
    return true;
  }

  function highlightBiometricButton() {
    const btn = document.getElementById("biometricBtn");
    if (!btn) return;
    btn.classList.add("biometric-attention");
    btn.focus({ preventScroll: true });
    setTimeout(() => btn.classList.remove("biometric-attention"), 4000);
  }

  let biometricTriggered = false;
  let lastBiometricAt = 0;
  const BIOMETRIC_COOLDOWN = 3000;
  const BIOMETRIC_DEFER = 80;

  async function autoTriggerBiometric() {
    if (biometricTriggered) return;
    if (!isLoginScreenVisible()) return;
    if (!isBiometricAvailable()) {
      log("botón huella no visible → no hay passkey, no se auto-dispara");
      return;
    }

    // Evita reabrir el prompt en bucle cuando el propio cuadro de la huella
    // dispara visibilitychange o si el usuario acaba de cancelarlo.
    const now = Date.now();
    if (now - lastBiometricAt < BIOMETRIC_COOLDOWN) {
      log("cooldown activo → no se re-dispara todavía");
      return;
    }
    lastBiometricAt = now;

    const btn = document.getElementById("biometricBtn");
    if (!btn || btn.hidden || btn.disabled) return;

    biometricTriggered = true;
    log("botón huella visible → pidiendo la huella de inmediato…");
    // Defer mínimo: solo para que el navegador termine de pasar a primer plano
    await new Promise((r) => setTimeout(r, BIOMETRIC_DEFER));

    const target = document.getElementById("biometricBtn");
    if (!isLoginScreenVisible() || !target || target.hidden || target.disabled) {
      biometricTriggered = false;
      return;
    }

    try {
      target.click();
      log("✓ huella auto-disparada");
      // Resetear flag tras 3s para permitir reintentos
      setTimeout(() => { biometricTriggered = false; }, BIOMETRIC_COOLDOWN);
    } catch (e) {
      warn("auto-disparo falló:", e.message);
      biometricTriggered = false;
      highlightBiometricButton();
    }
  }

  /* Volver a la PWA → pedir la huella de inmediato */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isLoginScreenVisible()) autoTriggerBiometric();
  });
  // Restauraciones desde caché (bfcache) pueden llegar sin visibilitychange
  window.addEventListener("pageshow", () => {
    if (!document.hidden && isLoginScreenVisible()) autoTriggerBiometric();
  });

  /* ═══════════════════════════════════════════════════════════════════
     3) INIT
     ═══════════════════════════════════════════════════════════════════ */

  function bootImmediate() {
    // 1) Sincrónico: hooks + restauración (antes de que sbInit() corra)
    hookTokenSetter();
    hookLogout();
    const restored = restoreSession();

    // 2) Sincrónico también: re-instalar hook si sbSetStaffToken se redefine después
    setTimeout(hookTokenSetter, 100);
    setTimeout(hookTokenSetter, 500);

    // 3) Auto-huella INMEDIATA: si se ve la pantalla de login, el ingreso va
    //    directo por la huella, sin esperar a Supabase ni a que carguen los datos.
    setTimeout(autoTriggerBiometric, 60);

    // 4) Supabase se inicializa en paralelo (no bloquea la huella)
    setTimeout(async () => {
      if (restored && typeof window.sbConfigured === "function" && window.sbConfigured()) {
        try {
          if (typeof window.sbInit === "function") {
            await window.sbInit();
            log("✓ Supabase inicializado con sesión restaurada");
          }
        } catch (e) {
          warn("error en sbInit:", e.message);
        }
      }
    }, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootImmediate);
  } else {
    bootImmediate();
  }

  /* ═══════════════════════════════════════════════════════════════════
     4) DEBUG API
     ═══════════════════════════════════════════════════════════════════ */
  window.persistentLogin = {
    clear: clearPersisted,
    hasPersisted: () => !!readPersisted(),
    hasSession: () => !!window.sbGetStaffToken?.(),
    restore: restoreSession,
    triggerBiometric: autoTriggerBiometric,
    status: () => ({
      persisted: !!readPersisted(),
      session: !!window.sbGetStaffToken?.(),
      loginScreenVisible: isLoginScreenVisible(),
      biometricAvailable: isBiometricAvailable(),
    }),
  };

  log("módulo cargado");
})();
