/* DASHBOARD — readiness of the master data plus the per-station sheet structure.
   The sheet list is built entirely from Station Master, which is what proves a
   newly added station is picked up with no code change. */
(function () {
  Pages.dashboard = async function () {
    const content = document.getElementById('content');
    const [readiness, preview] = await Promise.all([
      API.get('/api/validation/sheet-readiness').catch((e) => ({ error: e.message })),
      API.get('/api/validation/station-preview').catch((e) => ({ error: e.message, sheets: [] })),
    ]);

    if (readiness.error && preview.error) {
      content.innerHTML = `<div class="note note-warn">${UI.esc(readiness.error)}</div>`;
      return;
    }

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Prep Dashboard</h2>
          <p>Configuration readiness and the station sheet structure for ${UI.esc(preview.date || '')}.
             One sheet per active station in Station Master.</p>
        </div>
        <div class="page-actions">${UI.legend()}</div>
      </div>

      <div class="grid grid-4" style="margin-bottom:18px">
        <div class="stat"><div class="k">Active stations</div><div class="v">${preview.stationCount ?? 0}</div>
          <div class="s">each generates a sheet</div></div>
        <div class="stat"><div class="k">Items checked</div><div class="v">${readiness.checkedItems ?? 0}</div>
          <div class="s">${readiness.routed?.length ?? 0} routed to stations</div></div>
        <div class="stat"><div class="k">Frozen — packing only</div>
          <div class="v">${readiness.packingOnly?.length ?? 0}</div><div class="s">no station task</div></div>
        <div class="stat"><div class="k">Batch — excluded</div>
          <div class="v">${readiness.excludedBatch?.length ?? 0}</div><div class="s">not prepared daily</div></div>
      </div>

      ${readinessBanner(readiness)}

      ${(preview.sheets || []).map(sheetCard).join('')
        || '<div class="card"><div class="empty">No active stations yet. Add stations in Station Master.</div></div>'}

      ${(preview.frozenPackingOnly || []).length ? `
        <div class="card"><div class="card-head"><h3>Frozen items — Packing Sheet only</h3>
          <span class="card-sub">No cutting or preparation task is created for these.</span></div>
          <div class="card-body tight">${UI.table([
            { key: 'item', label: 'Item' },
            { key: 'packingLine', label: 'Packing Sheet line', render: (r) => `<code>${UI.esc(r.packingLine)}</code>` },
          ], preview.frozenPackingOnly)}</div></div>` : ''}

      ${(preview.batchExcluded || []).length ? `
        <div class="card"><div class="card-head"><h3>Batch items — excluded from daily prep</h3></div>
          <div class="card-body tight">${UI.table([
            { key: 'item', label: 'Item' },
            { key: 'reason', label: 'Reason' },
          ], preview.batchExcluded)}</div></div>` : ''}`;
  };

  function readinessBanner(r) {
    if (r.error) return `<div class="note note-warn">${UI.esc(r.error)}</div>`;
    if (r.canGenerate) {
      return `<div class="note note-ok"><b>All configuration checks pass — sheet generation is not blocked.</b>
        ${(r.staffingWarnings || []).length ? `<br>Staffing: ${r.staffingWarnings.map((w) => UI.esc(w.message)).join(' ')}` : ''}
        ${r.warnings?.length ? `<ul>${r.warnings.slice(0, 6).map((w) => `<li>${UI.esc(w.message)}</li>`).join('')}</ul>` : ''}</div>`;
    }
    return `<div class="note note-danger">
      <b>Sheet generation is blocked — ${r.errors.length} error(s) must be fixed in the Recipe DB.</b>
      <ul>${r.errors.slice(0, 10).map((e) => `<li>${UI.esc(e.message)}</li>`).join('')}</ul>
      ${r.errors.length > 10 ? `<div>…and ${r.errors.length - 10} more.</div>` : ''}</div>`;
  }

  function sheetCard(s) {
    const rows = s.rows.map((r) => ({ ...r, __rowClass: UI.methodRowClass(r.method) }));
    return `
      <div class="card">
        <div class="card-head" style="border-left:4px solid ${UI.esc(s.station.sheetColour)}">
          <h3>${s.station.sheetLabel ? `${UI.esc(s.station.sheetLabel)}) ` : ''}${UI.esc(s.station.name)} Sheet</h3>
          <span class="badge chip-neutral">${UI.esc(s.station.typeName)}</span>
          <span class="card-sub">${s.itemCount} item(s) · ${s.staff.filter((p) => p.available).length} person(s) available</span>
          ${s.blocked ? '<span class="badge chip-danger">Blocked</span>' : ''}
        </div>
        <div class="card-body tight">
          ${UI.table([
            { key: 'item', label: 'Item', render: (r) => `<b>${UI.esc(r.item)}</b>` },
            { key: 'cutType', label: 'Cut Type', render: (r) => UI.esc(r.cutType || '—') },
            { label: 'Method', render: (r) => UI.methodBadge(r.method) },
            {
              label: 'Peeling',
              render: (r) => (r.needsPeeling ? UI.methodBadge(r.peelingMethod) : '<span style="color:var(--ink-3)">—</span>'),
            },
            {
              label: 'Yield %', className: 'num',
              render: (r) => (r.yieldPercent != null ? `${Number(r.yieldPercent)}%` : '<span style="color:var(--ink-3)">—</span>'),
            },
            { key: 'unit', label: 'Unit', render: (r) => UI.esc(r.unit || '—') },
            {
              label: 'Config',
              render: (r) => (r.blocking.length
                ? `<span class="badge chip-danger" title="${UI.esc(r.blocking.map((b) => b.message).join(' '))}">${r.blocking.length} issue(s)</span>`
                : '<span class="badge chip-ok">OK</span>'),
            },
          ], rows, `No recipe items are routed to ${UI.esc(s.station.name)} yet.`)}
        </div>
        ${s.taskDistribution.length ? `
          <div class="card-head" style="border-top:1px solid var(--line)">
            <h3 style="font-size:13px">Task distribution (round-robin)</h3></div>
          <div class="card-body tight">${UI.table([
            { key: 'fullName', label: 'Person' },
            { key: 'taskCount', label: 'Tasks', className: 'num' },
            { label: 'Items', render: (p) => p.items.map(UI.esc).join(', ') || '—' },
          ], s.taskDistribution)}</div>` : ''}
        ${s.warnings.length ? `<div class="card-body"><div class="note note-warn" style="margin:0">
          ${s.warnings.map(UI.esc).join('<br>')}</div></div>` : ''}
      </div>`;
  }
})();
