/* App shell: session, permission-aware navigation, hash router.
   Nav hiding is convenience only — every endpoint enforces its own permission. */
window.App = (function () {
  const state = { user: null, meta: null, unsavedWarning: null };

  /**
   * A page calls this while it holds work that would be lost on sign-out or
   * navigation (e.g. PINs typed but not yet saved). Cleared on every route
   * change, so a page only ever speaks for itself.
   */
  function setUnsavedWarning(message) { state.unsavedWarning = message || null; }

  const can = (code) => Boolean(state.user && state.user.permissions.includes(code));
  const canAny = (...codes) => codes.some(can);

  /** True when the signed-in user holds a role that is assigned to stations.
      Driven by the role's own needs_station flag, so "My Tasks" is offered to
      counter staff only — not to an admin who happens to hold every permission. */
  function isStationRole() {
    const role = (state.meta?.roles || []).find((r) => r.code === state.user?.role);
    return Number(role?.needs_station) === 1;
  }

  const NAV = [
    {
      group: 'Operations',
      items: [
        { id: 'dashboard', icon: '▦', label: 'Dashboard', show: () => canAny('dashboard.view', 'sheets.view_all', 'recipes.view'), render: () => Pages.dashboard() },
        { id: 'mytasks', icon: '✓', label: 'My Tasks', show: () => can('tasks.view_own') && isStationRole(), render: () => Pages.myTasks() },
        { id: 'counter', icon: '👥', label: 'Counter Settings', show: () => canAny('users.assign_stations', 'attendance.manage'), render: () => Pages.counter() },
      ],
    },
    {
      group: 'Master Data',
      items: [
        { id: 'recipes', icon: '🥕', label: 'Recipe DB', show: () => can('recipes.view'), render: () => Pages.recipes() },
        { id: 'stations', icon: '⌗', label: 'Station Master', show: () => can('stations.view'), render: () => Pages.stations() },
        { id: 'locations', icon: '⚲', label: 'Location Master', show: () => can('locations.view'), render: () => Pages.locations() },
        { id: 'masters', icon: '⚙', label: 'Supporting Masters', show: () => can('masters.manage'), render: () => Pages.masters() },
      ],
    },
    {
      group: 'Administration',
      items: [
        { id: 'users', icon: '👤', label: 'User Master', show: () => can('users.view'), render: () => Pages.users() },
        { id: 'credentials', icon: '🔑', label: 'Sign-in Credentials', show: () => can('users.manage'), render: () => Pages.credentials() },
        { id: 'settings', icon: '⚙', label: 'System Settings', show: () => can('settings.manage'), render: () => Pages.settings() },
      ],
    },
    {
      // Untitled group at the foot. Every signed-in person gets this, including
      // counter staff who have no other page.
      group: null,
      className: 'nav-account',
      items: [
        { id: 'account', icon: '👤', label: 'Account', show: () => Boolean(state.user), render: () => Pages.account() },
      ],
    },
  ];

  function visibleItems() {
    return NAV.flatMap((g) => g.items).filter((i) => i.show());
  }

  function renderNav() {
    const current = location.hash.replace('#', '') || defaultPage();
    document.getElementById('sidebar').innerHTML = NAV.map((g) => {
      const items = g.items.filter((i) => i.show());
      if (!items.length) return '';
      return `<div class="nav-group ${g.className || ''}">
        ${g.group ? `<div class="nav-group-title">${UI.esc(g.group)}</div>` : ''}
        ${items.map((i) => `
          <button class="nav-item ${i.id === current ? 'active' : ''}" data-page="${i.id}">
            <span class="ni">${i.icon}</span>${UI.esc(i.label)}
          </button>`).join('')}
      </div>`;
    }).join('');

    const sidebar = document.getElementById('sidebar');

    document.querySelectorAll('.nav-item[data-page]').forEach((b) => {
      b.onclick = () => {
        location.hash = b.dataset.page;
        closeNav();
      };
    });
  }

  /**
   * The phone navigation drawer. Opening it dims and locks the page behind, so
   * a stray scroll does not move content the user cannot see. It closes on:
   * picking a page, tapping the backdrop, Escape, or growing past 900px where
   * the sidebar becomes permanent.
   */
  function setNav(open) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('open', open);
    document.getElementById('navBackdrop')?.classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
    document.getElementById('navToggle')?.setAttribute('aria-expanded', String(open));
  }
  const closeNav = () => setNav(false);

  function defaultPage() {
    const items = visibleItems();
    return items.length ? items[0].id : 'dashboard';
  }

  // Guards against a slow page finishing after the user has moved on.
  let routeSeq = 0;

  async function route() {
    const id = location.hash.replace('#', '') || defaultPage();
    const item = visibleItems().find((i) => i.id === id);
    const content = document.getElementById('content');
    const seq = ++routeSeq;

    setUnsavedWarning(null);
    // Render the sidebar BEFORE any early return. A role with no pages of its
    // own still needs its Account group — on a phone that is its only way out.
    renderNav();

    if (!item) {
      content.innerHTML = `<div class="note note-warn">There is no page available for your role
        (${UI.esc(state.user.roleName)}) yet. Use <b>Account</b> in the menu to change your
        password or sign out.</div>`;
      return;
    }

    // Only show a placeholder if the load is slow enough to notice. Most
    // requests finish well inside this, so the usual experience is a clean swap
    // rather than a flash of "Loading…".
    const placeholder = setTimeout(() => {
      if (seq === routeSeq) content.innerHTML = UI.skeleton();
    }, 180);

    try {
      await item.render();
    } catch (e) {
      if (seq === routeSeq) {
        content.innerHTML = `<div class="note note-danger"><div><b>Could not load this page.</b><br>${UI.esc(e.message)}</div></div>`;
      }
    } finally {
      clearTimeout(placeholder);
    }
    if (seq !== routeSeq) return;   // superseded by a newer navigation

    afterRender(content, { toTop: true });
  }

  /**
   * Shared post-render work: acknowledge async buttons, and play the entrance
   * animation. `toTop` distinguishes navigating to a page (start at the top)
   * from a page refreshing itself in place (keep the reading position).
   */
  function afterRender(content, { toTop }) {
    UI.enhanceButtons(content);
    content.classList.remove('page-enter');
    void content.offsetWidth;          // restart the animation
    content.classList.add('page-enter');
    if (toTop) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  async function refreshMeta() {
    state.meta = await API.get('/api/meta/bootstrap');
    return state.meta;
  }

  /** Station options ALWAYS come from Station Master via the API. */
  function stations({ activeOnly = true, includeSample = true } = {}) {
    return (state.meta?.stations || []).filter((s) =>
      (!activeOnly || Number(s.is_active) === 1) && (includeSample || Number(s.is_sample) === 0));
  }
  function locations({ activeOnly = true } = {}) {
    return (state.meta?.locations || []).filter((l) => !activeOnly || Number(l.is_active) === 1);
  }
  const stationById = (id) => (state.meta?.stations || []).find((s) => Number(s.id) === Number(id));

  function showApp(user) {
    state.user = user;
    document.getElementById('loginView').hidden = true;
    document.getElementById('appView').hidden = false;
    renderNav();
    if (!location.hash) location.hash = defaultPage();
    else route();
    if (user.mustChangePassword) {
      setTimeout(() => { changePassword(true); }, 400);
    }
  }

  /**
   * Signing out is never immediate — it is one tap away from a phone's back
   * gesture, and a mis-tap mid-shift means finding the login slip again.
   */
  async function signOut() {
    const usesPin = state.meta?.roles
      ?.find((r) => r.code === state.user?.role)?.allows_pin === 1;

    const confirmed = await UI.confirmDialog({
      title: 'Sign out?',
      confirmLabel: 'Yes, sign out',
      message: `You are signed in as <b>${UI.esc(state.user.fullName)}</b> (${UI.esc(state.user.roleName)}).
        ${state.unsavedWarning
          ? `<br><br><span style="color:var(--danger)"><b>${UI.esc(state.unsavedWarning)}</b></span>`
          : ''}
        <br><br>You will need your login ID and ${usesPin ? 'PIN' : 'password'} to sign back in.`,
    });
    if (!confirmed) return;

    try { await API.post('/api/auth/logout'); } catch { /* sign out locally regardless */ }
    setUnsavedWarning(null);
    closeNav();
    location.hash = '';
    showLogin();
    UI.toast('Signed out.');
  }

  function showLogin() {
    state.user = null;
    document.getElementById('appView').hidden = true;
    document.getElementById('loginView').hidden = false;
  }

  function changePassword(forced = false) {
    UI.modal({
      title: forced ? 'Set a new password' : 'Change password',
      body: `
        ${forced ? '<div class="note note-warn">Your password was set by an administrator. Choose a new one to continue.</div>' : ''}
        <label class="field"><span class="req">Current password</span>
          <input type="password" name="currentPassword" required autocomplete="current-password"></label>
        <label class="field"><span class="req">New password</span>
          <input type="password" name="newPassword" required minlength="6" autocomplete="new-password">
          <span class="hint">At least 6 characters.</span></label>`,
      submitLabel: 'Update password',
      onSubmit: async (fd) => {
        await API.post('/api/auth/change-password', {
          currentPassword: fd.get('currentPassword'),
          newPassword: fd.get('newPassword'),
        });
        UI.ok('Password updated.');
        state.user.mustChangePassword = false;
      },
    });
  }

  async function init() {
    Theme.init();
    enhanceOnRerender();

    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const box = document.getElementById('loginError');
      box.hidden = true;
      const fd = new FormData(e.target);
      try {
        const { user } = await API.post('/api/auth/login', {
          username: fd.get('username'), password: fd.get('password'),
        });
        await refreshMeta();
        showApp(user);
      } catch (ex) {
        box.textContent = ex.message;
        box.hidden = false;
      }
    };

    // Identity, appearance, password and sign out all live on the Account page
    // now — see js/pages/account.js.
    const navToggle = document.getElementById('navToggle');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-controls', 'sidebar');
    navToggle.onclick = () =>
      setNav(!document.getElementById('sidebar').classList.contains('open'));

    document.getElementById('navBackdrop').onclick = closeNav;

    // Escape closes the drawer, unless a modal is open and owns the key.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('modalHost').hidden) return;
      closeNav();
    });

    // Rotating to landscape or resizing past the breakpoint makes the sidebar
    // permanent, so the drawer state must not linger and lock body scrolling.
    if (window.matchMedia) {
      const wide = window.matchMedia('(min-width: 900px)');
      const onWide = (e) => { if (e.matches) closeNav(); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }

    window.addEventListener('hashchange', route);

    try {
      const { user } = await API.get('/api/auth/me');
      await refreshMeta();
      showApp(user);
    } catch {
      showLogin();
    }
  }

  /**
   * Wraps every page renderer so a page that refreshes itself after an action
   * re-applies the button enhancements to its newly created buttons.
   *
   * Deliberately does NOT touch scroll position. An in-place re-render builds
   * its HTML after the fetch and swaps it in one go, so the browser already
   * keeps the reading position; restoring it here would only fight a user who
   * scrolled while the save was in flight.
   */
  function enhanceOnRerender() {
    for (const [name, render] of Object.entries(Pages)) {
      if (typeof render !== 'function' || render.__wrapped) continue;
      const wrapped = async (...args) => {
        const result = await render(...args);
        const content = document.getElementById('content');
        if (content) UI.enhanceButtons(content);
        return result;
      };
      wrapped.__wrapped = true;
      Pages[name] = wrapped;
    }
  }

  return {
    state, can, canAny, route, refreshMeta, stations, locations, stationById, setUnsavedWarning, signOut,
    init, changePassword, get user() { return state.user; }, get meta() { return state.meta; },
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
