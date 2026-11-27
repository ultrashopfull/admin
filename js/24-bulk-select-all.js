/* Rediseño de "Seleccionar todos" para borrado masivo.
   - Un solo checkbox maestro (checked / indeterminate / unchecked).
   - Contador en vivo y label del botón eliminar con el número.
   - Sincroniza con los .bulk-delete-check de cada fila.
   - No compite con el click handler de 01-panel.js: escucha la
     clase .is-active del botón papelera y el render de #userRows. */
(function () {
  "use strict";

  const toggleBtn  = document.getElementById("bulkDeleteToggleBtn");
  const master     = document.getElementById("bulkSelectAllCheckbox");
  const masterLbl  = document.getElementById("bulkSelectAllLabel");
  const masterTxt  = document.getElementById("bulkSelectAllText");
  const countEl    = document.getElementById("bulkSelectionCount");
  const deleteBtn  = document.getElementById("bulkDeleteSelectedBtn");
  const deleteLbl  = document.getElementById("bulkDeleteSelectedLabel");
  const rowsBody   = document.getElementById("userRows");

  if (!master || !masterLbl || !rowsBody || !deleteBtn) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const rowChecks = () => rowsBody.querySelectorAll(".bulk-delete-check");
  const bulkActive = () => toggleBtn?.classList.contains("is-active") ?? true;

  function syncUI() {
    const checks   = [...rowChecks()];
    const total    = checks.length;
    const selected = checks.filter(c => c.checked).length;

    /* ---- Estado del checkbox maestro ---- */
    if (total === 0 || selected === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else if (selected === total) {
      master.checked = true;
      master.indeterminate = false;
    } else {
      master.checked = false;
      master.indeterminate = true;      // selección parcial
    }

    /* ---- Visibilidad ---- */
    masterLbl.hidden = !bulkActive() || total === 0;
    countEl.hidden   = selected === 0;
    deleteBtn.hidden = selected === 0;

    /* ---- Textos ---- */
    if (selected === 0) {
      masterTxt.textContent = "Seleccionar todos";
      deleteLbl.textContent = "Eliminar";
    } else if (selected === total) {
      masterTxt.textContent = "Deseleccionar todos";
      deleteLbl.textContent = `Eliminar (${selected})`;
    } else {
      masterTxt.textContent = `Seleccionar todos (${selected}/${total})`;
      deleteLbl.textContent = `Eliminar (${selected})`;
    }

    if (selected > 0) {
      countEl.textContent = `${selected} seleccionado${selected === 1 ? "" : "s"}`;
    }
  }

  /* ---- Click en el maestro: todo o nada ---- */
  master.addEventListener("change", () => {
    const on = master.checked;
    rowChecks().forEach(c => {
      c.checked = on;
      c.closest("tr")?.classList.toggle("bulk-delete-selected", on);
    });
    if (!reduced.matches && window.NovaMotion?.play) {
      window.NovaMotion.play(
        masterLbl,
        [{ transform: "scale(.97)" }, { transform: "scale(1)" }],
        { duration: 220, easing: "cubic-bezier(.22,1,.36,1)" },
      );
    }
    syncUI();
  });

  /* ---- Cambios individuales (delegación sobrevive re-render) ---- */
  rowsBody.addEventListener("change", (e) => {
    const c = e.target.closest(".bulk-delete-check");
    if (!c) return;
    c.closest("tr")?.classList.toggle("bulk-delete-selected", c.checked);
    syncUI();
  });

  /* ---- Re-render de filas (filtro, búsqueda, refresh, tabs) ---- */
  new MutationObserver(syncUI).observe(rowsBody, {
    childList: true,
    subtree: true,
  });

  /* ---- Entrada/salida de modo borrado masivo ---- */
  if (toggleBtn) {
    new MutationObserver(() => {
      if (!bulkActive()) {
        // Al salir del modo masivo, limpiamos selección residual
        rowChecks().forEach(c => {
          c.checked = false;
          c.closest("tr")?.classList.remove("bulk-delete-selected");
        });
      }
      syncUI();
    }).observe(toggleBtn, { attributes: true, attributeFilter: ["class"] });
  }

  /* Estado inicial */
  syncUI();
})();