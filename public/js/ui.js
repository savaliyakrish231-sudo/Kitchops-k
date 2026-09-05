/* Small DOM toolkit: escaping, tables, modals, toasts and the shared
   Machine/Manual colour helper (v10.2 Rule 5). */

/* The page registry each js/pages/*.js file assigns into. It must exist before
   those scripts run, so it is created here — ui.js loads ahead of all of them. */
window.Pages = window.Pages || {};

window.UI = (function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  /** MACHINE -> Blue, MANUAL -> Orange. Single source for the whole frontend. */
  function methodBadge(method) {
    if (!method) return '<span class="badge chip-neutral">Not set</span>';
    const cls = method === 'MACHINE' ? 'method-machine' : 'method-manual';
    const colour = method === 'MACHINE' ? 'Blue' : 'Orange';
    return `<span class="badge ${cls}" title="${colour}">${esc(method)}</span>`;
  }

  function methodRowClass(method) {
    return method === 'MACHINE' ? 'row-machine' : method === 'MANUAL' ? 'row-manual' : '';
  }

  const legend = () => `
    <div class="legend">
      <span><i class="swatch swatch-machine"></i>MACHINE = Blue</span>
      <span><i class="swatch swatch-manual"></i>MANUAL = Orange</span>
    </div>`;

  function yesNo(v, yes = 'Yes', no = 'No') {
    return Number(v) === 1
      ? `<span class="badge chip-ok">${esc(yes)}</span>`
      : `<span class="badge chip-neutral">${esc(no)}</span>`;
  }

  const sampleTag = (v) => (Number(v) === 1 ? ' <span class="badge chip-sample">SAMPLE</span>' : '');

  function stationDot(colour, name) {
    return `<span class="station-dot" style="background:${esc(colour || '#94a3b8')}"></span>${esc(name)}`;
  }

  /**
   * Renders a table; `columns` are {key,label,className,render}.
   *
   * Every cell carries data-label="<column name>". On phones the stylesheet
   * turns each row into a card and shows that label beside the value, because a
   * 13-column table is unreadable at 360px. Above 900px it is a real table
   * again and the labels are hidden. Pages need no mobile-specific code.
   */
  function table(columns, rows, emptyText = 'No records yet.') {
    if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
    const head = columns.map((c) => `<th class="${c.className || ''}">${esc(c.label || '')}</th>`).join('');
    const body = rows.map((row) => {
      const cls = row.__rowClass ? ` class="${row.__rowClass}"` : '';
      const tds = columns.map((c) => {
        const v = c.render ? c.render(row) : esc(row[c.key]);
        // An actions cell spans the card instead of sitting in a label column.
        const isActions = /action/i.test(c.label || '') || String(v).includes('row-actions');
        const classes = [c.className || '', isActions ? 'cell-actions' : ''].filter(Boolean).join(' ');
        return `<td class="${classes}" data-label="${esc(c.label || '')}">${v}</td>`;
      }).join('');
      return `<tr${cls}>${tds}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function toast(message, kind = '') {
    const node = el(`<div class="toast ${kind}">${esc(message)}</div>`);
    document.getElementById('toastHost').appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      node.addEventListener('transitionend', () => node.remove(), { once: true });
      setTimeout(() => node.remove(), 400);   // fallback if the transition is suppressed
    }, 4200);
  }

  const ok = (m) => toast(m, 'ok');
  const err = (m) => toast(m, 'err');

  /**
   * Opens a modal. `opts.onSubmit(formData, modalEl)` runs on submit; return
   * false to keep it open. Returns a close function.
   */
  function modal({ title, body, submitLabel, wide = false, onSubmit, footerExtra = '' }) {
    const host = document.getElementById('modalHost');
    const node = el(`
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn close" type="button" aria-label="Close">×</button>
        </div>
        <form>
          <div class="modal-body">
            <p class="form-error" data-role="error" hidden></p>
            ${body}
          </div>
          <div class="modal-foot">
            ${footerExtra}
            <button class="btn" type="button" data-role="cancel">Cancel</button>
            ${submitLabel ? `<button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>` : ''}
          </div>
        </form>
      </div>`);

    host.innerHTML = '';
    host.appendChild(node);
    host.hidden = false;

    // Animate out, then clear. Guarded so a double close cannot stack.
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      document.removeEventListener('keydown', onKey);
      host.classList.add('is-closing');
      const done = () => { host.hidden = true; host.innerHTML = ''; host.classList.remove('is-closing'); };
      host.addEventListener('animationend', done, { once: true });
      setTimeout(done, 260);   // fallback if the animation is suppressed
    };

    // Escape closes, and so does tapping the dimmed area outside the dialog —
    // both are what people instinctively try on a phone.
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    host.onclick = (e) => { if (e.target === host) close(); };

    node.querySelector('.close').onclick = close;
    node.querySelector('[data-role=cancel]').onclick = close;

    // Focus the first field so typing can start straight away. Skipped on
    // touch, where it would throw up the keyboard over the dialog.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      const first = node.querySelector('input:not([type=hidden]), select, textarea');
      if (first) setTimeout(() => first.focus(), 60);
    }

    const errBox = node.querySelector('[data-role=error]');
    const showError = (msg) => { errBox.textContent = msg; errBox.hidden = !msg; };

    node.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      showError('');
      const btn = node.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const result = await onSubmit(new FormData(e.target), node, showError);
        if (result !== false) close();
      } catch (ex) {
        showError(ex.message || 'Something went wrong.');
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    return { close, node, showError };
  }

  /** Confirmation dialog resolving to true/false. */
  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const m = modal({
        title,
        body: `<p style="margin:0;line-height:1.55">${message}</p>`,
        submitLabel: confirmLabel,
        onSubmit: () => { resolve(true); return true; },
      });
      if (danger) m.node.querySelector('button[type=submit]').classList.replace('btn-primary', 'btn-danger');
      m.node.querySelector('[data-role=cancel]').addEventListener('click', () => resolve(false));
      m.node.querySelector('.close').addEventListener('click', () => resolve(false));
    });
  }

  /** Checkbox list used for station / location multi-select. */
  function pickerFieldset(legendText, name, options, selectedIds = [], emptyText = 'Nothing available yet.') {
    if (!options.length) {
      return `<fieldset class="picker"><legend>${esc(legendText)}</legend>
        <p class="hint" style="margin:4px 0">${esc(emptyText)}</p></fieldset>`;
    }
    const sel = new Set(selectedIds.map(Number));
    const items = options.map((o) => `
      <label class="check">
        <input type="checkbox" name="${esc(name)}" value="${o.id}" ${sel.has(Number(o.id)) ? 'checked' : ''}>
        <span>${o.label}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span>
      </label>`).join('');
    return `<fieldset class="picker"><legend>${esc(legendText)}</legend>${items}</fieldset>`;
  }

  const checkedValues = (form, name) =>
    Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((i) => Number(i.value));


  /**
   * An empty state should say what is missing AND what to do next — "No
   * records yet." leaves someone setting the system up with nowhere to go.
   *
   * ESCAPING CONTRACT, shared by pageHead/stat/checklist below:
   *   title / label       - plain text, escaped here. Do NOT pre-escape.
   *   body / lead / note  - trusted HTML, NOT escaped. Escape any data you
   *                         interpolate into them yourself.
   */
  function emptyState({ icon = '\u{1F4CB}', title, body = '', actionLabel, actionId }) {
    return `
      <div class="empty-state">
        <div class="es-icon" aria-hidden="true">${icon}</div>
        <div class="es-title">${esc(title)}</div>
        ${body ? `<p class="es-body">${body}</p>` : ''}
        ${actionLabel && actionId
          ? `<div class="es-action"><button class="btn btn-primary" id="${esc(actionId)}">${esc(actionLabel)}</button></div>`
          : ''}
      </div>`;
  }

  /** Page header with an icon so each screen is recognisable at a glance. */
  function pageHead({ icon, title, lead = '', actions = '' }) {
    return `
      <div class="page-head">
        <div class="page-icon" aria-hidden="true">${icon}</div>
        <div class="page-head-text">
          <h2>${esc(title)}</h2>
          ${lead ? `<p>${lead}</p>` : ''}
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
      </div>`;
  }

  /**
   * A stat tile. `tone` colours the accent and figure so the number's meaning
   * is visible without reading the label: ok | warn | danger | info.
   */
  function stat({ label, value, sub = '', tone = '' }) {
    return `
      <div class="stat ${tone ? 'stat-' + tone : ''}">
        <div class="k">${esc(label)}</div>
        <div class="v">${esc(String(value))}</div>
        ${sub ? `<div class="s">${sub}</div>` : ''}
      </div>`;
  }

  /**
   * Setup checklist. Each step is {title, note, done, page} — a step with a
   * page becomes a button that navigates there.
   */
  function checklist(steps) {
    const firstUndone = steps.findIndex((x) => !x.done);
    return `<div class="checklist">${steps.map((step, i) => {
      const cls = step.done ? 'done' : i === firstUndone ? 'next' : '';
      const inner = `
        <span class="cs-mark" aria-hidden="true">${step.done ? '\u2713' : i + 1}</span>
        <span class="cs-main">
          <span class="cs-title">${esc(step.title)}</span>
          ${step.note ? `<span class="cs-note">${step.note}</span>` : ''}
        </span>
        ${step.page ? '<span class="cs-go" aria-hidden="true">\u203A</span>' : ''}`;
      return step.page
        ? `<button type="button" class="check-step ${cls}" data-goto="${esc(step.page)}">${inner}</button>`
        : `<div class="check-step ${cls}">${inner}</div>`;
    }).join('')}</div>`;
  }

  /** Proportion complete, 0..1. */
  function progress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <span style="width:${pct}%"></span></div>`;
  }

  /** Wires every [data-goto] in the current page to navigate there. */
  function wireGoto(root = document) {
    root.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => { location.hash = b.dataset.goto; };
    });
  }

  const fmtDate = (s) => (s ? String(s).slice(0, 10) : '\u2014');
  const spinner = (label = 'Loading…') => `<div class="spin">${esc(label)}</div>`;

  /**
   * Placeholder shown only when a load is slow enough to notice. It mirrors the
   * shape of a page (a header block plus rows) so the layout does not jump when
   * the real content arrives.
   */
  const skeleton = (rows = 3) => `
    <div class="skeleton">
      <div class="line w40"></div><div class="line w70"></div>
    </div>
    ${Array.from({ length: rows }, () => `
      <div class="skeleton">
        <div class="line w70"></div><div class="line"></div><div class="line w40"></div>
      </div>`).join('')}`;

  /**
   * Marks a button busy while `promise` settles: the label is replaced by a
   * spinner and further taps are ignored. Returns the promise unchanged.
   */
  function busy(button, promise) {
    if (!button || !promise || typeof promise.then !== 'function') return promise;
    button.classList.add('is-busy');
    button.disabled = true;
    return promise.finally(() => {
      // The button may have been replaced by a re-render; that is harmless.
      button.classList.remove('is-busy');
      button.disabled = false;
    });
  }

  /**
   * Wraps every button's click handler so any handler returning a promise
   * automatically shows the busy state. Pages need no changes for this.
   */
  function enhanceButtons(root = document) {
    root.querySelectorAll('button').forEach((btn) => {
      if (btn.dataset.uxWrapped) return;
      const original = btn.onclick;
      if (typeof original !== 'function') return;
      btn.dataset.uxWrapped = '1';
      btn.onclick = function wrapped(event) {
        const result = original.call(this, event);
        if (result && typeof result.then === 'function') busy(btn, result);
        return result;
      };
    });
  }

  return {
    esc, el, table, toast, ok, err, modal, confirmDialog, methodBadge, methodRowClass,
    legend, yesNo, sampleTag, stationDot, pickerFieldset, checkedValues, fmtDate, spinner,
    emptyState, pageHead, stat, checklist, progress, wireGoto,
    skeleton, busy, enhanceButtons,
  };
})();
