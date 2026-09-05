/* Supporting masters (cut types, item categories) and System Settings. */
(function () {
  Pages.masters = async function () {
    const content = document.getElementById('content');
    const [{ cutTypes }, { itemCategories }, sample] = await Promise.all([
      API.get('/api/meta/cut-types'),
      API.get('/api/meta/item-categories'),
      API.get('/api/meta/sample-data').catch(() => ({ counts: [] })),
    ]);

    const sampleTotal = sample.counts.reduce((n, c) => n + c.count, 0);

    content.innerHTML = `
      ${UI.pageHead({
        icon: '\u2699',
        title: 'Supporting Masters',
        lead: 'The option lists behind the Recipe DB. Both are editable — add whatever cut types and '
          + 'categories this kitchen actually uses.',
      })}

      <div class="card">
        <div class="card-head"><h3>Cut Types</h3>
          <span class="card-sub">Used by the Default Cutting Type field and by location overrides.</span>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-primary" id="addCut">+ Add Cut Type</button></div>
        <div class="card-body tight">${UI.table([
          { key: 'name', label: 'Name', render: (c) => `<b>${UI.esc(c.name)}</b>${UI.sampleTag(c.is_sample)}` },
          {
            label: 'Whole / Akhaj target',
            render: (c) => (Number(c.is_whole) === 1
              ? '<span class="badge chip-warn">Yes — used when Whole/Akhaj is ticked</span>'
              : '<span style="color:var(--ink-3)">—</span>'),
          },
          { key: 'sort_order', label: 'Sort', className: 'num' },
          { label: 'Active', render: (c) => UI.yesNo(c.is_active) },
          {
            label: 'Actions',
            render: (c) => `<div class="row-actions"><button class="btn btn-sm" data-cut="${c.id}">Edit</button></div>`,
          },
        ], cutTypes)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Item Categories</h3>
          <span class="card-sub">The <b>Yield % required</b> flag is what makes Yield % mandatory for an item.</span>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-primary" id="addCat">+ Add Category</button></div>
        <div class="card-body tight">${UI.table([
          { key: 'name', label: 'Name', render: (c) => `<b>${UI.esc(c.name)}</b>${UI.sampleTag(c.is_sample)}` },
          {
            label: 'Yield % required',
            render: (c) => (Number(c.requires_yield) === 1
              ? '<span class="badge chip-danger">Mandatory</span>'
              : '<span class="badge chip-neutral">Optional</span>'),
          },
          { key: 'sort_order', label: 'Sort', className: 'num' },
          { label: 'Active', render: (c) => UI.yesNo(c.is_active) },
          {
            label: 'Actions',
            render: (c) => `<div class="row-actions"><button class="btn btn-sm" data-cat="${c.id}">Edit</button></div>`,
          },
        ], itemCategories)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Sample / test data</h3>
          <span class="card-sub">Records tagged SAMPLE, kept separate from real master data.</span>
          <div class="spacer"></div>
          ${sampleTotal ? '<button class="btn btn-sm btn-danger" id="purge">Remove all sample data</button>' : ''}
        </div>
        <div class="card-body tight">${UI.table([
          { key: 'label', label: 'Type' },
          { key: 'count', label: 'Sample records', className: 'num' },
        ], sample.counts, 'No sample data present.')}</div>
      </div>

      ${sampleTotal ? `<div class="note note-warn">
        <b>${sampleTotal} sample record(s) present.</b> Remove them before or after entering the real
        master data — everything tagged SAMPLE is deleted in one step, and nothing else is touched.</div>` : ''}`;

    document.getElementById('addCut').onclick = () => cutForm(null);
    document.getElementById('addCat').onclick = () => catForm(null);
    document.getElementById('purge')?.addEventListener('click', purge);
    content.querySelectorAll('[data-cut]').forEach((b) => {
      b.onclick = () => cutForm(cutTypes.find((c) => c.id === Number(b.dataset.cut)));
    });
    content.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => catForm(itemCategories.find((c) => c.id === Number(b.dataset.cat)));
    });
  };

  function cutForm(cut) {
    UI.modal({
      title: cut ? `Edit Cut Type — ${cut.name}` : 'Add Cut Type',
      submitLabel: 'Save',
      body: `
        <label class="field"><span class="req">Name</span>
          <input name="name" required value="${UI.esc(cut?.name || '')}" placeholder="e.g. Shredded"></label>
        <label class="field"><span>Sort Order</span>
          <input type="number" name="sort_order" value="${Number(cut?.sort_order ?? 99)}"></label>
        <label class="check"><input type="checkbox" name="is_whole" ${Number(cut?.is_whole) === 1 ? 'checked' : ''}>
          <span>This is the Whole / Akhaj cut type<small>Selected automatically when an item is marked Whole / Akhaj. Only one cut type should carry this flag.</small></span></label>
        <label class="check"><input type="checkbox" name="is_active" ${cut === null || Number(cut.is_active) === 1 ? 'checked' : ''}>
          <span>Active</span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(cut?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test record</span></label>`,
      onSubmit: async (fd, node) => {
        const payload = {
          name: fd.get('name'),
          sort_order: Number(fd.get('sort_order') || 99),
          is_whole: node.querySelector('[name=is_whole]').checked,
          is_active: node.querySelector('[name=is_active]').checked,
          is_sample: node.querySelector('[name=is_sample]').checked,
        };
        if (cut) await API.put(`/api/meta/cut-types/${cut.id}`, payload);
        else await API.post('/api/meta/cut-types', payload);
        UI.ok('Saved.');
        await App.refreshMeta();
        Pages.masters();
      },
    });
  }

  function catForm(cat) {
    UI.modal({
      title: cat ? `Edit Category — ${cat.name}` : 'Add Item Category',
      submitLabel: 'Save',
      body: `
        <div class="note note-info">Ticking <b>Yield % is mandatory</b> makes every item in this
          category require a Yield %. Sheet generation is blocked while one is missing.</div>
        <label class="field"><span class="req">Name</span>
          <input name="name" required value="${UI.esc(cat?.name || '')}"></label>
        <label class="field"><span>Sort Order</span>
          <input type="number" name="sort_order" value="${Number(cat?.sort_order ?? 99)}"></label>
        <label class="check"><input type="checkbox" name="requires_yield" ${Number(cat?.requires_yield) === 1 ? 'checked' : ''}>
          <span>Yield % is mandatory for this category</span></label>
        <label class="check"><input type="checkbox" name="is_active" ${cat === null || Number(cat.is_active) === 1 ? 'checked' : ''}>
          <span>Active</span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(cat?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test record</span></label>`,
      onSubmit: async (fd, node) => {
        const payload = {
          name: fd.get('name'),
          sort_order: Number(fd.get('sort_order') || 99),
          requires_yield: node.querySelector('[name=requires_yield]').checked,
          is_active: node.querySelector('[name=is_active]').checked,
          is_sample: node.querySelector('[name=is_sample]').checked,
        };
        if (cat) await API.put(`/api/meta/item-categories/${cat.id}`, payload);
        else await API.post('/api/meta/item-categories', payload);
        UI.ok('Saved.');
        await App.refreshMeta();
        Pages.masters();
      },
    });
  }

  async function purge() {
    const okd = await UI.confirmDialog({
      title: 'Remove all sample data', danger: true, confirmLabel: 'Remove sample data',
      message: `Every record tagged <b>SAMPLE</b> will be permanently deleted — sample users,
        stations, locations, recipe items, cut types and categories.<br><br>
        Real master data is untouched.`,
    });
    if (!okd) return;
    try {
      const res = await API.del('/api/meta/sample-data');
      UI.ok(`Sample data removed: ${Object.entries(res.removed).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
      await App.refreshMeta();
      Pages.masters();
    } catch (e) { UI.err(e.message); }
  }

  // ------------------------------------------------------------- settings
  Pages.settings = async function () {
    const content = document.getElementById('content');
    const { settings } = await API.get('/api/meta/settings');

    // Friendlier labels than the raw storage keys.
    const LABELS = {
      cutoff_time: 'Daily order cutoff time',
      quantity_decimals: 'Decimal places on calculated quantities',
      quantity_rounding: 'Rounding mode',
    };

    const mode = Theme.get();
    const shown = Theme.resolved();

    content.innerHTML = `
      ${UI.pageHead({
        icon: '\u2699',
        title: 'System Settings',
        lead: 'Operational settings for the whole kitchen. Super Admin only.',
      })}

      <div class="card">
        <div class="card-head"><h3>Appearance</h3>
          <span class="card-sub">Saved on this device</span></div>
        <div class="card-body">
          <div class="setting-row">
            <div class="field">
              <span>Theme</span>
              <div class="segmented" id="themePicker">
                ${Theme.MODES.map((m) => `
                  <button type="button" data-mode="${m}" aria-pressed="${m === mode}">
                    <span aria-hidden="true">${Theme.LABELS[m].icon}</span>${UI.esc(Theme.LABELS[m].label)}
                  </button>`).join('')}
              </div>
              <span class="hint">
                ${mode === 'system'
                  ? `Following this device’s setting — currently showing <b>${Theme.LABELS[shown].label.toLowerCase()}</b>.`
                  : `Always ${Theme.LABELS[mode].label.toLowerCase()}, whatever this device is set to.`}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Operations</h3></div>
        <div class="card-body">
          ${settings.map((s) => `
            <div class="setting-row">
              <label class="field"><span>${UI.esc(LABELS[s.key] || s.key)}</span>
                <input data-key="${UI.esc(s.key)}" value="${UI.esc(s.value ?? '')}">
                <span class="hint">${UI.esc(s.description || '')}</span></label>
              <button class="btn" data-save="${UI.esc(s.key)}">Save</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="note note-info">
        <b>Appearance is a per-device choice, not a system-wide one.</b> Changing it here affects
        only this browser — every person, including counter staff on their phones, sets their own
        from the ☀/☾ button in the header. Machine stays blue and Manual stays orange in both themes.
      </div>
      <div class="note note-info">Cutoff time uses 24-hour HH:MM. The documented cutoff is
        <b>00:30</b> (12:30 AM), after night service.</div>`;

    content.querySelectorAll('#themePicker button').forEach((btn) => {
      btn.onclick = () => {
        Theme.set(btn.dataset.mode);
        UI.ok(`Appearance set to ${Theme.LABELS[btn.dataset.mode].label}.`);
        Pages.settings();
      };
    });

    content.querySelectorAll('[data-save]').forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.dataset.save;
        const value = content.querySelector(`[data-key="${key}"]`).value;
        try {
          await API.put(`/api/meta/settings/${encodeURIComponent(key)}`, { value });
          UI.ok(`${LABELS[key] || key} saved.`);
        } catch (e) { UI.err(e.message); }
      };
    });
  };
})();
