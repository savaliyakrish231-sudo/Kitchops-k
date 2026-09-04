/* App shell: session, permission-aware navigation, hash router.
   Nav hiding is convenience only — every endpoint enforces its own permission. */
window.App = (function () {
  const state = { user: null, meta: null };

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
        { id: 'settings', icon: '⚙', label: 'System Settings', show: () => can('settings.manage'), render: () => Pages.settings() },
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
      return `<div class="nav-group">
        <div class="nav-group-title">${UI.esc(g.group)}</div>
        ${items.map((i) => `
          <button class="nav-item ${i.id === current ? 'active' : ''}" data-page="${i.id}">
            <span class="ni">${i.icon}</span>${UI.esc(i.label)}
          </button>`).join('')}
      </div>`;
    }).join('');

    document.querySelectorAll('.nav-item').forEach((b) => {
      b.onclick = () => {
        location.hash = b.dataset.page;
        document.getElementById('sidebar').classList.remove('open');
      };
    });
  }

  function defaultPage() {
    const items = visibleItems();
    return items.length ? items[0].id : 'dashboard';
  }

  async function route() {
    const id = location.hash.replace('#', '') || defaultPage();
    const item = visibleItems().find((i) => i.id === id);
    const content = document.getElementById('content');

    if (!item) {
      content.innerHTML = `<div class="note note-warn">This page is not available for your role
        (${UI.esc(state.user.roleName)}).</div>`;
      return;
    }
    renderNav();
    content.innerHTML = UI.spinner();
    try {
      await item.render();
    } catch (e) {
      content.innerHTML = `<div class="note note-danger"><b>Could not load this page.</b><br>${UI.esc(e.message)}</div>`;
    }
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
    document.getElementById('userChip').innerHTML =
      `<b>${UI.esc(user.fullName)}</b>${UI.esc(user.roleName)}`;
    renderNav();
    if (!location.hash) location.hash = defaultPage();
    else route();
    if (user.mustChangePassword) {
      setTimeout(() => { changePassword(true); }, 400);
    }
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

    document.getElementById('logoutBtn').onclick = async () => {
      await API.post('/api/auth/logout');
      location.hash = '';
      showLogin();
    };
    document.getElementById('passwordBtn').onclick = () => changePassword(false);

    // Appearance toggle — available to every role, on every screen size.
    const themeBtn = document.getElementById('themeBtn');
    const paintThemeBtn = () => {
      const mode = Theme.get();
      const shown = Theme.resolved();
      themeBtn.textContent = Theme.LABELS[shown].icon;
      themeBtn.title = mode === 'system'
        ? `Appearance: System (currently ${Theme.LABELS[shown].label.toLowerCase()}) — click to switch`
        : `Appearance: ${Theme.LABELS[mode].label} — click to switch`;
    };
    themeBtn.onclick = () => { Theme.toggle(); };
    Theme.onChange(paintThemeBtn);
    paintThemeBtn();
    document.getElementById('navToggle').onclick = () =>
      document.getElementById('sidebar').classList.toggle('open');

    window.addEventListener('hashchange', route);
    Theme.onChange(() => {
      if ((location.hash.replace('#', '') || '') === 'settings' && state.user) route();
    });

    try {
      const { user } = await API.get('/api/auth/me');
      await refreshMeta();
      showApp(user);
    } catch {
      showLogin();
    }
  }

  return {
    state, can, canAny, route, refreshMeta, stations, locations, stationById,
    init, changePassword, get user() { return state.user; }, get meta() { return state.meta; },
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
