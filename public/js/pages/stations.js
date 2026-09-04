/* STATION MASTER — the configurable list the whole engine reads.
   Nothing here is hardcoded: adding a station makes it appear immediately in the
   Recipe DB station picker, in Counter Settings and in the sheet preview. */
(function () {
  Pages.stations = async function () {
    const content = document.getElementById('content');
    const { stations } = await API.get('/api/stations');
    const meta = App.meta || await App.refreshMeta();

    const active = stations.filter((s) => Number(s.is_active) === 1);
    const unstaffed = active.filter((s) => s.availableStaffCount === 0);
    const noItems = active.filter((s) => s.recipe_item_count === 0);

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Station Master</h2>
          <p>Stations are data, not code. Add one here and it appears automatically in the Recipe DB
             station picker, in Counter Settings and as its own sheet — no development work required.</p>
        </div>
        <div class="page-actions">
          ${App.can('stations.manage') ? '<button class="btn btn-primary" id="addStation">+ Add Station</button>' : ''}
        </div>
      </div>

      <div class="grid grid-4" style="margin-bottom:18px">
        <div class="stat"><div class="k">Active stations</div><div class="v">${active.length}</div>
          <div class="s">${stations.length - active.length} inactive</div></div>
        <div class="stat"><div class="k">Recipe items routed</div>
          <div class="v">${stations.reduce((n, s) => n + s.recipe_item_count, 0)}</div>
          <div class="s">across all stations</div></div>
        <div class="stat"><div class="k">Stations without staff</div>
          <div class="v" style="${unstaffed.length ? 'color:var(--warn)' : ''}">${unstaffed.length}</div>
          <div class="s">available today</div></div>
        <div class="stat"><div class="k">Stations without items</div>
          <div class="v" style="${noItems.length ? 'color:var(--warn)' : ''}">${noItems.length}</div>
          <div class="s">nothing assigned yet</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Stations</h3>
          <span class="card-sub">Sheet order follows Sort Order, then Sheet Label.</span></div>
        <div class="card-body tight">${renderTable(stations)}</div>
      </div>

      <div class="note note-info">
        <b>Station Type drives the engine's behaviour, not the station's name.</b>
        A <i>Cutting</i>-type station requires a Cut Type and Machine/Manual method on every item routed
        to it; a <i>Peeling</i>-type station passes its net output on to cutting; a <i>Packing</i>-type
        station waits for the prep stations. Rename or add stations freely — the rules follow the type.
      </div>`;

    document.getElementById('addStation')?.addEventListener('click', () => openForm(null, meta));
    content.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const s = stations.find((x) => x.id === Number(btn.dataset.id));
        if (btn.dataset.act === 'edit') openForm(s, meta);
        if (btn.dataset.act === 'toggle') toggleStatus(s);
        if (btn.dataset.act === 'delete') removeStation(s);
        if (btn.dataset.act === 'view') openView(s);
      };
    });
  };

  function renderTable(stations) {
    const manage = App.can('stations.manage');
    return UI.table([
      { key: 'sheet_label', label: 'Label', render: (s) => `<b>${UI.esc(s.sheet_label || '—')}</b>` },
      {
        key: 'name', label: 'Station Name',
        render: (s) => `${UI.stationDot(s.sheet_colour, s.name)}${UI.sampleTag(s.is_sample)}`,
      },
      { key: 'type_name', label: 'Type', render: (s) => `<span class="badge chip-neutral">${UI.esc(s.type_name)}</span>` },
      {
        label: 'Drives', render: (s) => [
          Number(s.requires_cut_method) === 1 ? 'Cut method required' : null,
          Number(s.is_peeling) === 1 ? `Feeds ${UI.esc(s.feeds_into_type || 'next stage')}` : null,
          Number(s.is_packing) === 1 ? 'Waits for all prep' : null,
        ].filter(Boolean).join('<br>') || '<span style="color:var(--ink-3)">—</span>',
      },
      { key: 'recipe_item_count', label: 'Items', className: 'num' },
      {
        label: 'Staff today', className: 'num',
        render: (s) => (s.availableStaffCount === 0 && Number(s.is_active) === 1
          ? `<span class="badge chip-warn">${s.availableStaffCount} / ${s.staffCount}</span>`
          : `${s.availableStaffCount} / ${s.staffCount}`),
      },
      { key: 'sort_order', label: 'Sort', className: 'num' },
      {
        label: 'Status',
        render: (s) => (Number(s.is_active) === 1
          ? '<span class="badge chip-ok">Active</span>'
          : '<span class="badge chip-danger">Inactive</span>'),
      },
      {
        label: 'Actions',
        render: (s) => `<div class="row-actions">
          <button class="btn btn-sm" data-act="view" data-id="${s.id}">View</button>
          ${manage ? `<button class="btn btn-sm" data-act="edit" data-id="${s.id}">Edit</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="toggle" data-id="${s.id}">${Number(s.is_active) === 1 ? 'Deactivate' : 'Activate'}</button>` : ''}
          ${manage ? `<button class="btn btn-sm btn-ghost" data-act="delete" data-id="${s.id}">Delete</button>` : ''}
        </div>`,
      },
    ], stations, 'No stations yet. Add your first station to begin.');
  }

  function openForm(station, meta) {
    const isEdit = Boolean(station);
    UI.modal({
      title: isEdit ? `Edit Station — ${station.name}` : 'Add Station',
      submitLabel: isEdit ? 'Save changes' : 'Create station',
      body: `
        <div class="form-grid">
          <label class="field"><span class="req">Station Name</span>
            <input name="name" required value="${UI.esc(station?.name || '')}" placeholder="e.g. Marination Counter">
            <span class="hint">Free text. Any name works — nothing is hardcoded.</span></label>
          <label class="field"><span class="req">Station Type</span>
            <select name="type_code" required>
              <option value="">Select a type…</option>
              ${meta.stationTypes.map((t) => `<option value="${t.code}" ${station?.type_code === t.code ? 'selected' : ''}>${UI.esc(t.name)}</option>`).join('')}
            </select>
            <span class="hint">Decides the special logic applied to items routed here.</span></label>
          <label class="field"><span>Sheet Label</span>
            <input name="sheet_label" maxlength="4" value="${UI.esc(station?.sheet_label || '')}" placeholder="e.g. A">
            <span class="hint">Display order label on the dashboard.</span></label>
          <label class="field"><span>Sort Order</span>
            <input type="number" name="sort_order" value="${Number(station?.sort_order ?? 0)}"></label>
          <label class="field"><span>Sheet Colour</span>
            <input type="color" name="sheet_colour" value="${UI.esc(station?.sheet_colour || '#64748b')}">
            <span class="hint">Header colour on this station's sheet.</span></label>
        </div>
        <label class="field"><span>Notes</span>
          <textarea name="notes">${UI.esc(station?.notes || '')}</textarea></label>
        <label class="check"><input type="checkbox" name="is_active" ${station === null || Number(station.is_active) === 1 ? 'checked' : ''}>
          <span>Active<small>Inactive stations are hidden from sheets and order forms. No data is deleted.</small></span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(station?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test station<small>Tagged SAMPLE and removable in bulk.</small></span></label>`,
      onSubmit: async (fd, node) => {
        const payload = {
          name: fd.get('name'),
          type_code: fd.get('type_code'),
          sheet_label: fd.get('sheet_label'),
          sheet_colour: fd.get('sheet_colour'),
          sort_order: Number(fd.get('sort_order') || 0),
          notes: fd.get('notes'),
          is_active: node.querySelector('[name=is_active]').checked,
          is_sample: node.querySelector('[name=is_sample]').checked,
        };
        if (isEdit) await API.put(`/api/stations/${station.id}`, payload);
        else await API.post('/api/stations', payload);
        UI.ok(isEdit ? 'Station updated.' : 'Station created — it is already available everywhere.');
        await App.refreshMeta();
        Pages.stations();
      },
    });
  }

  async function openView(station) {
    const data = await API.get(`/api/stations/${station.id}`);
    UI.modal({
      title: data.station.name,
      wide: true,
      body: `
        <div class="grid grid-3" style="margin-bottom:14px">
          <div class="stat"><div class="k">Type</div><div class="v" style="font-size:16px">${UI.esc(data.station.type_name)}</div></div>
          <div class="stat"><div class="k">Recipe items</div><div class="v">${data.recipeItems.length}</div></div>
          <div class="stat"><div class="k">Assigned staff</div><div class="v">${data.roster.length}</div>
            <div class="s">${data.roster.filter((r) => r.available).length} available today</div></div>
        </div>
        <h4 style="margin:0 0 6px;font-size:13px">Counter persons</h4>
        ${UI.table([
          { key: 'fullName', label: 'Name' },
          {
            label: 'Today', render: (r) => (r.status === 'AVAILABLE' ? '<span class="badge chip-ok">Available</span>'
              : r.status === 'ABSENT_TODAY' ? '<span class="badge chip-warn">Absent Today</span>'
              : '<span class="badge chip-danger">Inactive</span>'),
          },
        ], data.roster, 'No counter persons assigned to this station yet.')}
        <h4 style="margin:16px 0 6px;font-size:13px">Recipe items routed here</h4>
        ${UI.table([
          { key: 'item_name', label: 'Item' },
          { label: 'Active', render: (r) => UI.yesNo(r.is_active) },
        ], data.recipeItems, 'No recipe items assigned to this station yet.')}`,
      onSubmit: () => true,
    });
  }

  async function toggleStatus(station) {
    const activate = Number(station.is_active) !== 1;
    const okd = await UI.confirmDialog({
      title: activate ? 'Activate station' : 'Deactivate station',
      danger: !activate, confirmLabel: activate ? 'Activate' : 'Deactivate',
      message: activate
        ? `<b>${UI.esc(station.name)}</b> will appear on sheets and order forms again.`
        : `<b>${UI.esc(station.name)}</b> will be hidden from sheets and order forms.
           Its ${station.recipe_item_count} recipe item(s) and staff assignments are kept — no data is deleted.`,
    });
    if (!okd) return;
    try {
      await API.patch(`/api/stations/${station.id}/status`, { is_active: activate });
      UI.ok(activate ? 'Station activated.' : 'Station deactivated.');
      await App.refreshMeta();
      Pages.stations();
    } catch (e) { UI.err(e.message); }
  }

  async function removeStation(station) {
    const okd = await UI.confirmDialog({
      title: 'Delete station', danger: true, confirmLabel: 'Delete',
      message: `Permanently delete <b>${UI.esc(station.name)}</b>?<br><br>
        Only an unused station can be deleted. If items, staff or sheets reference it,
        deactivate it instead.`,
    });
    if (!okd) return;
    try {
      await API.del(`/api/stations/${station.id}`);
      UI.ok('Station deleted.');
      await App.refreshMeta();
      Pages.stations();
    } catch (e) {
      UI.err(e.message);
    }
  }
})();
