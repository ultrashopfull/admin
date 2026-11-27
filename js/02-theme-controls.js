/* Instant theme switching. Paint locally first; synchronize the latest choice later. */
(function () {
  const root = document.documentElement;
  const toggles = document.querySelectorAll('.theme-toggle');
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let pending = null, saving = false, timer = 0, paintSerial = 0;
  const valid = theme => theme === 'dark' || theme === 'light';
  const remote = () => window.panelSync?.connected?.() && !document.querySelector('#app')?.hidden;
  const scope = () => remote() ? { userId: String(sessionUserId), connection: sbConnectionKey() } : null;
  const sameScope = (a, b) => !!a && !!b && a.userId === b.userId && a.connection === b.connection;
  function cache(theme) { try { localStorage.setItem('nova-theme', theme); } catch {} }
  function paint(theme, save = false) {
    if (!valid(theme)) return;
    if (root.dataset.theme !== theme) {
      const serial = ++paintSerial;
      root.classList.add('theme-instant');
      root.dataset.theme = theme;
      // Keep transitions off for the theme repaint only, not ordinary interactions.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (serial === paintSerial) root.classList.remove('theme-instant');
      }));
    }
    const next = theme === 'dark' ? 'claro' : 'oscuro';
    toggles.forEach(button => {
      button.setAttribute('aria-label', 'Cambiar a modo ' + next);
      button.title = 'Cambiar a modo ' + next;
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0b0b0c' : '#f2f2f3';
    if (save) cache(theme);
  }
  function schedule(delay = 180) {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }
  async function flush() {
    if (!pending || saving || pending.failed) return;
    if (!sameScope(pending, scope())) { pending = null; return; }
    if (window.panelSync.busy || document.querySelector('.modal-backdrop:not([hidden])')) {
      schedule(250); return;
    }
    const job = pending;
    saving = true;
    let ok = false;
    try {
      ok = await window.panelSync.run('preference.save', {userId: job.userId, theme: job.theme}, {quietPreference: true});
    } catch (error) { console.warn('[Theme] No se pudo sincronizar:', error); }
    finally {
      saving = false;
      if (pending === job) {
        if (ok) pending = null;
        else if (sameScope(job, scope())) {
          job.failed = true;
          // Keep the current device's choice. Retry on the next click or reconnect.
        } else pending = null;
      }
      if (pending && !pending.failed) schedule(0);
    }
  }
  function choose(theme) {
    paint(theme, true);
    const active = scope();
    pending = active ? {...active, theme, failed: false} : null;
    if (pending) schedule();
  }
  toggles.forEach(button => button.addEventListener('click', () => {
    choose(root.dataset.theme === 'dark' ? 'light' : 'dark');
  }));
  window.novaSetTheme = theme => {
    if (pending && !sameScope(pending, scope())) pending = null;
    // Periodic reads and the response to an earlier click must not undo a newer click.
    if (pending) return;
    paint(theme, true);
  };
  window.novaThemeResetSession = () => { pending = null; clearTimeout(timer); };
  paint(valid(root.dataset.theme) ? root.dataset.theme : 'dark');
  system.addEventListener('change', event => {
    let stored;
    try { stored = localStorage.getItem('nova-theme'); } catch {}
    if (!valid(stored) && !pending) paint(event.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', event => {
    if (event.key === 'nova-theme' && !pending) paint(valid(event.newValue) ? event.newValue : system.matches ? 'dark' : 'light');
  });
  window.addEventListener('online', () => {
    if (pending && sameScope(pending, scope())) { pending.failed = false; schedule(0); }
  });
})();
