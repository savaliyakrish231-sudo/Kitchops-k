/* SIGN-IN CREDENTIALS — set every person's login ID and PIN/password from one
   screen, then print a handout.

   Existing secrets are hashed and cannot be shown. The handout is built from
   what was just set, so it must be printed before leaving the page. */
(function () {
  // Typed-but-unsaved values, kept only in memory for this page visit.
  let draft = {};
  let lastHandout = null;

  Pages.credentials = async function () {
    const content = document.getElementById('content');
    const { users, policy } = await API.get('/api/credentials');

    const pinUsers = users.filter((u) => u.allowsPin);
    const locked = users.filter((u) => u.locked);
    const neverSignedIn = users.filter((u) => !u.hasSignedIn && u.isActive);

    content.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Sign-in Credentials</h2>
          <p>Set the login ID and PIN for every person, then print the handout.
             Counter staff can use a ${policy.pinMinLength}–${policy.pinMaxLength} digit PIN;
             administrative roles need a password of at least ${policy.passwordMinLength} characters.</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="genPins">Suggest PINs for counter staff</button>
          <button class="btn" id="clearDraft">Clear entries</button>
          <button class="btn btn-primary" id="saveAll">Save changes</button>
        </div>
      </div>

      <div class="note note-warn">
        <b>Existing PINs and passwords cannot be shown.</b> They are stored hashed, so nobody —
        including a Super Admin — can read one back. Leave a box blank to keep the current secret.
        Anything you set here appears once in the handout, so print it before you leave this page.
      </div>

      ${locked.length ? `<div class="note note-danger">
        <b>${locked.length} account(s) locked out:</b>
        ${locked.map((u) => `${UI.esc(u.fullName)} (${u.lockedMinutesLeft} min left)`).join(', ')}.
        Use <b>Unlock</b> on the row to clear it immediately.</div>` : ''}

      <div class="grid grid-4" style="margin-bottom:18px">
        <div class="stat"><div class="k">People</div><div class="v">${users.length}</div></div>
        <div class="stat"><div class="k">PIN-eligible</div><div class="v">${pinUsers.length}</div>
          <div class="s">counter staff</div></div>
        <div class="stat"><div class="k">Never signed in</div>
          <div class="v" style="${neverSignedIn.length ? 'color:var(--warn)' : ''}">${neverSignedIn.length}</div>
          <div class="s">not used yet</div></div>
        <div class="stat"><div class="k">Locked out</div>
          <div class="v" style="${locked.length ? 'color:var(--danger)' : ''}">${locked.length}</div>
          <div class="s">after ${policy.maxFailedAttempts} failed tries</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Everyone</h3>
          <span class="card-sub">Blank = keep the current PIN or password</span>
          <div class="spacer"></div>
          <span class="badge chip-neutral" id="draftCount"></span>
        </div>
        <div class="card-body tight">${renderTable(users, policy)}</div>
      </div>

      <div class="note note-info">
        <b>Why counter staff only for PINs.</b> A ${policy.pinMinLength}-digit PIN is
        10,000 combinations, so it is accepted only for roles that cannot reach master data or
        settings. After ${policy.maxFailedAttempts} wrong tries an account locks for
        ${policy.lockoutMinutes} minutes, which is what makes a short PIN safe enough for the floor.
        Obvious PINs (1111, 1234, 1212) are rejected.
      </div>`;

    wire(users, policy);
    paintDraftCount();
  };

  function renderTable(users, policy) {
    return UI.table([
      { key: 'fullName', label: 'Name',
        render: (u) => `<b>${UI.esc(u.fullName)}</b>`
          + (u.designation ? `<small style="display:block;color:var(--ink-3)">${UI.esc(u.designation)}</small>` : '') },
      { key: 'roleName', label: 'Role',
        render: (u) => `<span class="badge chip-neutral">${UI.esc(u.roleName)}</span>` },
      {
        label: 'Login ID',
        render: (u) => `<input data-field="username" data-id="${u.id}" value="${UI.esc(u.username)}"
          style="min-width:130px" autocomplete="off" spellcheck="false">`,
      },
      {
        label: 'New PIN / password',
        render: (u) => `<div style="display:flex;gap:6px;align-items:center">
            <input data-field="secret" data-id="${u.id}" type="text" autocomplete="off" spellcheck="false"
              inputmode="${u.allowsPin ? 'numeric' : 'text'}"
              placeholder="${u.allowsPin ? `e.g. ${policy.pinMinLength} digits` : 'e.g. 6+ characters'}"
              style="min-width:140px">
            ${u.allowsPin ? `<button class="btn btn-sm" data-gen="${u.id}" title="Suggest a PIN">↻</button>` : ''}
          </div>`,
      },
      {
        label: 'Uses',
        render: (u) => (u.credentialType === 'PIN'
          ? '<span class="badge chip-info">PIN</span>'
          : '<span class="badge chip-neutral">Password</span>')
          + (u.allowsPin ? '' : ' <span class="badge chip-warn" title="Administrative role">no PIN</span>'),
      },
      {
        label: 'Status',
        render: (u) => {
          if (!u.isActive) return '<span class="badge chip-danger">Inactive</span>';
          if (u.locked) return `<span class="badge chip-danger">Locked ${u.lockedMinutesLeft}m</span>`;
          if (!u.hasSignedIn) return '<span class="badge chip-warn">Never signed in</span>';
          if (u.mustChange) return '<span class="badge chip-warn">Must change</span>';
          return '<span class="badge chip-ok">Active</span>';
        },
      },
      {
        label: 'Actions',
        render: (u) => `<div class="row-actions">
          ${u.locked ? `<button class="btn btn-sm" data-unlock="${u.id}">Unlock</button>` : ''}
          ${u.failedAttempts && !u.locked
            ? `<span class="badge chip-warn" title="Failed sign-in attempts">${u.failedAttempts} fails</span>` : ''}
        </div>`,
      },
    ], users, 'No users yet.');
  }

  function wire(users, policy) {
    const content = document.getElementById('content');
    const byId = new Map(users.map((u) => [u.id, u]));

    // Restore anything typed before a re-render.
    content.querySelectorAll('[data-field]').forEach((input) => {
      const id = Number(input.dataset.id);
      const field = input.dataset.field;
      if (draft[id] && draft[id][field] !== undefined) input.value = draft[id][field];
      input.oninput = () => {
        draft[id] = draft[id] || {};
        draft[id][field] = input.value;
        if (field === 'secret') validateInline(input, byId.get(id), policy);
        paintDraftCount();
      };
      if (field === 'secret') validateInline(input, byId.get(id), policy);
    });

    content.querySelectorAll('[data-gen]').forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.gen);
        const { suggestions } = await API.post('/api/credentials/suggest', { user_ids: [id] });
        if (!suggestions.length) return;
        const input = content.querySelector(`[data-field="secret"][data-id="${id}"]`);
        input.value = suggestions[0].pin;
        input.dispatchEvent(new Event('input'));
      };
    });

    content.querySelectorAll('[data-unlock]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await API.post(`/api/credentials/${btn.dataset.unlock}/unlock`);
          UI.ok('Account unlocked.');
          Pages.credentials();
        } catch (e) { UI.err(e.message); }
      };
    });

    document.getElementById('genPins').onclick = async () => {
      const { suggestions } = await API.post('/api/credentials/suggest', {});
      if (!suggestions.length) { UI.err('No PIN-eligible users.'); return; }
      for (const s of suggestions) {
        const input = content.querySelector(`[data-field="secret"][data-id="${s.userId}"]`);
        if (input && !input.value) { input.value = s.pin; input.dispatchEvent(new Event('input')); }
      }
      UI.ok(`Suggested ${suggestions.length} PIN(s). Review, then Save changes.`);
    };

    document.getElementById('clearDraft').onclick = () => {
      draft = {};
      Pages.credentials();
    };

    document.getElementById('saveAll').onclick = () => saveAll(byId);
  }

  /** Mirrors the server rules so mistakes surface before saving. */
  function validateInline(input, user, policy) {
    const v = input.value.trim();
    input.style.borderColor = '';
    input.title = '';
    if (!v) return;
    let problem = null;
    if (/^\d+$/.test(v)) {
      if (!user.allowsPin) problem = `${user.roleName} cannot use a numeric PIN — use a password with a non-digit.`;
      else if (v.length < policy.pinMinLength || v.length > policy.pinMaxLength) {
        problem = `PIN must be ${policy.pinMinLength}–${policy.pinMaxLength} digits.`;
      } else if (/^(\d)\1+$/.test(v)) problem = 'Too easy to guess — every digit is the same.';
      else {
        const d = [...v].map(Number);
        if (d.every((x, i) => i === 0 || x === d[i - 1] + 1) || d.every((x, i) => i === 0 || x === d[i - 1] - 1)) {
          problem = 'Too easy to guess — the digits run in sequence.';
        }
      }
    } else if (v.length < policy.passwordMinLength) {
      problem = `Password must be at least ${policy.passwordMinLength} characters.`;
    }
    if (problem) { input.style.borderColor = 'var(--danger)'; input.title = problem; }
  }

  function paintDraftCount() {
    const n = Object.values(draft).filter((d) => (d.username || '') !== '' || (d.secret || '') !== '').length;
    const chip = document.getElementById('draftCount');
    if (chip) chip.textContent = n ? `${n} row(s) edited — not saved yet` : 'No unsaved changes';
    // Typed PINs live only in this page. Warn before sign-out throws them away.
    App.setUnsavedWarning(n
      ? `You have ${n} row(s) of unsaved sign-in changes. Signing out will discard them.`
      : null);
  }

  async function saveAll(byId) {
    const entries = [];
    for (const [id, d] of Object.entries(draft)) {
      const user = byId.get(Number(id));
      if (!user) continue;
      const entry = { user_id: Number(id) };
      if (d.username !== undefined && d.username.trim() && d.username.trim() !== user.username) {
        entry.username = d.username.trim();
      }
      if (d.secret !== undefined && d.secret.trim()) entry.secret = d.secret.trim();
      if (entry.username || entry.secret) entries.push(entry);
    }
    if (!entries.length) { UI.err('Nothing to save — enter a login ID or PIN first.'); return; }

    const okd = await UI.confirmDialog({
      title: 'Save sign-in credentials',
      confirmLabel: `Save ${entries.length} change(s)`,
      message: `This updates ${entries.length} account(s). Anyone whose PIN changes must use the new
        one immediately.<br><br>The handout appears next and is the <b>only</b> time these can be
        read — print or copy it before closing.`,
    });
    if (!okd) return;

    try {
      const res = await API.post('/api/credentials/bulk', { entries });
      lastHandout = res.handout;
      draft = {};
      UI.ok(`${res.changed} account(s) updated.`);
      showHandout(res.handout);
    } catch (e) {
      const rows = e.data?.errors || [];
      if (rows.length) {
        UI.modal({
          title: 'Nothing was saved',
          body: `<div class="note note-danger">${UI.esc(e.data.message)}</div>
            <ul style="margin:0;padding-left:18px;line-height:1.7">
              ${rows.map((r) => `<li><b>${UI.esc(r.fullName || 'User ' + r.userId)}</b> — ${UI.esc(r.message)}</li>`).join('')}
            </ul>
            <p style="color:var(--ink-2);margin-bottom:0">The whole batch was rejected, so no one is
              half-changed. Fix these rows and save again.</p>`,
          submitLabel: 'Back to the list',
          onSubmit: () => true,
        });
      } else { UI.err(e.message); }
      Pages.credentials();
    }
  }

  /** The one and only chance to read what was just set. */
  function showHandout(handout) {
    const rows = handout.filter((h) => h.secret);
    const m = UI.modal({
      title: 'Sign-in handout',
      wide: true,
      body: `
        <div class="note note-warn">These are shown <b>once</b>. Print or copy them now — after this
          dialog closes they cannot be recovered, only replaced.</div>
        <div id="handoutPrint">
          ${UI.table([
            { key: 'fullName', label: 'Name', render: (h) => `<b>${UI.esc(h.fullName)}</b>` },
            { key: 'roleName', label: 'Role' },
            { key: 'username', label: 'Login ID', render: (h) => `<code>${UI.esc(h.username)}</code>` },
            {
              label: 'PIN / password',
              render: (h) => (h.secret
                ? `<code style="font-size:15px;font-weight:700">${UI.esc(h.secret)}</code>`
                : '<span style="color:var(--ink-3)">unchanged</span>'),
            },
          ], handout, 'Nothing was changed.')}
        </div>
        ${rows.length ? `<p style="color:var(--ink-2);font-size:12.5px">
          Everyone opens the app in their phone browser and signs in with their Login ID and
          ${rows.some((r) => r.credentialType === 'PIN') ? 'PIN' : 'password'}.</p>` : ''}`,
      submitLabel: 'Done — I have these',
      footerExtra: '<button class="btn" type="button" id="printHandout">Print</button>'
        + '<button class="btn" type="button" id="copyHandout">Copy as text</button>',
      onSubmit: () => true,
    });

    m.node.querySelector('#printHandout').onclick = () => printHandout(handout);
    m.node.querySelector('#copyHandout').onclick = async () => {
      const text = handout.map((h) =>
        `${h.fullName}\t${h.username}\t${h.secret || '(unchanged)'}\t${h.roleName}`).join('\n');
      try {
        await navigator.clipboard.writeText(`Name\tLogin ID\tPIN/Password\tRole\n${text}`);
        UI.ok('Copied to the clipboard.');
      } catch {
        UI.err('Could not copy automatically — select the table and copy manually.');
      }
    };
  }

  /** Opens a clean print sheet: one slip per person, cut and hand out. */
  function printHandout(handout) {
    const w = window.open('', '_blank');
    if (!w) { UI.err('Allow pop-ups to print the handout.'); return; }
    const slips = handout.map((h) => `
      <div class="slip">
        <div class="who">${UI.esc(h.fullName)}</div>
        <div class="role">${UI.esc(h.roleName)}${h.credentialType === 'PIN' ? ' · PIN' : ''}</div>
        <div class="pair"><span>Login ID</span><b>${UI.esc(h.username)}</b></div>
        <div class="pair"><span>${h.credentialType === 'PIN' ? 'PIN' : 'Password'}</span>
          <b class="secret">${UI.esc(h.secret || 'unchanged')}</b></div>
        <div class="foot">KitchOps — change this after your first sign-in.</div>
      </div>`).join('');

    w.document.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>KitchOps sign-in slips</title><style>
        body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 16px; color: #111; }
        h1 { font-size: 16px; margin: 0 0 4px; }
        p.sub { font-size: 12px; color: #555; margin: 0 0 14px; }
        .sheet { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .slip { border: 1px dashed #999; border-radius: 6px; padding: 12px 14px; page-break-inside: avoid; }
        .who { font-size: 15px; font-weight: 700; }
        .role { font-size: 11px; color: #666; margin-bottom: 8px; }
        .pair { display: flex; justify-content: space-between; align-items: baseline;
                border-top: 1px solid #eee; padding: 5px 0; font-size: 13px; }
        .pair span { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
        .pair b { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 15px; }
        .secret { letter-spacing: .12em; }
        .foot { font-size: 10px; color: #888; margin-top: 8px; }
        @media print { body { margin: 8mm; } }
      </style></head><body>
      <h1>KitchOps — sign-in details</h1>
      <p class="sub">Generated ${new Date().toLocaleString()}. Cut along the dashed lines. Destroy any spare copies.</p>
      <div class="sheet">${slips}</div>
      <script>window.onload = function () { window.print(); };<\/script>
      </body></html>`);
    w.document.close();
  }

  /** Lets the shell offer the handout again while the page is still open. */
  Pages.credentialsHandout = () => (lastHandout ? showHandout(lastHandout) : null);
})();
