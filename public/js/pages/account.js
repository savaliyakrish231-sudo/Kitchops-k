/* ACCOUNT — the signed-in person's own page: who they are, how the app looks on
   this device, their sign-in secret, and signing out.

   Available to every role, including counter staff who have no other page. */
(function () {
  Pages.account = async function () {
    const content = document.getElementById('content');

    // Re-read rather than trusting the copy taken at sign-in: an admin may have
    // changed this person's role, station or secret since.
    const { user } = await API.get('/api/auth/me');
    App.state.user = user;

    const mode = Theme.get();
    const shown = Theme.resolved();
    const usesPin = user.credentialType === 'PIN';

    content.innerHTML = `
      ${UI.pageHead({
        icon: '\u{1F464}',
        title: 'Account',
        lead: 'Your sign-in details, how KitchOps looks on this device, and signing out.',
      })}

      ${user.mustChangePassword ? `<div class="note note-warn">
        <b>Your ${usesPin ? 'PIN' : 'password'} was set by an administrator.</b>
        Choose your own below so only you know it.</div>` : ''}

      ${user.absentToday ? `<div class="note note-warn">
        <b>You are marked absent today.</b> Your tasks have been shared out among the other people
        at your station. Ask your admin to mark you present if that is wrong.</div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Signed in as</h3></div>
        <div class="card-body tight">
          ${rows([
            ['Name', UI.esc(user.fullName)],
            ['Login ID', `<code>${UI.esc(user.username)}</code>`],
            ['Role', `<span class="badge chip-neutral">${UI.esc(user.roleName)}</span>`],
            user.designation ? ['Designation', UI.esc(user.designation)] : null,
            user.additionalResponsibility
              ? ['Additional responsibility',
                `<span class="badge chip-info">${UI.esc(user.additionalResponsibility)}</span>`] : null,
            user.stations && user.stations.length
              ? ['Station(s)', user.stations.map((s) => UI.stationDot(s.sheet_colour, s.name)).join('<br>')]
              : null,
            ['Signs in with', usesPin
              ? '<span class="badge chip-info">4–6 digit PIN</span>'
              : '<span class="badge chip-neutral">Password</span>'],
            ['Last sign-in', user.lastLoginAt ? UI.esc(user.lastLoginAt) : 'This is your first session'],
          ])}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Appearance</h3>
          <span class="card-sub">Saved on this device only</span></div>
        <div class="card-body">
          <div class="setting-row">
            <div class="field">
              <span>Theme</span>
              <div class="segmented" id="accountTheme">
                ${Theme.MODES.map((m) => `
                  <button type="button" data-mode="${m}" aria-pressed="${m === mode}">
                    <span aria-hidden="true">${Theme.LABELS[m].icon}</span>${UI.esc(Theme.LABELS[m].label)}
                  </button>`).join('')}
              </div>
              <span class="hint">
                ${mode === 'system'
                  ? `Following this device’s setting — currently showing <b>${Theme.LABELS[shown].label.toLowerCase()}</b>.`
                  : `Always ${Theme.LABELS[mode].label.toLowerCase()}, whatever this device is set to.`}
                Your choice does not affect anyone else.
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Security</h3></div>
        <div class="card-body">
          <div class="setting-row">
            <div class="field">
              <span>${usesPin ? 'PIN' : 'Password'}</span>
              <span class="hint">
                Stored hashed — nobody can read it back, not even a Super Admin.
                ${user.allowsPin
                  ? 'You may use a 4–6 digit PIN or a longer password.'
                  : 'This role cannot use a numeric PIN; it needs at least 6 characters including a non-digit.'}
              </span>
            </div>
            <button class="btn" id="changeSecret">Change ${usesPin ? 'PIN' : 'password'}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Session</h3></div>
        <div class="card-body">
          <div class="setting-row">
            <div class="field">
              <span>Sign out</span>
              <span class="hint">You will need your login ID and
                ${usesPin ? 'PIN' : 'password'} to sign back in.</span>
            </div>
            <button class="btn btn-danger" id="accountSignOut">Sign out</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>What you can do</h3>
          <span class="card-sub">Granted by your role — enforced on the server</span></div>
        <div class="card-body">
          <div>${user.permissions.map((p) =>
            `<span class="badge chip-neutral" style="margin:0 4px 4px 0">${UI.esc(p)}</span>`).join('')}</div>
        </div>
      </div>`;

    content.querySelectorAll('#accountTheme button').forEach((btn) => {
      btn.onclick = () => {
        Theme.set(btn.dataset.mode);
        // Show the new selection at once. Re-rendering the page re-reads the
        // profile over the network, so waiting for it would leave the button
        // looking unresponsive on a slow connection.
        content.querySelectorAll('#accountTheme button').forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.mode === btn.dataset.mode));
        });
        UI.ok(`Appearance set to ${Theme.LABELS[btn.dataset.mode].label}.`);
        Pages.account();
      };
    });
    document.getElementById('changeSecret').onclick = () => App.changePassword(false);
    document.getElementById('accountSignOut').onclick = () => App.signOut();
  };

  /** Simple label/value table for the profile card. */
  function rows(pairs) {
    return UI.table(
      [
        { key: 'label', label: 'Detail', render: (r) => `<b>${r.label}</b>` },
        { key: 'value', label: '', render: (r) => r.value },
      ],
      pairs.filter(Boolean).map(([label, value]) => ({ label, value })),
    );
  }
})();
