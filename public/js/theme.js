/* Appearance: Light / Dark / System.
   Stored per device in localStorage, not in the database — one admin changing
   their own theme must not restyle the app for the whole kitchen. Counter staff
   on their own phones get their own choice too.

   The no-flash bootstrap in index.html applies the stored value before first
   paint; this module owns everything after that. */
window.Theme = (function () {
  const KEY = 'kitchops.theme';
  const MODES = ['light', 'dark', 'system'];

  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const listeners = new Set();

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : 'system';
    } catch {
      return 'system'; // private mode / storage blocked
    }
  }

  /** The mode the user picked: 'light' | 'dark' | 'system'. */
  function get() { return stored(); }

  /** What is actually on screen right now: 'light' | 'dark'. */
  function resolved() {
    const mode = stored();
    if (mode !== 'system') return mode;
    return media && media.matches ? 'dark' : 'light';
  }

  function apply(mode) {
    // 'system' removes the attribute so the prefers-color-scheme rules take over.
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  function set(mode) {
    if (!MODES.includes(mode)) mode = 'system';
    try { localStorage.setItem(KEY, mode); } catch { /* not fatal */ }
    apply(mode);
    listeners.forEach((fn) => fn(mode, resolved()));
    return mode;
  }

  /** Topbar button: flips between light and dark based on what is on screen. */
  function toggle() {
    return set(resolved() === 'dark' ? 'light' : 'dark');
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const LABELS = {
    light: { label: 'Light', icon: '☀' },
    dark: { label: 'Dark', icon: '☾' },
    system: { label: 'System', icon: '🖥' },
  };

  function init() {
    apply(stored());
    // Follow the OS live while the mode is 'system'.
    if (media) {
      const onSystemChange = () => {
        if (stored() === 'system') listeners.forEach((fn) => fn('system', resolved()));
      };
      if (media.addEventListener) media.addEventListener('change', onSystemChange);
      else if (media.addListener) media.addListener(onSystemChange);
    }
  }

  return { MODES, LABELS, get, set, resolved, toggle, onChange, init, apply };
})();
