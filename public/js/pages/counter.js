/* COUNTER SETTINGS — permanent staff assignment per station (1..N persons) and
   the separate Absent Today / Present marking for one date. */
(function () {
  let workDate = null;

  Pages.counter = async function () {
    const content = document.getElementById('content');
    const data = await API.get('/api/roster/overview', { date: workDate || undefined });
    workDate = data.date;

    const totalAssigned = data.stations.reduce((n, s) => n + s.assignedCount, 0);
    const totalAbsent = data.stations.reduce((n, s) => n + s.absentCount, 0);

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Counter Settings</h2>
          <p>Assign a fixed list of counter persons to each station. A station takes one person or
             six — there are no fixed slots. The list changes only on a permanent staff change.</p>
        </div>
        <div class="page-actions">
          <label class="field" style="margin:0">
            <span>Date</span>
            <input type="date" id="dateInput" value="${UI.esc(data.date)}">
          </label>
        </div>
      </div>

      <div class="grid grid-4" style="margin-bottom:18px">
        <div class="stat"><div class="k">Active stations</div><div class="v">${data.stations.length}</div></div>
        <div class="stat"><div class="k">Assignments</div><div class="v">${totalAssigned}</div>
          <div class="s">person-to-station links</div></div>
        <div class="stat"><div class="k">Absent today</div>
          <div class="v" style="${totalAbsent ? 'color:var(--warn)' : ''}">${totalAbsent}</div>
          <div class="s">for ${UI.esc(data.date)} only</div></div>
        <div class="stat"><div class="k">Unstaffed stations</div>
          <div class="v" style="${data.unstaffedStations.length ? 'color:var(--danger)' : ''}">${data.unstaffedStations.length}</div>
          <div class="s">no one available</div></div>
      </div>

      ${data.unstaffedStations.length ? `<div class="note note-warn">
        <b>No counter person is available at:</b> ${data.unstaffedStations.map(UI.esc).join(', ')}.
        Tasks for these stations cannot be distributed on ${UI.esc(data.date)}.</div>` : ''}

      ${data.stations.length ? data.stations.map((s) => stationCard(s, data)).join('')
        : '<div class="card"><div class="empty">No active stations yet. Add stations in Station Master first.</div></div>'}

      <div class="note note-info">
        <b>Permanent change vs. today's absence.</b> Editing a station's person list is a permanent
        staff change and applies from the next day. Marking someone <b>Absent Today</b> affects that
        one date only — their permanent assignment stays and their tasks redistribute to the rest of
        the station. Marking them <b>Present</b> again brings them back into the distribution.
      </div>`;

    document.getElementById('dateInput').onchange = (e) => { workDate = e.target.value; Pages.counter(); };

    content.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const stationId = Number(btn.dataset.station);
        const station = data.stations.find((s) => s.station.id === stationId);
        if (btn.dataset.act === 'assign') openAssign(station, data);
        if (btn.dataset.act === 'absent') mark(Number(btn.dataset.user), btn.dataset.status);
        if (btn.dataset.act === 'preview') openPreview(station);
      };
    });
  };

  function stationCard(s, data) {
    const canAssign = App.can('users.assign_stations');
    const canAttend = App.can('attendance.manage');
    return `
      <div class="card">
        <div class="card-head">
          <h3>${UI.stationDot(s.station.sheet_colour, s.station.name)}</h3>
          <span class="badge chip-neutral">${UI.esc(s.station.type_code)}</span>
          <span class="card-sub">${s.availableCount} of ${s.assignedCount} available on ${UI.esc(data.date)}</span>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-act="preview" data-station="${s.station.id}">Distribution preview</button>
          ${canAssign ? `<button class="btn btn-sm btn-primary" data-act="assign" data-station="${s.station.id}">Edit person list</button>` : ''}
        </div>
        <div class="card-body tight">
          ${UI.table([
            { key: 'fullName', label: 'Counter Person', render: (p) => `<b>${UI.esc(p.fullName)}</b>` },
            { key: 'username', label: 'Username' },
            {
              label: 'Today', render: (p) => (p.status === 'AVAILABLE'
                ? '<span class="badge chip-ok">Available</span>'
                : p.status === 'ABSENT_TODAY'
                  ? `<span class="badge chip-warn">Absent Today</span>${p.attendanceReason ? ` <span style="color:var(--ink-3)">${UI.esc(p.attendanceReason)}</span>` : ''}`
                  : '<span class="badge chip-danger">Inactive (permanent)</span>'),
            },
            {
              label: 'Actions',
              render: (p) => (canAttend && p.permanentlyActive
                ? `<div class="row-actions">
                     <button class="btn btn-sm" data-act="absent" data-station="${s.station.id}"
                       data-user="${p.userId}" data-status="${p.absentToday ? 'PRESENT' : 'ABSENT'}">
                       ${p.absentToday ? 'Mark Present' : 'Mark Absent Today'}</button>
                   </div>` : ''),
            },
          ], s.roster, 'No counter persons assigned to this station yet.')}
        </div>
      </div>`;
  }

  function openAssign(stationEntry, data) {
    const station = stationEntry.station;
    const currentIds = stationEntry.roster.map((p) => p.userId);
    const pool = data.counterPersonPool.filter((u) => Number(u.is_active) === 1);

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000);

    UI.modal({
      title: `Counter persons — ${station.name}`,
      submitLabel: 'Save person list',
      body: `
        <div class="note note-info">A station can have one or more persons. The list is fixed —
          there is no daily rotation. It changes only when permanent staff change.</div>
        ${UI.pickerFieldset('Assigned counter persons', 'user_ids',
          pool.map((u) => ({ id: u.id, label: UI.esc(u.full_name), sub: u.username })),
          currentIds,
          'No active users hold a station-assigned role yet. Create Counter Person users in User Master first.')}
        <label class="field"><span>Effective from</span>
          <select name="effective_from">
            <option value="${iso(tomorrow)}">Tomorrow (${iso(tomorrow)}) — permanent staff change</option>
            <option value="${iso(today)}">Today (${iso(today)}) — initial setup or correction</option>
          </select>
          <span class="hint">A permanent staff change applies from the next day. Today's sheets are unaffected.</span></label>`,
      onSubmit: async (fd, node) => {
        const res = await API.put(`/api/roster/stations/${station.id}/roster`, {
          user_ids: UI.checkedValues(node, 'user_ids'),
          effective_from: fd.get('effective_from'),
        });
        UI.ok(res.message);
        Pages.counter();
      },
    });
  }

  async function mark(userId, status) {
    try {
      const res = await API.post('/api/roster/attendance', { user_id: userId, status, date: workDate });
      UI.ok(res.message);
      res.redistribution.filter((r) => r.warning).forEach((r) => UI.err(r.warning));
      Pages.counter();
    } catch (e) { UI.err(e.message); }
  }

  async function openPreview(stationEntry) {
    const station = stationEntry.station;
    const m = UI.modal({
      title: `Task distribution — ${station.name}`,
      body: `
        <div class="note note-info">Round-robin: person 1 takes task 1, 7, 13; person 2 takes 2, 8, 14 —
          across whoever is available on ${UI.esc(workDate)}.</div>
        <label class="field"><span>Number of tasks to simulate</span>
          <input type="number" id="taskCount" value="7" min="0" max="500"></label>
        <div id="previewOut"></div>`,
      submitLabel: 'Preview',
      onSubmit: async (fd, node) => {
        const count = Number(node.querySelector('#taskCount').value) || 0;
        const r = await API.get(`/api/roster/stations/${station.id}/distribution-preview`,
          { taskCount: count, date: workDate });
        node.querySelector('#previewOut').innerHTML = r.blocked
          ? `<div class="note note-danger">${UI.esc(r.blockedReason)}</div>`
          : `${r.absentPersons.length ? `<div class="note note-warn">Absent today:
                ${r.absentPersons.map((p) => UI.esc(p.fullName)).join(', ')} — their tasks are excluded
                and redistributed below.</div>` : ''}
             ${UI.table([
               { key: 'fullName', label: 'Person' },
               { key: 'taskCount', label: 'Tasks', className: 'num' },
               { label: 'Task numbers', render: (p) => p.tasks.map((t) => t.taskNo).join(', ') || '—' },
             ], r.perPerson, 'No one available.')}`;
        return false;
      },
    });
    m.node.querySelector('button[type=submit]').click();
  }
})();
