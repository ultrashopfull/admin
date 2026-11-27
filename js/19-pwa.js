/* UltraShop — instalación como PWA.
   - Registra el service worker que permite abrir el panel como app.
   - Muestra los botones de instalación solo cuando la app no está instalada.
   - En iPhone/iPad enseña los pasos de Safari; en Android usa el aviso nativo
     de Chrome cuando está disponible. */
(() => {
  const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
  let deferredPrompt = null;

  function isIOS() {
    const ua = navigator.userAgent || "";
    return (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1)
    );
  }

  function isAndroid() {
    return /android/i.test(navigator.userAgent || "");
  }

  function isInAppBrowser() {
    return /(FBAN|FBAV|Instagram|Line\/|WhatsApp|Twitter)/i.test(navigator.userAgent || "");
  }

  function isStandalone() {
    return !!standaloneQuery?.matches || navigator.standalone === true;
  }

  function installButtons() {
    return document.querySelectorAll("#installAppBtn, #menuInstall");
  }

  function refreshInstallUi() {
    const installed = isStandalone();
    document.documentElement.classList.toggle("pwa-standalone", installed);
    installButtons().forEach((button) => {
      button.hidden = installed;
    });
    const promptButton = document.querySelector("#installPromptBtn");
    if (promptButton) promptButton.hidden = !deferredPrompt;
    if (installed) closeInstallDialog();
  }

  function buildSteps() {
    if (isInAppBrowser()) {
      return [
        {
          title: "Abre UltraShop en tu navegador",
          text: "Toca el menú de esta app y elige «Abrir en Safari» o «Abrir en Chrome»."
        },
        {
          title: "Instala desde el navegador",
          text: "Ya en Safari o Chrome, sigue los pasos de instalación de tu teléfono."
        }
      ];
    }
    if (isIOS()) {
      return [
        {
          title: "Abre esta página en Safari",
          text: "En iPhone y iPad, la instalación se hace desde Safari."
        },
        {
          title: "Toca el botón Compartir",
          text: "Es el cuadrado con la flecha hacia arriba, en la barra inferior."
        },
        {
          title: "Elige «Añadir a pantalla de inicio»",
          text: "Desplázate por el menú hasta encontrar esa opción."
        },
        {
          title: "Toca «Añadir»",
          text: "El icono de UltraShop quedará junto a tus demás aplicaciones."
        }
      ];
    }
    if (isAndroid()) {
      return [
        {
          title: "Abre el menú de Chrome",
          text: "Toca los tres puntos ⋮ en la esquina superior derecha."
        },
        {
          title: "Elige «Instalar aplicación»",
          text: "También puede aparecer como «Añadir a pantalla de inicio»."
        },
        {
          title: "Confirma «Instalar»",
          text: "UltraShop se abrirá como una app, sin la barra del navegador."
        }
      ];
    }
    return [
      {
        title: "Usa Chrome, Edge o Safari",
        text: "Abre el panel en un navegador compatible con aplicaciones web."
      },
      {
        title: "Busca el icono de instalar",
        text: "Está en la barra de direcciones, a la derecha de la dirección del panel."
      },
      {
        title: "Confirma la instalación",
        text: "UltraShop quedará como una aplicación más de tu equipo."
      }
    ];
  }

  function renderInstallDialog() {
    const list = document.querySelector("#installSteps");
    const intro = document.querySelector("#installIntro");
    const note = document.querySelector("#installNote");
    if (!list) return;
    list.replaceChildren();
    for (const step of buildSteps()) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = step.title;
      const text = document.createElement("span");
      text.textContent = step.text;
      item.append(title, text);
      list.append(item);
    }
    if (intro) {
      intro.textContent = isStandalone()
        ? "UltraShop ya está instalada en este dispositivo."
        : "Instala el panel para abrirlo como una app, con su propio icono y sin la barra del navegador.";
    }
    if (note) {
      note.textContent = isIOS()
        ? "Si instalas la app después de activar la huella, vuelve a activarla dentro de la app: Safari y la app instalada guardan datos separados en iPhone y iPad."
        : "La huella se activa en cada dispositivo después de iniciar sesión. Si ya la activaste en el navegador, actívala también dentro de la app instalada.";
    }
  }

  function openInstallDialog() {
    if (typeof window.closeProfileMenu === "function") window.closeProfileMenu();
    const backdrop = document.querySelector("#installBackdrop");
    if (!backdrop) return;
    renderInstallDialog();
    backdrop.hidden = false;
    const primary = document.querySelector("#installPromptBtn");
    if (primary) primary.hidden = !deferredPrompt;
    document.querySelector('#installBackdrop [data-close]')?.focus({ preventScroll: true });
  }

  function closeInstallDialog() {
    const backdrop = document.querySelector("#installBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  async function promptInstall() {
    if (!deferredPrompt) {
      renderInstallDialog();
      return;
    }
    const prompt = deferredPrompt;
    deferredPrompt = null;
    try {
      prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === "accepted") {
        closeInstallDialog();
      } else {
        if (typeof toast === "function") toast("Puedes instalar UltraShop cuando quieras desde este mismo botón.");
      }
    } catch {
      if (typeof toast === "function") toast("No se pudo abrir el instalador. Usa el menú del navegador.");
    }
    refreshInstallUi();
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("#installAppBtn, #menuInstall");
    if (button) {
      event.preventDefault();
      openInstallDialog();
    }
  });

  document.querySelector("#installPromptBtn")?.addEventListener("click", promptInstall);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    refreshInstallUi();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    refreshInstallUi();
    if (typeof toast === "function") toast("UltraShop se instaló en este dispositivo", "success");
  });

  standaloneQuery?.addEventListener?.("change", refreshInstallUi);
  window.addEventListener("load", refreshInstallUi);
  refreshInstallUi();

  window.UltraShopPWA = { openInstall: openInstallDialog, isInstalled: isStandalone };

  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  if ("serviceWorker" in navigator && (location.protocol === "https:" || local)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        /* La app sigue funcionando sin service worker. */
      });
    });
  }
})();
