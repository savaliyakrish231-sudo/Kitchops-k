/* MY TASKS — the counter person's phone view (v10.2 s1.5).

   Shows the work currently allocated to this person, using the same round-robin
   the admin dashboard shows, so the two never disagree. Quantities and Mark Done
   belong to the daily sheet engine, which is a separate module — the page says
   so rather than implying a sheet has been generated. */
(function () {
  Pages.myTasks = async function () {
    const content = document.getElementById('content');
    const [{ user }, mine] = await Promise.all([
      API.get('/api/auth/me'),
      API.get('/api/tasks/mine').catch((e) => ({ error: e.message, stations: [], taskCount: 0 })),
    ]);

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const firstName = UI.esc(user.fullName.split(' ')[0]);
    const stations = mine.stations || [];

    content.innerHTML = `
      ${UI.pageHead({
        icon: '✓',
        title: `${greeting}, ${firstName}!`,
        lead: stations.length
          ? `${stations.map((s) => UI.stationDot(s.station.sheetColour, s.station.name)).join(' · ')}
             &nbsp;·&nbsp; <b>${mine.taskCount} task${mine.taskCount === 1 ? '' : 's'}</b> today`
          : 'You are not assigned to a station yet.',
      })}

      ${mine.error ? `<div class="note note-warn"><div>${UI.esc(mine.error)}</div></div>` : ''}

      ${user.absentToday ? `<div class="note note-warn"><div>
        <b>You are marked absent today.</b> Your work has been shared out among the other people at
        your station. Ask your admin to mark you present if that is wrong.</div></div>` : ''}

      ${!stations.length ? `<div class="card">${UI.emptyState({
          icon: '⌗',
          title: 'No station assigned yet',
          body: 'Your admin assigns counter staff to a station in Counter Settings. Once that is '
            + 'done your work appears here.',
        })}</div>`
        : stations.map(stationCard).join('')}

      ${stations.length && !user.absentToday ? `<div class="note note-info"><div>
        <b>${UI.esc(mine.note || '')}</b></div></div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Your access</h3></div>
        <div class="card-body">
          <p style="margin-top:0;color:var(--ink-2)">You see only your own work and your own
             station. Other people's lists, the Recipe DB and the user list are not available to
             your role — enforced on the server, not just hidden here.</p>
          <div>${user.permissions.map((p) =>
            `<span class="badge chip-neutral">${UI.esc(p)}</span>`).join(' ')}</div>
        </div>
      </div>`;
  };

  function stationCard(s) {
    return `
      <div class="card card-accent" style="border-left-color:${UI.esc(s.station.sheetColour)}">
        <div class="card-head">
          <h3>${UI.esc(s.station.name)}</h3>
          <div class="spacer"></div>
          <span class="card-sub">${s.tasks.length} of ${s.stationItemCount} item(s)
            · shared with ${s.teamSize} person${s.teamSize === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body">
          ${UI.legend()}
          <div style="margin-top:12px">
            ${s.tasks.length
              ? s.tasks.map(taskCard).join('')
              : `<div class="note note-ok" style="margin:0"><div>
                   Nothing allocated to you at this station today.</div></div>`}
          </div>
        </div>
      </div>`;
  }

  function taskCard(t) {
    const cls = t.method === 'MACHINE' ? 'is-machine' : t.method === 'MANUAL' ? 'is-manual' : '';
    const bits = [
      t.wholeAkhaj ? 'WHOLE / Akhaj' : (t.cutType || null),
      t.method || null,
      t.yieldPercent != null ? `Yield ${Number(t.yieldPercent)}%` : null,
      t.unit || null,
    ].filter(Boolean);

    return `
      <div class="task-card ${cls}">
        <div class="t-main">
          <div class="t-title">${UI.esc(t.item)}</div>
          <div class="t-meta">${bits.map(UI.esc).join(' &nbsp;·&nbsp; ')}</div>
          ${t.needsPeeling ? `<div class="t-meta">Peel first — ${UI.methodBadge(t.peelingMethod)}</div>` : ''}
          ${t.blocking.length
            ? `<div class="t-meta"><span class="badge chip-danger">Not ready</span>
                 ${UI.esc(t.blocking[0])}</div>` : ''}
        </div>
        ${t.method ? UI.methodBadge(t.method) : ''}
      </div>`;
  }
})();
