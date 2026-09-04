/* LOCATION MASTER — outlets that submit daily requirements and that the
   Recipe DB location cutting overrides hang off. */
(function () {
  Pages.locations = async function () {
    const content = document.getElementById('content');
    const { locations } = await API.get('/api/locations');

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Location Master</h2>
          <p>Each location submits its own daily item-wise requirement and can carry its own
             cut type and cut method override in the Recipe DB.</p>
        </div>
        <div class="page-actions">
          ${App.can('locations.manage') ? '<button class="btn btn-primary" id="addLocation">+ Add Location</button>' : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Locations</h3></div>
        <div class="card-body tight">${renderTable(locations)}</div>
      </div>

      <div class="note note-info">
        Method 1 (item-wise entry) is the default for every location. Uncheck <b>Allows dish-wise
        entry</b> for any location that must always use item-wise entry only.
      </div>`;

    document.getElementById('addLocation')?.addEventListener('click', () => openForm(null));
    content.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const l = locations.find((x) => x.id === Number(btn.dataset.id));
        if (btn.dataset.act === 'edit') openForm(l);
        if (btn.dataset.act === 'toggle') toggleStatus(l);
        if (btn.dataset.act === 'delete') removeLocation(l);
      };
    });
  };

  function renderTable(locations) {
    const manage = App.can('locations.manage');
    return UI.table([
      { key: 'id', label: 'ID', className: 'num' },
      { key: 'name', label: 'Location', render: (l) => `<b>${UI.esc(l.name)}</b>${UI.sampleTag(l.is_sample)}` },
      { key: 'code', label: 'Code', render: (l) => UI.esc(l.code || '—') },
      { label: 'Dish-wise entry', render: (l) => UI.yesNo(l.allows_method_2, 'Allowed', 'Item-wise only') },
      { key: 'manager_count', label: 'Managers', className: 'num' },
      { key: 'override_count', label: 'Cut overrides', className: 'num' },
      {
        label: 'Status',
        render: (l) => (Number(l.is_active) === 1
          ? '<span class="badge chip-ok">Active</span>' : '<span class="badge chip-danger">Inactive</span>'),
      },
      {
        label: 'Actions',
        render: (l) => `<div class="row-actions">
          ${manage ? `<button class="btn btn-sm" data-act="edit" data-id="${l.id}">Edit</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="toggle" data-id="${l.id}">${Number(l.is_active) === 1 ? 'Deactivate' : 'Activate'}</button>` : ''}
          ${manage ? `<button class="btn btn-sm btn-ghost" data-act="delete" data-id="${l.id}">Delete</button>` : ''}
        </div>`,
      },
    ], locations, 'No locations yet. Add your outlets to begin.');
  }

  function openForm(location) {
    const isEdit = Boolean(location);
    UI.modal({
      title: isEdit ? `Edit Location — ${location.name}` : 'Add Location',
      submitLabel: isEdit ? 'Save changes' : 'Create location',
      body: `
        <div class="form-grid">
          <label class="field"><span class="req">Location Name</span>
            <input name="name" required value="${UI.esc(location?.name || '')}"></label>
          <label class="field"><span>Short Code</span>
            <input name="code" maxlength="12" value="${UI.esc(location?.code || '')}">
            <span class="hint">Optional label used on packing containers.</span></label>
          <label class="field"><span>Sort Order</span>
            <input type="number" name="sort_order" value="${Number(location?.sort_order ?? 0)}"></label>
        </div>
        <label class="check"><input type="checkbox" name="allows_method_2" ${location === null || Number(location.allows_method_2) === 1 ? 'checked' : ''}>
          <span>Allows dish-wise entry<small>Uncheck for a location that must always use item-wise entry.</small></span></label>
        <label class="check"><input type="checkbox" name="is_active" ${location === null || Number(location.is_active) === 1 ? 'checked' : ''}>
          <span>Active</span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(location?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test record</span></label>`,
      onSubmit: async (fd, node) => {
        const payload = {
          name: fd.get('name'),
          code: fd.get('code'),
          sort_order: Number(fd.get('sort_order') || 0),
          allows_method_2: node.querySelector('[name=allows_method_2]').checked,
          is_active: node.querySelector('[name=is_active]').checked,
          is_sample: node.querySelector('[name=is_sample]').checked,
        };
        if (isEdit) await API.put(`/api/locations/${location.id}`, payload);
        else await API.post('/api/locations', payload);
        UI.ok(isEdit ? 'Location updated.' : 'Location created.');
        await App.refreshMeta();
        Pages.locations();
      },
    });
  }

  async function toggleStatus(location) {
    const activate = Number(location.is_active) !== 1;
    try {
      await API.patch(`/api/locations/${location.id}/status`, { is_active: activate });
      UI.ok(activate ? 'Location activated.' : 'Location deactivated.');
      await App.refreshMeta();
      Pages.locations();
    } catch (e) { UI.err(e.message); }
  }

  async function removeLocation(location) {
    const okd = await UI.confirmDialog({
      title: 'Delete location', danger: true, confirmLabel: 'Delete',
      message: `Permanently delete <b>${UI.esc(location.name)}</b>?<br><br>
        Only a location with no managers and no cutting overrides can be deleted.`,
    });
    if (!okd) return;
    try {
      await API.del(`/api/locations/${location.id}`);
      UI.ok('Location deleted.');
      await App.refreshMeta();
      Pages.locations();
    } catch (e) { UI.err(e.message); }
  }
})();
