/* USER MASTER — list, role-adaptive Add/Edit form, activate/deactivate,
   password reset and Absent Today marking. */
(function () {
  const filters = { role: '', search: '', activeOnly: '' };

  Pages.users = async function () {
    const content = document.getElementById('content');
    const [{ users }, meta] = await Promise.all([
      API.get('/api/users', filters),
      App.meta ? Promise.resolve(App.meta) : App.refreshMeta(),
    ]);

    const roles = meta.roles;
    const byRole = (code) => users.filter((u) => u.role_code === code).length;

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>User Master</h2>
          <p>Every person who signs in to KitchOps. Roles decide what each person can reach —
             permissions are enforced on the server, not just hidden in this interface.</p>
        </div>
        <div class="page-actions">
          ${App.can('users.manage') ? '<button class="btn btn-primary" id="addUser">+ Add User</button>' : ''}
        </div>
      </div>

      <div class="grid grid-4" style="margin-bottom:18px">
        ${roles.map((r) => `
          <div class="stat">
            <div class="k">${UI.esc(r.name)}</div>
            <div class="v">${byRole(r.code)}</div>
            <div class="s">${Number(r.needs_station) === 1 ? 'Station-assigned'
              : Number(r.needs_location) === 1 ? 'Location-assigned' : 'Administrative'}</div>
          </div>`).join('')}
      </div>

      <div class="card">
        <div class="card-head">
          <h3>Users</h3>
          <div class="spacer"></div>
          <div class="filters">
            <input id="fSearch" placeholder="Search name or username" value="${UI.esc(filters.search)}">
            <select id="fRole">
              <option value="">All roles</option>
              ${roles.map((r) => `<option value="${r.code}" ${filters.role === r.code ? 'selected' : ''}>${UI.esc(r.name)}</option>`).join('')}
            </select>
            <select id="fActive">
              <option value="">Active + inactive</option>
              <option value="true" ${filters.activeOnly === 'true' ? 'selected' : ''}>Active only</option>
            </select>
          </div>
        </div>
        <div class="card-body tight">${renderTable(users)}</div>
      </div>

      <div class="note note-info">
        <b>Status has three states.</b> <b>Active</b> and <b>Inactive</b> are permanent employment
        status. <b>Absent Today</b> removes a person from one day's work only — their permanent
        station assignment is untouched and their tasks redistribute to the rest of that station.
        Mark absence from Counter Settings or the row action here.
      </div>`;

    document.getElementById('addUser')?.addEventListener('click', () => openForm(null, meta));

    document.getElementById('fSearch').oninput = debounce((e) => { filters.search = e.target.value; Pages.users(); }, 350);
    document.getElementById('fRole').onchange = (e) => { filters.role = e.target.value; Pages.users(); };
    document.getElementById('fActive').onchange = (e) => { filters.activeOnly = e.target.value; Pages.users(); };

    content.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const user = users.find((u) => u.id === Number(btn.dataset.id));
        const act = btn.dataset.act;
        if (act === 'edit') openForm(user, meta);
        if (act === 'view') openView(user);
        if (act === 'toggle') toggleStatus(user);
        if (act === 'password') resetPassword(user);
        if (act === 'absent') markAttendance(user, user.absentToday ? 'PRESENT' : 'ABSENT');
        if (act === 'delete') removeUser(user);
      };
    });
  };

  function statusBadge(u) {
    if (u.statusLabel === 'INACTIVE') return '<span class="badge chip-danger">Inactive</span>';
    if (u.statusLabel === 'ABSENT_TODAY') return '<span class="badge chip-warn">Absent Today</span>';
    return '<span class="badge chip-ok">Active</span>';
  }

  function renderTable(users) {
    const manage = App.can('users.manage');
    const attend = App.can('attendance.manage');
    return UI.table([
      { key: 'id', label: 'User ID', className: 'num' },
      {
        key: 'full_name', label: 'Name',
        render: (u) => `<b>${UI.esc(u.full_name)}</b>${UI.sampleTag(u.is_sample)}`
          + (u.designation ? `<small style="display:block;color:var(--ink-3)">${UI.esc(u.designation)}</small>` : '')
          + (u.additional_responsibility
            ? ` <span class="badge chip-info">${UI.esc(u.additional_responsibility)}</span>` : ''),
      },
      { key: 'username', label: 'Username' },
      { key: 'role_name', label: 'Role', render: (u) => `<span class="badge chip-neutral">${UI.esc(u.role_name)}</span>` },
      {
        label: 'Assigned Location',
        render: (u) => (u.locations.length
          ? u.locations.map((l) => UI.esc(l.name)).join(', ')
          : '<span style="color:var(--ink-3)">—</span>'),
      },
      {
        label: 'Assigned Station(s)',
        render: (u) => (u.stations.length
          ? u.stations.map((s) => UI.stationDot(s.sheet_colour, s.name)).join('<br>')
          : '<span style="color:var(--ink-3)">—</span>'),
      },
      { label: 'Status', render: statusBadge },
      { label: 'Created', render: (u) => UI.fmtDate(u.created_at) },
      {
        label: 'Actions', className: 'row-actions-cell',
        render: (u) => `<div class="row-actions">
          <button class="btn btn-sm" data-act="view" data-id="${u.id}">View</button>
          ${manage ? `<button class="btn btn-sm" data-act="edit" data-id="${u.id}">Edit</button>` : ''}
          ${attend && u.stations.length && Number(u.is_active) === 1
            ? `<button class="btn btn-sm" data-act="absent" data-id="${u.id}">${u.absentToday ? 'Mark Present' : 'Mark Absent'}</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="toggle" data-id="${u.id}">${Number(u.is_active) === 1 ? 'Deactivate' : 'Activate'}</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="password" data-id="${u.id}">Reset PW</button>` : ''}
          ${manage ? `<button class="btn btn-sm btn-ghost" data-act="delete" data-id="${u.id}">Delete</button>` : ''}
        </div>`,
      },
    ], users, 'No users yet. Add your first user to begin.');
  }

  // -------------------------------------------------------------- add/edit
  function openForm(user, meta) {
    const isEdit = Boolean(user);
    const roles = meta.roles;
    const stationOptions = App.stations({ activeOnly: true }).map((s) => ({
      id: s.id, label: UI.stationDot(s.sheet_colour, s.name),
      sub: `${s.sheet_label ? s.sheet_label + ' · ' : ''}${s.type_code}`,
    }));
    const locationOptions = App.locations({ activeOnly: true }).map((l) => ({
      id: l.id, label: UI.esc(l.name), sub: l.code || '',
    }));

    const m = UI.modal({
      title: isEdit ? `Edit User — ${user.full_name}` : 'Add User',
      wide: true,
      submitLabel: isEdit ? 'Save changes' : 'Create user',
      body: `
        <div class="form-grid">
          <label class="field"><span class="req">Full Name</span>
            <input name="full_name" required value="${UI.esc(user?.full_name || '')}"></label>
          <label class="field"><span class="req">Username</span>
            <input name="username" required pattern="[A-Za-z0-9._\\-]{3,40}" value="${UI.esc(user?.username || '')}">
            <span class="hint">Used to sign in. 3–40 characters.</span></label>
          <label class="field"><span>Phone</span>
            <input name="phone" value="${UI.esc(user?.phone || '')}"></label>
          <label class="field"><span>Designation</span>
            <input name="designation" value="${UI.esc(user?.designation || '')}" placeholder="e.g. Line Cook">
            <span class="hint">Job title as it appears on the kitchen org chart.</span></label>
          <label class="field"><span>Additional Responsibility</span>
            <input name="additional_responsibility" value="${UI.esc(user?.additional_responsibility || '')}"
                   placeholder="e.g. Hygiene Head">
            <span class="hint">Extra duty held alongside the section posting. Optional.</span></label>
          <label class="field"><span class="req">Role</span>
            <select name="role_code" id="roleSelect" required>
              <option value="">Select a role…</option>
              ${roles.map((r) => `<option value="${r.code}" data-loc="${r.needs_location}" data-stn="${r.needs_station}"
                ${user?.role_code === r.code ? 'selected' : ''}>${UI.esc(r.name)}</option>`).join('')}
            </select>
            <span class="hint" id="roleHint"></span></label>
        </div>

        <label class="field"><span>${isEdit ? 'New password (leave blank to keep current)' : 'Password'}</span>
          <input type="password" name="password" minlength="6" autocomplete="new-password"
                 placeholder="${isEdit ? 'Unchanged' : 'Leave blank to generate one automatically'}">
          <span class="hint">At least 6 characters. A generated password is shown once after saving.</span></label>

        <!-- Location assignment: shown only for roles whose needs_location flag is set -->
        <div id="locBlock" hidden>
          ${UI.pickerFieldset('Assigned Location(s)', 'location_ids', locationOptions,
            (user?.locations || []).map((l) => l.id),
            'No locations exist yet. Add them in Location Master first.')}
        </div>

        <!-- Station assignment: options come from Station Master, never hardcoded -->
        <div id="stnBlock" hidden>
          ${UI.pickerFieldset('Assigned Station(s) — a station can have 1 or more persons', 'station_ids',
            stationOptions, (user?.stations || []).map((s) => s.id),
            'No active stations exist yet. Add them in Station Master first.')}
          <label class="field"><span>Assignment effective from</span>
            <select name="effective_from" id="effFrom">
              <option value="">Default — ${isEdit ? 'next day (permanent staff change)' : 'today (first assignment)'}</option>
            </select>
            <span class="hint">A permanent staff change applies from the next day. Choose “Today” only for
              initial setup or a correction.</span></label>
        </div>

        <label class="check"><input type="checkbox" name="is_active" ${user === null || Number(user.is_active) === 1 ? 'checked' : ''}>
          <span>Active<small>Permanent employment status. Uncheck to deactivate the login. This is not the same as “Absent Today”.</small></span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(user?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test record<small>Tagged SAMPLE and removable in bulk before real data is entered.</small></span></label>`,

      onSubmit: async (fd, node) => {
        const payload = {
          full_name: fd.get('full_name'),
          username: fd.get('username'),
          phone: fd.get('phone'),
          designation: fd.get('designation'),
          additional_responsibility: fd.get('additional_responsibility'),
          role_code: fd.get('role_code'),
          is_active: node.querySelector('[name=is_active]').checked,
          is_sample: node.querySelector('[name=is_sample]').checked,
          location_ids: node.querySelector('#locBlock').hidden ? [] : UI.checkedValues(node, 'location_ids'),
          station_ids: node.querySelector('#stnBlock').hidden ? [] : UI.checkedValues(node, 'station_ids'),
          effective_from: fd.get('effective_from') || undefined,
        };
        if (fd.get('password')) payload.password = fd.get('password');

        const res = isEdit
          ? await API.put(`/api/users/${user.id}`, payload)
          : await API.post('/api/users', payload);

        UI.ok(isEdit ? 'User updated.' : 'User created.');
        if (res.generatedPassword) showGeneratedPassword(payload.username, res.generatedPassword);
        if (res.assignment?.appliesFromNextDay && res.assignment.added.length + res.assignment.removed.length) {
          UI.toast(`Station change applies from ${res.assignment.effectiveFrom}.`);
        }
        Pages.users();
      },
    });

    // --- role-adaptive behaviour, driven by the role's own flags ------------
    const sel = m.node.querySelector('#roleSelect');
    const locBlock = m.node.querySelector('#locBlock');
    const stnBlock = m.node.querySelector('#stnBlock');
    const hint = m.node.querySelector('#roleHint');
    const effFrom = m.node.querySelector('#effFrom');

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000);
    effFrom.insertAdjacentHTML('beforeend',
      `<option value="${iso(today)}">Today (${iso(today)})</option>
       <option value="${iso(tomorrow)}">Tomorrow (${iso(tomorrow)})</option>`);

    function applyRole() {
      const opt = sel.selectedOptions[0];
      const needsLoc = opt?.dataset.loc === '1';
      const needsStn = opt?.dataset.stn === '1';
      locBlock.hidden = !needsLoc;
      stnBlock.hidden = !needsStn;
      hint.textContent = !opt || !opt.value ? ''
        : needsLoc ? 'This role submits daily requirements — assign at least one location.'
        : needsStn ? 'This role receives station tasks — assign one or more stations.'
        : 'Administrative role. No location or station assignment applies.';
    }
    sel.onchange = applyRole;
    applyRole();
  }

  function showGeneratedPassword(username, password) {
    UI.modal({
      title: 'Password generated',
      body: `<div class="note note-warn">This password is shown only once. Hand it to the user —
               they will be asked to change it at first sign-in.</div>
             <label class="field"><span>Username</span><input readonly value="${UI.esc(username)}"></label>
             <label class="field"><span>Password</span><input readonly value="${UI.esc(password)}"></label>`,
      submitLabel: 'Done',
      onSubmit: () => true,
    });
  }

  // ---------------------------------------------------------------- actions
  async function openView(user) {
    const { user: full, assignmentHistory } = await API.get(`/api/users/${user.id}`);
    UI.modal({
      title: `${full.full_name}`,
      wide: true,
      body: `
        <div class="grid grid-2">
          <div><div class="k" style="font-size:11px;color:var(--ink-3);font-weight:700">ROLE</div>
            <div>${UI.esc(full.role_name)}</div></div>
          <div><div class="k" style="font-size:11px;color:var(--ink-3);font-weight:700">USERNAME</div>
            <div>${UI.esc(full.username)}</div></div>
          <div><div class="k" style="font-size:11px;color:var(--ink-3);font-weight:700">STATUS</div>
            <div>${statusBadge(full)}</div></div>
          <div><div class="k" style="font-size:11px;color:var(--ink-3);font-weight:700">LAST SIGN-IN</div>
            <div>${full.last_login_at ? UI.esc(full.last_login_at) : 'Never'}</div></div>
        </div>
        <h4 style="margin:16px 0 6px;font-size:13px">Assigned locations</h4>
        <div>${full.locations.length ? full.locations.map((l) => `<span class="badge chip-neutral">${UI.esc(l.name)}</span>`).join(' ') : '<span style="color:var(--ink-3)">None</span>'}</div>
        <h4 style="margin:16px 0 6px;font-size:13px">Assigned stations (today)</h4>
        <div>${full.stations.length ? full.stations.map((s) => `<span class="badge chip-neutral">${UI.stationDot(s.sheet_colour, s.name)}</span>`).join(' ') : '<span style="color:var(--ink-3)">None</span>'}</div>
        <h4 style="margin:16px 0 6px;font-size:13px">Assignment history</h4>
        ${UI.table([
          { key: 'station_name', label: 'Station' },
          { label: 'From', render: (r) => UI.fmtDate(r.effective_from) },
          { label: 'To', render: (r) => (r.effective_to ? UI.fmtDate(r.effective_to) : '<span class="badge chip-ok">Current</span>') },
        ], assignmentHistory || [], 'No station assignments recorded.')}`,
      onSubmit: () => true,
    });
  }

  async function toggleStatus(user) {
    const activate = Number(user.is_active) !== 1;
    const okd = await UI.confirmDialog({
      title: activate ? 'Activate user' : 'Deactivate user',
      danger: !activate,
      confirmLabel: activate ? 'Activate' : 'Deactivate',
      message: activate
        ? `Restore sign-in access for <b>${UI.esc(user.full_name)}</b>?`
        : `<b>${UI.esc(user.full_name)}</b> will no longer be able to sign in and will be excluded from
           station rosters.<br><br>This is a <b>permanent</b> status change. For a one-day absence use
           <b>Mark Absent</b> instead — that keeps their assignment intact.`,
    });
    if (!okd) return;
    try {
      await API.patch(`/api/users/${user.id}/status`, { is_active: activate });
      UI.ok(activate ? 'User activated.' : 'User deactivated.');
      Pages.users();
    } catch (e) { UI.err(e.message); }
  }

  async function markAttendance(user, status) {
    try {
      const res = await API.post('/api/roster/attendance', { user_id: user.id, status });
      UI.ok(res.message);
      const short = res.redistribution.filter((r) => r.warning);
      if (short.length) UI.err(short.map((s) => s.warning).join(' '));
      Pages.users();
    } catch (e) { UI.err(e.message); }
  }

  async function resetPassword(user) {
    UI.modal({
      title: `Reset password — ${user.full_name}`,
      body: `<label class="field"><span>New password</span>
               <input type="password" name="password" minlength="6" placeholder="Leave blank to generate one">
               <span class="hint">The user must change it at next sign-in.</span></label>`,
      submitLabel: 'Reset password',
      onSubmit: async (fd) => {
        const res = await API.post(`/api/users/${user.id}/reset-password`,
          fd.get('password') ? { password: fd.get('password') } : {});
        showGeneratedPassword(user.username, res.password);
      },
    });
  }

  async function removeUser(user) {
    const okd = await UI.confirmDialog({
      title: 'Delete user', danger: true, confirmLabel: 'Delete',
      message: `Permanently delete <b>${UI.esc(user.full_name)}</b>?<br><br>
        Deletion is only possible while the record has no operational history.
        Otherwise deactivate the account instead — that keeps the history intact.`,
    });
    if (!okd) return;
    try {
      await API.del(`/api/users/${user.id}`);
      UI.ok('User deleted.');
      Pages.users();
    } catch (e) { UI.err(e.message); }
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
})();
