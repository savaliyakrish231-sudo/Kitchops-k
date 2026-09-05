/* RECIPE DATABASE — item configuration, Yield %, peeling, cut method,
   Whole/Akhaj, storage type, prep frequency and per-location cut overrides.

   The Station dropdown is built from App.stations(), which comes from Station
   Master via the API. There is no station list in this file. */
(function () {
  const filters = { search: '', stationId: '', storageType: '', prepFrequency: '', missingYieldOnly: '' };

  Pages.recipes = async function () {
    const content = document.getElementById('content');
    const meta = App.meta || await App.refreshMeta();
    const [{ items }, readiness, pendingYield] = await Promise.all([
      API.get('/api/recipes', filters),
      API.get('/api/validation/sheet-readiness').catch(() => null),
      API.get('/api/recipes/yield-changes/pending').catch(() => ({ pending: [] })),
    ]);

    const stationOptions = App.stations({ activeOnly: false });

    content.innerHTML = `
      ${UI.pageHead({
        icon: '\u{1F955}',
        title: 'Recipe Database',
        lead: 'The configuration behind every station sheet: which station handles an item, its '
          + 'Yield %, cut type and method, peeling, storage type and prep frequency.',
        actions: '<button class="btn" id="yieldCalc">Yield calculator</button>'
          + (App.can('recipes.manage') ? '<button class="btn btn-primary" id="addItem">+ Add Item</button>' : ''),
      })}

      ${pendingYield.pending.length ? recalcBanner(pendingYield.pending) : ''}
      ${readiness ? readinessBanner(readiness) : ''}

      <div class="card">
        <div class="card-head">
          <h3>Recipe items</h3>
          <span class="card-sub">${items.length} shown</span>
          <div class="spacer"></div>
          ${UI.legend()}
        </div>
        <div class="card-head" style="border-top:1px solid var(--line)">
          <div class="filters">
            <input id="fSearch" placeholder="Search item" value="${UI.esc(filters.search)}">
            <select id="fStation">
              <option value="">All stations</option>
              ${stationOptions.map((s) => `<option value="${s.id}" ${String(filters.stationId) === String(s.id) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('')}
            </select>
            <select id="fStorage">
              <option value="">All storage types</option>
              ${meta.storageTypes.map((t) => `<option value="${t}" ${filters.storageType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <select id="fPrep">
              <option value="">Daily + batch</option>
              ${meta.prepFrequencies.map((t) => `<option value="${t}" ${filters.prepFrequency === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <select id="fYield">
              <option value="">All items</option>
              <option value="true" ${filters.missingYieldOnly === 'true' ? 'selected' : ''}>Missing Yield % only</option>
            </select>
          </div>
        </div>
        <div class="card-body tight">${renderTable(items)}</div>
      </div>`;

    const openAdd = () => openForm(null, meta);
    document.getElementById('addItem')?.addEventListener('click', openAdd);
    document.getElementById('addItemEmpty')?.addEventListener('click', openAdd);
    document.getElementById('yieldCalc').onclick = () => openYieldCalculator(items);

    document.getElementById('fSearch').oninput = debounce((e) => { filters.search = e.target.value; Pages.recipes(); }, 350);
    document.getElementById('fStation').onchange = (e) => { filters.stationId = e.target.value; Pages.recipes(); };
    document.getElementById('fStorage').onchange = (e) => { filters.storageType = e.target.value; Pages.recipes(); };
    document.getElementById('fPrep').onchange = (e) => { filters.prepFrequency = e.target.value; Pages.recipes(); };
    document.getElementById('fYield').onchange = (e) => { filters.missingYieldOnly = e.target.value; Pages.recipes(); };

    content.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const item = items.find((i) => i.id === Number(btn.dataset.id));
        const act = btn.dataset.act;
        if (act === 'edit') openForm(item, meta);
        if (act === 'yield') openYieldEditor(item);
        if (act === 'overrides') openOverrides(item, meta);
        if (act === 'toggle') toggleStatus(item);
        if (act === 'recalc') resolveRecalc(Number(btn.dataset.change), true);
        if (act === 'dismiss') resolveRecalc(Number(btn.dataset.change), false);
      };
    });
  };

  // ------------------------------------------------------------- banners
  function readinessBanner(r) {
    if (r.canGenerate && !r.errors.length) {
      return `<div class="note note-ok"><b>Recipe DB is ready for sheet generation.</b>
        ${r.checkedItems} active item(s) checked · ${r.routed.length} routed to stations ·
        ${r.packingOnly.length} frozen (packing only) · ${r.excludedBatch.length} batch (excluded from daily).</div>`;
    }
    const byMsg = r.errors.slice(0, 12);
    return `<div class="note note-danger">
      <b>Sheet generation is blocked — ${r.errors.length} configuration error(s).</b>
      ${r.blockedStations.length ? `Affected stations: ${r.blockedStations.map(UI.esc).join(', ')}.` : ''}
      <ul>${byMsg.map((e) => `<li>${UI.esc(e.message)}</li>`).join('')}</ul>
      ${r.errors.length > 12 ? `<div style="margin-top:5px">…and ${r.errors.length - 12} more.</div>` : ''}
    </div>`;
  }

  function recalcBanner(pending) {
    return `<div class="note note-warn">
      <b>Recalculate all sheets?</b> Yield % changed after sheets were generated for
      ${pending.length} item(s).
      <ul>${pending.map((p) => `<li>
        ${UI.esc(p.item_name)}: ${p.old_yield ?? '—'}% → ${p.new_yield ?? '—'}%
        <button class="btn btn-sm" data-act="recalc" data-change="${p.id}">Recalculate</button>
        <button class="btn btn-sm btn-ghost" data-act="dismiss" data-change="${p.id}">Dismiss</button>
      </li>`).join('')}</ul></div>`;
  }

  async function resolveRecalc(changeId, confirm) {
    try {
      const res = await API.post(`/api/recipes/yield-changes/${changeId}/recalculate`, { confirm });
      UI.ok(confirm ? `${res.sheetsMarkedStale} sheet(s) marked for recalculation.` : 'Recalculation dismissed.');
      Pages.recipes();
    } catch (e) { UI.err(e.message); }
  }

  // --------------------------------------------------------------- table
  function renderTable(items) {
    const manage = App.can('recipes.manage');
    return UI.table([
      {
        key: 'item_name', label: 'Item',
        render: (i) => `<b>${UI.esc(i.item_name)}</b>${UI.sampleTag(i.is_sample)}
          ${Number(i.is_active) !== 1 ? ' <span class="badge chip-danger">Inactive</span>' : ''}
          ${Number(i.is_filling_ingredient) === 1 ? ' <span class="badge chip-info">Filling</span>' : ''}`,
      },
      {
        label: 'Station',
        render: (i) => (i.station_name
          ? UI.stationDot(i.station_sheet_colour, i.station_name)
          : '<span class="badge chip-danger">Not set</span>'),
      },
      { key: 'unit_code', label: 'Unit', render: (i) => UI.esc(i.unit_code || '—') },
      {
        label: 'Cut Type',
        render: (i) => (Number(i.whole_akhaj) === 1
          ? '<span class="badge chip-warn">WHOLE (Akhaj)</span>'
          : UI.esc(i.cut_type_name || '—')),
      },
      { label: 'Method', render: (i) => UI.methodBadge(i.default_cut_method) },
      {
        label: 'Peeling',
        render: (i) => (Number(i.needs_peeling) === 1
          ? UI.methodBadge(i.peeling_method)
          : '<span style="color:var(--ink-3)">No</span>'),
      },
      {
        label: 'Yield %', className: 'num',
        render: (i) => {
          if (i.yield_percent !== null && i.yield_percent !== undefined) {
            return `<b>${Number(i.yield_percent)}%</b>`;
          }
          return Number(i.category_requires_yield) === 1
            ? '<span class="badge chip-danger">Missing</span>'
            : '<span style="color:var(--ink-3)">n/a</span>';
        },
      },
      {
        label: 'Storage',
        render: (i) => (i.storage_type === 'FROZEN'
          ? '<span class="badge chip-info">FROZEN</span>'
          : `<span class="badge chip-neutral">${UI.esc(i.storage_type)}</span>`),
      },
      {
        label: 'Prep',
        render: (i) => (i.prep_frequency === 'BATCH'
          ? '<span class="badge chip-warn">BATCH</span>'
          : '<span class="badge chip-neutral">DAILY</span>'),
      },
      {
        label: 'Routing',
        render: (i) => {
          const r = i.routing;
          if (r.route === 'STATION') return '<span class="badge chip-ok">Station task</span>';
          if (r.route === 'PACKING_ONLY') return '<span class="badge chip-info">Packing only</span>';
          if (r.route === 'BLOCKED_BATCH') return '<span class="badge chip-warn">Not daily</span>';
          return '<span class="badge chip-danger">Unroutable</span>';
        },
      },
      {
        label: 'Ready',
        render: (i) => (i.ready
          ? '<span class="badge chip-ok">OK</span>'
          : `<span class="badge chip-danger" title="${UI.esc(i.issues.map((x) => x.message).join(' '))}">${i.issueCount} issue${i.issueCount === 1 ? '' : 's'}</span>`),
      },
      {
        label: 'Actions',
        render: (i) => `<div class="row-actions">
          ${manage ? `<button class="btn btn-sm" data-act="edit" data-id="${i.id}">Edit</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="yield" data-id="${i.id}">Yield</button>` : ''}
          ${manage ? `<button class="btn btn-sm" data-act="overrides" data-id="${i.id}">Overrides</button>` : ''}
          ${manage ? `<button class="btn btn-sm btn-ghost" data-act="toggle" data-id="${i.id}">${Number(i.is_active) === 1 ? 'Deactivate' : 'Activate'}</button>` : ''}
        </div>`,
      },
    ], items, UI.emptyState({
      icon: '\u{1F955}',
      title: 'No recipe items yet',
      body: 'Every item needs a station, a unit, and — for vegetables and juices — a Yield %. '
        + 'Sheet generation stays blocked until those are set.',
      actionLabel: manage ? '+ Add the first item' : null,
      actionId: 'addItemEmpty',
    }));
  }

  // ---------------------------------------------------------------- form
  function openForm(item, meta) {
    const isEdit = Boolean(item);
    const stations = App.stations({ activeOnly: true });

    const m = UI.modal({
      title: isEdit ? `Edit Item — ${item.item_name}` : 'Add Recipe Item',
      wide: true,
      submitLabel: isEdit ? 'Save changes' : 'Create item',
      body: `
        <div class="form-grid">
          <label class="field"><span class="req">Item Name</span>
            <input name="item_name" required value="${UI.esc(item?.item_name || '')}"></label>

          <!-- Station options come from Station Master. Nothing is hardcoded here. -->
          <label class="field"><span class="req">Station</span>
            <select name="station_id" id="stationSel" required>
              <option value="">Select a station…</option>
              ${stations.map((s) => `<option value="${s.id}"
                data-cutmethod="${s.requires_cut_method}" data-cuttype="${s.requires_cut_type}"
                ${Number(item?.station_id) === Number(s.id) ? 'selected' : ''}>${UI.esc(s.name)}</option>`).join('')}
            </select>
            <span class="hint">From Station Master. New stations appear here automatically.</span></label>

          <label class="field"><span>Item Category</span>
            <select name="category_id" id="categorySel">
              <option value="">Select a category…</option>
              ${meta.itemCategories.map((c) => `<option value="${c.id}" data-yield="${c.requires_yield}"
                ${Number(item?.category_id) === Number(c.id) ? 'selected' : ''}>${UI.esc(c.name)}${Number(c.requires_yield) === 1 ? ' — Yield % required' : ''}</option>`).join('')}
            </select>
            <span class="hint">Decides whether Yield % is mandatory.</span></label>

          <label class="field"><span>Unit</span>
            <select name="unit_code" id="unitSel">
              <option value="">Select a unit…</option>
              ${meta.units.map((u) => `<option value="${u.code}" data-pcs="${u.allows_piece_weight}"
                ${item?.unit_code === u.code ? 'selected' : ''}>${UI.esc(u.code)} — ${UI.esc(u.name)}</option>`).join('')}
            </select></label>
        </div>

        <h4 style="margin:6px 0 8px;font-size:13px;color:var(--ink-2)">Cutting</h4>
        <label class="check"><input type="checkbox" name="whole_akhaj" id="wholeChk" ${Number(item?.whole_akhaj) === 1 ? 'checked' : ''}>
          <span>Whole / Akhaj<small>Cut type is set to WHOLE and the row becomes MANUAL (Orange). Yield % still applies.</small></span></label>

        <div class="form-grid">
          <label class="field"><span id="cutTypeLbl">Default Cutting Type</span>
            <select name="default_cut_type_id" id="cutTypeSel">
              <option value="">Select a cut type…</option>
              ${meta.cutTypes.map((c) => `<option value="${c.id}" data-whole="${c.is_whole}"
                ${Number(item?.default_cut_type_id) === Number(c.id) ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('')}
            </select></label>
          <label class="field"><span id="cutMethodLbl">Default Cut Method</span>
            <select name="default_cut_method" id="cutMethodSel">
              <option value="">Select a method…</option>
              <option value="MACHINE" ${item?.default_cut_method === 'MACHINE' ? 'selected' : ''}>MACHINE (Blue)</option>
              <option value="MANUAL" ${item?.default_cut_method === 'MANUAL' ? 'selected' : ''}>MANUAL (Orange)</option>
            </select>
            <span class="hint">Sets the row colour on the station sheet and on mobile.</span></label>
        </div>

        <h4 style="margin:6px 0 8px;font-size:13px;color:var(--ink-2)">Peeling</h4>
        <label class="check"><input type="checkbox" name="needs_peeling" id="peelChk" ${Number(item?.needs_peeling) === 1 ? 'checked' : ''}>
          <span>Needs Peeling<small>A peeling-type station handles this item first, then passes the net quantity on.</small></span></label>
        <div id="peelBlock" hidden>
          <label class="field"><span class="req">Peeling Method</span>
            <select name="peeling_method" id="peelMethodSel">
              <option value="">Select a method…</option>
              <option value="MACHINE" ${item?.peeling_method === 'MACHINE' ? 'selected' : ''}>MACHINE (Blue)</option>
              <option value="MANUAL" ${item?.peeling_method === 'MANUAL' ? 'selected' : ''}>MANUAL (Orange)</option>
            </select>
            <span class="hint">Required when Needs Peeling is on. Sets the colour on the peeling sheet.</span></label>
        </div>

        <h4 style="margin:6px 0 8px;font-size:13px;color:var(--ink-2)">Yield &amp; weight</h4>
        <div class="form-grid">
          <label class="field"><span id="yieldLbl">Yield %</span>
            <input type="number" name="yield_percent" id="yieldInput" step="0.01" min="0.01" max="100"
                   value="${item?.yield_percent ?? ''}" placeholder="e.g. 79">
            <span class="hint" id="yieldHint">Raw Qty = Net Qty ÷ (Yield % ÷ 100).</span></label>
          <label class="field"><span>Piece Weight</span>
            <input type="number" name="piece_weight" id="pieceInput" step="0.01" min="0" value="${item?.piece_weight ?? ''}">
            <span class="hint" id="pieceHint">Applies only when Unit = PCS.</span></label>
        </div>
        <div id="yieldPreview"></div>

        <h4 style="margin:12px 0 8px;font-size:13px;color:var(--ink-2)">Storage &amp; frequency</h4>
        <div class="form-grid">
          <label class="field"><span class="req">Storage Type</span>
            <select name="storage_type" id="storageSel" required>
              ${meta.storageTypes.map((t) => `<option value="${t}" ${(item?.storage_type || 'FRESH') === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <span class="hint" id="storageHint"></span></label>
          <label class="field"><span class="req">Prep Frequency</span>
            <select name="prep_frequency" id="prepSel" required>
              ${meta.prepFrequencies.map((t) => `<option value="${t}" ${(item?.prep_frequency || 'DAILY') === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <span class="hint" id="prepHint"></span></label>
        </div>
        <div class="form-grid" id="shelfBlock" hidden>
          <label class="field"><span>Shelf Life</span>
            <input type="number" name="shelf_life_value" step="0.5" min="0" value="${item?.shelf_life_value ?? ''}"></label>
          <label class="field"><span>Shelf Life Unit</span>
            <select name="shelf_life_unit">
              <option value="">—</option>
              ${meta.shelfLifeUnits.map((u) => `<option value="${u}" ${item?.shelf_life_unit === u ? 'selected' : ''}>${u}</option>`).join('')}
            </select></label>
        </div>

        <label class="check"><input type="checkbox" name="is_filling_ingredient" ${Number(item?.is_filling_ingredient) === 1 ? 'checked' : ''}>
          <span>Is Filling Ingredient<small>Stuffing inside momo / dumpling. The item appears on its own station sheet and on the Filling Sheet.</small></span></label>
        <label class="check"><input type="checkbox" name="is_active" ${item === null || Number(item.is_active) === 1 ? 'checked' : ''}>
          <span>Active</span></label>
        <label class="check"><input type="checkbox" name="is_sample" ${Number(item?.is_sample) === 1 ? 'checked' : ''}>
          <span>Sample / test record</span></label>
        <label class="field"><span>Notes</span><textarea name="notes">${UI.esc(item?.notes || '')}</textarea></label>`,

      onSubmit: async (fd, node) => {
        const chk = (n) => node.querySelector(`[name=${n}]`).checked;
        const payload = {
          item_name: fd.get('item_name'),
          station_id: fd.get('station_id') || null,
          category_id: fd.get('category_id') || null,
          unit_code: fd.get('unit_code') || null,
          default_cut_type_id: fd.get('default_cut_type_id') || null,
          default_cut_method: fd.get('default_cut_method') || null,
          whole_akhaj: chk('whole_akhaj'),
          needs_peeling: chk('needs_peeling'),
          peeling_method: fd.get('peeling_method') || null,
          yield_percent: fd.get('yield_percent') || null,
          piece_weight: fd.get('piece_weight') || null,
          is_filling_ingredient: chk('is_filling_ingredient'),
          prep_frequency: fd.get('prep_frequency'),
          shelf_life_value: fd.get('shelf_life_value') || null,
          shelf_life_unit: fd.get('shelf_life_unit') || null,
          storage_type: fd.get('storage_type'),
          is_active: chk('is_active'),
          is_sample: chk('is_sample'),
          notes: fd.get('notes'),
        };
        const res = isEdit
          ? await API.put(`/api/recipes/${item.id}`, payload)
          : await API.post('/api/recipes', payload);

        UI.ok(isEdit ? 'Recipe item updated.' : 'Recipe item created.');
        (res.autoAdjustments || []).forEach((n) => UI.toast(n));
        if (res.errors?.length) {
          UI.err(`Saved, but sheet generation is blocked: ${res.errors[0].message}`);
        }
        if (res.recalculation?.requiresRecalculation) {
          promptRecalculation(res.recalculation);
        }
        Pages.recipes();
      },
    });

    wireFormLogic(m.node, item);
  }

  /** Live rule feedback inside the form — mirrors the server-side rules. */
  function wireFormLogic(node, item) {
    const q = (s) => node.querySelector(s);
    const wholeChk = q('#wholeChk');
    const peelChk = q('#peelChk');
    const cutTypeSel = q('#cutTypeSel');
    const cutMethodSel = q('#cutMethodSel');
    const stationSel = q('#stationSel');
    const categorySel = q('#categorySel');
    const unitSel = q('#unitSel');
    const yieldInput = q('#yieldInput');
    const storageSel = q('#storageSel');
    const prepSel = q('#prepSel');

    function apply() {
      // Whole / Akhaj forces WHOLE + MANUAL.
      if (wholeChk.checked) {
        const wholeOpt = Array.from(cutTypeSel.options).find((o) => o.dataset.whole === '1');
        if (wholeOpt) cutTypeSel.value = wholeOpt.value;
        cutMethodSel.value = 'MANUAL';
        cutTypeSel.disabled = true;
        cutMethodSel.disabled = true;
      } else {
        cutTypeSel.disabled = false;
        cutMethodSel.disabled = false;
      }

      // Peeling method appears (and is required) only when Needs Peeling is on.
      q('#peelBlock').hidden = !peelChk.checked;
      q('#peelMethodSel').required = peelChk.checked;

      // Cutting-type station makes cut type + method mandatory.
      const stnOpt = stationSel.selectedOptions[0];
      const needsCut = stnOpt?.dataset.cutmethod === '1';
      q('#cutTypeLbl').className = needsCut && !wholeChk.checked ? 'req' : '';
      q('#cutMethodLbl').className = needsCut && !wholeChk.checked ? 'req' : '';

      // Yield mandatory follows the category flag.
      const catOpt = categorySel.selectedOptions[0];
      const needsYield = catOpt?.dataset.yield === '1';
      q('#yieldLbl').className = needsYield ? 'req' : '';
      q('#yieldHint').textContent = needsYield
        ? 'Mandatory for this category. Sheet generation is blocked while it is missing.'
        : 'Raw Qty = Net Qty ÷ (Yield % ÷ 100).';

      // Piece weight only for PCS-style units.
      const isPcs = unitSel.selectedOptions[0]?.dataset.pcs === '1';
      q('#pieceInput').disabled = !isPcs;
      q('#pieceHint').textContent = isPcs
        ? 'Optional. Weight of one piece.' : 'Applies only when Unit = PCS.';

      // Storage / frequency consequences.
      q('#storageHint').textContent = storageSel.value === 'FROZEN'
        ? 'FROZEN: no station task is created. The item appears on the Packing Sheet only, as “Take from Freezer”.'
        : storageSel.value === 'DRY' ? 'Dry store item.' : 'Cut fresh daily.';
      q('#prepHint').textContent = prepSel.value === 'BATCH'
        ? 'BATCH: excluded from daily prep sheets. Ordering it on the daily form is blocked.'
        : 'Prepared every morning as needed.';
      q('#shelfBlock').hidden = prepSel.value !== 'BATCH';

      renderYieldPreview();
    }

    function renderYieldPreview() {
      const y = Number(yieldInput.value);
      const box = q('#yieldPreview');
      if (!(y > 0 && y <= 100)) { box.innerHTML = ''; return; }
      const net = 1000;
      const raw = Math.round(net / (y / 100));
      box.innerHTML = `<div class="note note-info" style="margin-bottom:0">
        <b>Yield check.</b> At ${y}%, a net requirement of ${net} would need
        <b>${raw}</b> raw — ${net} ÷ ${(y / 100).toFixed(4)} = ${(net / (y / 100)).toFixed(2)}.</div>`;
    }

    [wholeChk, peelChk, stationSel, categorySel, unitSel, storageSel, prepSel].forEach((e) => { e.onchange = apply; });
    yieldInput.oninput = renderYieldPreview;
    apply();
  }

  // -------------------------------------------------------- yield editing
  function openYieldEditor(item) {
    UI.modal({
      title: `Yield % — ${item.item_name}`,
      body: `
        <div class="note note-info">
          <b>Raw Qty = Net Qty ÷ (Yield % ÷ 100).</b>
          At 79%, 1000 GM net needs 1000 ÷ 0.79 = 1266 GM raw.
        </div>
        ${Number(item.category_requires_yield) === 1
          ? '<div class="note note-warn">Yield % is mandatory for this item\'s category. Sheet generation is blocked while it is missing.</div>' : ''}
        <label class="field"><span>Yield %</span>
          <input type="number" name="yield_percent" step="0.01" min="0.01" max="100"
                 value="${item.yield_percent ?? ''}" autofocus>
          <span class="hint">Leave blank to clear. Never assumed to be 100%.</span></label>
        <div id="preview"></div>`,
      submitLabel: 'Save Yield %',
      onSubmit: async (fd) => {
        const res = await API.patch(`/api/recipes/${item.id}/yield`, {
          yield_percent: fd.get('yield_percent') || null,
        });
        UI.ok('Yield % saved.');
        if (res.recalculation?.requiresRecalculation) promptRecalculation(res.recalculation);
        Pages.recipes();
      },
    });
  }

  function promptRecalculation(recalc) {
    UI.modal({
      title: 'Recalculate all sheets?',
      body: `<p style="margin-top:0;line-height:1.55">
          Yield % changed from <b>${recalc.oldYield ?? '—'}%</b> to <b>${recalc.newYield ?? '—'}%</b>
          after station sheets had already been generated.</p>
        <div class="note note-warn"><b>Affected sheets</b>
          <ul>${recalc.affectedSheets.map((s) => `<li>${UI.esc(s.stationName)} — ${UI.esc(s.workDate)}</li>`).join('')}</ul>
        </div>
        <p style="margin-bottom:0">Confirm to mark these sheets for recalculation with the new yield.</p>`,
      submitLabel: 'Recalculate',
      footerExtra: `<button class="btn" type="button" id="dismissRecalc">Keep existing sheets</button>`,
      onSubmit: async () => {
        const res = await API.post(`/api/recipes/yield-changes/${recalc.changeId}/recalculate`, { confirm: true });
        UI.ok(`${res.sheetsMarkedStale} sheet(s) marked for recalculation.`);
        Pages.recipes();
      },
    });
    document.getElementById('dismissRecalc').onclick = async () => {
      await API.post(`/api/recipes/yield-changes/${recalc.changeId}/recalculate`, { confirm: false });
      document.getElementById('modalHost').hidden = true;
      document.getElementById('modalHost').innerHTML = '';
      UI.toast('Existing sheets kept.');
      Pages.recipes();
    };
  }

  function openYieldCalculator(items) {
    const m = UI.modal({
      title: 'Yield calculator',
      body: `
        <div class="note note-info">Uses the same calculation service as sheet generation:
          <b>Raw Qty = Net Qty ÷ (Yield % ÷ 100)</b>.</div>
        <div class="form-grid">
          <label class="field"><span>Recipe item</span>
            <select id="calcItem"><option value="">Enter a yield manually…</option>
              ${items.map((i) => `<option value="${i.id}" data-y="${i.yield_percent ?? ''}">${UI.esc(i.item_name)}</option>`).join('')}
            </select></label>
          <label class="field"><span>Net quantity</span>
            <input type="number" id="calcNet" value="1000" step="0.01" min="0"></label>
          <label class="field"><span>Yield %</span>
            <input type="number" id="calcYield" step="0.01" min="0.01" max="100" placeholder="e.g. 79"></label>
        </div>
        <div id="calcOut"></div>`,
      submitLabel: 'Calculate',
      onSubmit: async (fd, node) => {
        const itemId = node.querySelector('#calcItem').value;
        const body = { netQuantity: Number(node.querySelector('#calcNet').value) };
        if (itemId) body.itemId = Number(itemId);
        const y = node.querySelector('#calcYield').value;
        if (y) body.yieldPercent = Number(y);
        try {
          const r = await API.post('/api/validation/yield-calculator', body);
          node.querySelector('#calcOut').innerHTML = `<div class="note note-ok">
            <b>Raw Quantity = ${r.rawQuantity}</b><br>
            ${r.netQuantity} ÷ ${r.yieldFraction} = ${r.rawQuantityExact.toFixed(4)} → rounded to ${r.rawQuantity}<br>
            Processing loss: ${r.wasteQuantity}</div>`;
        } catch (ex) {
          node.querySelector('#calcOut').innerHTML = `<div class="note note-danger">${UI.esc(ex.message)}</div>`;
        }
        return false; // keep the dialog open
      },
    });
    m.node.querySelector('#calcItem').onchange = (e) => {
      const y = e.target.selectedOptions[0]?.dataset.y;
      if (y) m.node.querySelector('#calcYield').value = y;
    };
  }

  // ---------------------------------------------------- location overrides
  async function openOverrides(item, meta) {
    const data = await API.get(`/api/recipes/${item.id}/overrides`);
    const locations = App.locations({ activeOnly: true });

    if (Number(item.whole_akhaj) === 1) {
      UI.modal({
        title: `Location overrides — ${item.item_name}`,
        body: `<div class="note note-warn"><b>${UI.esc(item.item_name)} is marked Whole / Akhaj.</b>
          Its cut type is fixed to WHOLE and treated as MANUAL everywhere, so per-location cut
          overrides do not apply.</div>`,
        onSubmit: () => true,
      });
      return;
    }

    const m = UI.modal({
      title: `Location cutting overrides — ${item.item_name}`,
      wide: true,
      body: `
        <div class="note note-info">The same item can be cut differently at each location without
          duplicating the recipe row. A blank field inherits the item default
          (${UI.esc(item.cut_type_name || 'no cut type')} · ${UI.esc(item.default_cut_method || 'no method')}).</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Location</th><th>Cut Type</th><th>Method</th><th>Effective</th><th></th></tr></thead>
          <tbody>
            ${locations.map((loc) => {
              const ov = data.overrides.find((o) => o.location_id === loc.id);
              const plan = data.cutPlan.find((p) => p.locationId === loc.id);
              return `<tr>
                <td><b>${UI.esc(loc.name)}</b></td>
                <td><select data-loc="${loc.id}" data-f="cut">
                      <option value="">Inherit default</option>
                      ${meta.cutTypes.filter((c) => Number(c.is_whole) === 0).map((c) =>
                        `<option value="${c.id}" ${Number(ov?.cut_type_id) === Number(c.id) ? 'selected' : ''}>${UI.esc(c.name)}</option>`).join('')}
                    </select></td>
                <td><select data-loc="${loc.id}" data-f="method">
                      <option value="">Inherit default</option>
                      <option value="MACHINE" ${ov?.cut_method === 'MACHINE' ? 'selected' : ''}>MACHINE</option>
                      <option value="MANUAL" ${ov?.cut_method === 'MANUAL' ? 'selected' : ''}>MANUAL</option>
                    </select></td>
                <td>${plan ? `${UI.esc(plan.cutTypeName || '—')} ${UI.methodBadge(plan.cutMethod)}
                      ${plan.source === 'LOCATION_OVERRIDE' ? '<span class="badge chip-info">Override</span>' : ''}` : '—'}</td>
                <td class="row-actions">
                  <button class="btn btn-sm" type="button" data-save="${loc.id}">Save</button>
                  ${ov ? `<button class="btn btn-sm btn-ghost" type="button" data-clear="${loc.id}">Clear</button>` : ''}
                </td></tr>`;
            }).join('')}
          </tbody></table></div>
        ${locations.length ? '' : '<div class="empty">No active locations yet. Add them in Location Master first.</div>'}`,
      onSubmit: () => true,
    });

    m.node.querySelectorAll('[data-save]').forEach((btn) => {
      btn.onclick = async () => {
        const loc = btn.dataset.save;
        const cut = m.node.querySelector(`[data-loc="${loc}"][data-f=cut]`).value;
        const method = m.node.querySelector(`[data-loc="${loc}"][data-f=method]`).value;
        try {
          if (!cut && !method) {
            await API.del(`/api/recipes/${item.id}/overrides/${loc}`).catch(() => {});
            UI.ok('Override cleared — this location inherits the item default.');
          } else {
            await API.put(`/api/recipes/${item.id}/overrides/${loc}`, {
              cut_type_id: cut || null, cut_method: method || null,
            });
            UI.ok('Override saved.');
          }
          m.close();
          Pages.recipes();
        } catch (e) { UI.err(e.message); }
      };
    });
    m.node.querySelectorAll('[data-clear]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await API.del(`/api/recipes/${item.id}/overrides/${btn.dataset.clear}`);
          UI.ok('Override removed.');
          m.close();
          Pages.recipes();
        } catch (e) { UI.err(e.message); }
      };
    });
  }

  async function toggleStatus(item) {
    try {
      await API.patch(`/api/recipes/${item.id}/status`, { is_active: Number(item.is_active) !== 1 });
      UI.ok('Updated.');
      Pages.recipes();
    } catch (e) { UI.err(e.message); }
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
})();
