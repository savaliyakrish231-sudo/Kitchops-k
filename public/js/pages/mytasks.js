/* MY TASKS — the counter person's mobile view.
   Phase 1 task generation is a separate module; this screen already enforces the
   scoping rule (a person sees only their own station assignment and status) and
   carries the Machine/Manual colour coding it will use. */
(function () {
  Pages.myTasks = async function () {
    const content = document.getElementById('content');
    const { user } = await API.get('/api/auth/me');

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>${UI.esc(greeting)}, ${UI.esc(user.fullName.split(' ')[0])}!</h2>
          <p>${user.stations.length
            ? user.stations.map((s) => UI.stationDot(s.sheet_colour, s.name)).join(' · ')
            : 'You are not assigned to a station yet.'}</p>
        </div>
      </div>

      ${user.absentToday ? `<div class="note note-warn">
        <b>You are marked absent today.</b> Your tasks have been redistributed to the other persons at
        your station. Ask your admin to mark you present if this is wrong.</div>` : ''}

      ${!user.stations.length ? `<div class="card"><div class="empty">
        No station is assigned to you yet. Your admin assigns counter persons in Counter Settings.
      </div></div>` : `
        <div class="card">
          <div class="card-head"><h3>Today's tasks</h3><div class="spacer"></div>${UI.legend()}</div>
          <div class="card-body">
            <div class="note note-info" style="margin:0">
              Your task list appears here once the morning sheets are generated. Each row shows the
              item, cut type and method — <b>Blue for MACHINE</b>, <b>Orange for MANUAL</b> — and you
              mark each one Done as you finish it.
            </div>
          </div>
        </div>`}

      <div class="card">
        <div class="card-head"><h3>Your access</h3></div>
        <div class="card-body">
          <p style="margin-top:0;color:var(--ink-2)">You can see only your own tasks and your own
             station. Other people's task lists, the Recipe DB and the user list are not available to
             your role — this is enforced on the server, not just hidden here.</p>
          <div>${user.permissions.map((p) => `<span class="badge chip-neutral">${UI.esc(p)}</span>`).join(' ')}</div>
        </div>
      </div>`;
  };
})();
