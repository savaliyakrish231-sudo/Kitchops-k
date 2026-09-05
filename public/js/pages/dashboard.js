/* DASHBOARD — answers two questions in order:
     1. What still needs setting up before sheets can be generated?
     2. Once set up, what does each station sheet look like today?

   The sheet list is built entirely from Station Master, which is what proves a
   newly added station is picked up with no code change. */
(function () {
  Pages.dashboard = async function () {
    const content = document.getElementById('content');
    const meta = App.meta || await App.refreshMeta();

    const [readiness, preview, recipes, users] = await Promise.all([
      API.get('/api/validation/sheet-readiness').catch((e) => ({ error: e.message })),
      API.get('/api/validation/station-preview').catch((e) => ({ error: e.message, sheets: [] })),
      App.can('recipes.view') ? API.get('/api/recipes').catch(() => ({ items: [] })) : { items: [] },
      App.can('users.view') ? API.get('/api/users').catch(() => ({ users: [] })) : { users: [] },
    ]);

    const setup = setupSteps(meta, recipes.items, users.users, readiness);
    const doneCount = setup.filter((s) => s.done).length;
    const ready = doneCount === setup.length;

    content.innerHTML = `
      ${UI.pageHead({
        icon: '▦',
        title: 'Prep Dashboard',
        lead: ready
          ? `Configuration is complete. Below is the sheet each active station would produce for ${UI.esc(preview.date || 'today')}.`
          : 'Finish the steps below and the station sheets become available. One sheet is generated per active station.',
        actions: UI.legend(),
      })}

      ${ready ? '' : setupCard(setup, doneCount)}

      ${statsRow(readiness, preview)}
      ${readinessBanner(readiness)}

      ${ready || (preview.sheets || []).length ? `
        <div class="section-title">Station sheets</div>
        ${(preview.sheets || []).map(sheetCard).join('')
          || `<div class="card">${UI.emptyState({
                icon: '⌗',
                title: 'No active stations yet',
                body: 'Each active station in Station Master generates its own sheet automatically.',
                actionLabel: App.can('stations.manage') ? 'Open Station Master' : null,
                actionId: 'gotoStations',
              })}</div>`}` : ''}

      ${(preview.frozenPackingOnly || []).length ? `
        <div class="section-title">Frozen — packing only</div>
        <div class="card">
          <div class="card-head"><h3>No station task is created for these</h3>
            <span class="card-sub">They are collected straight from the freezer</span></div>
          <div class="card-body tight">${UI.table([
            { key: 'item', label: 'Item' },
            { key: 'packingLine', label: 'Packing Sheet line', render: (r) => `<code>${UI.esc(r.packingLine)}</code>` },
          ], preview.frozenPackingOnly)}</div></div>` : ''}

      ${(preview.batchExcluded || []).length ? `
        <div class="section-title">Batch — not prepared daily</div>
        <div class="card"><div class="card-body tight">${UI.table([
          { key: 'item', label: 'Item' },
          { key: 'reason', label: 'Reason' },
        ], preview.batchExcluded)}</div></div>` : ''}`;

    UI.wireGoto(content);
    document.getElementById('gotoStations')?.addEventListener('click', () => { location.hash = 'stations'; });
  };

  /**
   * The documented order of data entry, each step reporting real counts so the
   * dashboard says what is actually missing rather than a generic welcome.
   */
  function setupSteps(meta, items, users, readiness) {
    const stations = (meta.stations || []).filter((s) => Number(s.is_active) === 1);
    const locations = (meta.locations || []).filter((l) => Number(l.is_active) === 1);
    const counterStaff = users.filter((u) => (u.stations || []).length);
    const withYield = items.filter((i) => i.yield_percent != null);
    const blocking = readiness.errors?.length || 0;

    return [
      {
        title: 'Add your stations',
        note: stations.length
          ? `${stations.length} active — ${stations.map((s) => UI.esc(s.name)).join(', ')}`
          : 'The sections of the kitchen. Everything else references them.',
        done: stations.length > 0,
        page: 'stations',
      },
      {
        title: 'Add your locations',
        note: locations.length
          ? `${locations.length} active — ${locations.map((l) => UI.esc(l.name)).join(', ')}`
          : 'The outlets that submit daily requirements. Needed for per-location cut overrides.',
        done: locations.length > 0,
        page: 'locations',
      },
      {
        title: 'Add your people',
        note: users.length
          ? `${users.length} users, ${counterStaff.length} assigned to a station`
          : 'Counter staff, location managers and admins.',
        done: users.length > 1,
        page: 'users',
      },
      {
        title: 'Assign staff to each station',
        note: counterStaff.length
          ? `${counterStaff.length} person(s) rostered`
          : 'A station with nobody assigned cannot have its tasks distributed.',
        done: counterStaff.length > 0,
        page: 'counter',
      },
      {
        title: 'Enter the recipe items',
        note: items.length
          ? `${items.length} item(s), ${withYield.length} with a Yield %`
          : 'Each item needs its station, unit, cut method and Yield %.',
        done: items.length > 0,
        page: 'recipes',
      },
      {
        title: 'Clear the blocking errors',
        note: blocking
          ? `${blocking} item(s) still block sheet generation`
          : items.length ? 'Nothing is blocking sheet generation.' : 'Runs once recipe items exist.',
        done: items.length > 0 && blocking === 0,
        page: 'recipes',
      },
    ];
  }

  function setupCard(steps, done) {
    return `
      <div class="card">
        <div class="card-head">
          <h3>Getting set up</h3>
          <span class="card-sub">${done} of ${steps.length} done</span>
          <div class="spacer"></div>
        </div>
        <div class="card-body" style="padding-bottom:0">
          ${UI.progress(done, steps.length)}
        </div>
        <div class="card-body tight">${UI.checklist(steps)}</div>
      </div>`;
  }

  function statsRow(readiness, preview) {
    if (readiness.error) return '';
    const blocked = readiness.errors?.length || 0;
    return `<div class="grid grid-4" style="margin-bottom:var(--sp-4)">
      ${UI.stat({
        label: 'Active stations', value: preview.stationCount ?? 0,
        sub: 'each generates a sheet', tone: 'info',
      })}
      ${UI.stat({
        label: 'Items checked', value: readiness.checkedItems ?? 0,
        sub: `${readiness.routed?.length ?? 0} routed to stations`,
      })}
      ${UI.stat({
        label: 'Frozen', value: readiness.packingOnly?.length ?? 0,
        sub: 'packing only, no station task',
      })}
      ${UI.stat({
        label: 'Blocking errors', value: blocked,
        sub: blocked ? 'sheets cannot generate' : 'nothing blocked',
        tone: blocked ? 'danger' : 'ok',
      })}
    </div>`;
  }

  function readinessBanner(r) {
    if (r.error) return `<div class="note note-warn"><div>${UI.esc(r.error)}</div></div>`;
    if (r.canGenerate) {
      const staffing = (r.staffingWarnings || []).map((w) => UI.esc(w.message)).join(' ');
      return `<div class="note note-ok"><div>
        <b>All configuration checks pass — sheet generation is not blocked.</b>
        ${staffing ? `<br>${staffing}` : ''}
        ${r.warnings?.length
          ? `<ul>${r.warnings.slice(0, 6).map((w) => `<li>${UI.esc(w.message)}</li>`).join('')}</ul>` : ''}
      </div></div>`;
    }
    return `<div class="note note-danger"><div>
      <b>Sheet generation is blocked — ${r.errors.length} error(s) to fix in the Recipe DB.</b>
      <ul>${r.errors.slice(0, 8).map((e) => `<li>${UI.esc(e.message)}</li>`).join('')}</ul>
      ${r.errors.length > 8 ? `<div>…and ${r.errors.length - 8} more.</div>` : ''}
    </div></div>`;
  }

  function sheetCard(s) {
    const rows = s.rows.map((r) => ({ ...r, __rowClass: UI.methodRowClass(r.method) }));
    const staffed = s.staff.filter((p) => p.available).length;
    return `
      <div class="card card-accent" style="border-left-color:${UI.esc(s.station.sheetColour)}">
        <div class="card-head">
          <h3>${s.station.sheetLabel ? `${UI.esc(s.station.sheetLabel)}) ` : ''}${UI.esc(s.station.name)}</h3>
          <span class="badge chip-neutral">${UI.esc(s.station.typeName)}</span>
          ${s.blocked ? '<span class="badge chip-danger">Blocked</span>' : ''}
          <div class="spacer"></div>
          <span class="card-sub">${s.itemCount} item(s) · ${staffed} person(s) available</span>
        </div>
        <div class="card-body tight">
          ${s.itemCount ? UI.table([
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
          ], rows) : UI.emptyState({
            icon: '🥕',
            // emptyState escapes the title itself — do not pre-escape it.
            title: `Nothing routed to ${s.station.name} yet`,
            body: 'Assign recipe items to this station and they appear here.',
          })}
        </div>
        ${s.taskDistribution.length ? `
          <div class="card-head" style="border-top:1px solid var(--line);border-bottom:0">
            <h3 style="font-size:var(--t-sm)">Task distribution (round-robin)</h3></div>
          <div class="card-body tight">${UI.table([
            { key: 'fullName', label: 'Person' },
            { key: 'taskCount', label: 'Tasks', className: 'num' },
            { label: 'Items', render: (p) => p.items.map(UI.esc).join(', ') || '—' },
          ], s.taskDistribution)}</div>` : ''}
        ${s.warnings.length ? `<div class="card-body"><div class="note note-warn" style="margin:0">
          <div>${s.warnings.map(UI.esc).join('<br>')}</div></div></div>` : ''}
      </div>`;
  }
})();
