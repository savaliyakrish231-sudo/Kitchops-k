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

  /** Renders a table; `columns` are {key,label,className,render}. */
  function table(columns, rows, emptyText = 'No records yet.') {
    if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
    const head = columns.map((c) => `<th class="${c.className || ''}">${esc(c.label)}</th>`).join('');
    const body = rows.map((row) => {
      const cls = row.__rowClass ? ` class="${row.__rowClass}"` : '';
      const tds = columns.map((c) => {
        const v = c.render ? c.render(row) : esc(row[c.key]);
        return `<td class="${c.className || ''}">${v}</td>`;
      }).join('');
      return `<tr${cls}>${tds}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function toast(message, kind = '') {
    const node = el(`<div class="toast ${kind}">${esc(message)}</div>`);
    document.getElementById('toastHost').appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 4200);
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

    const close = () => { host.hidden = true; host.innerHTML = ''; };
    node.querySelector('.close').onclick = close;
    node.querySelector('[data-role=cancel]').onclick = close;

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

  const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
  const spinner = (label = 'Loading…') => `<div class="spin">${esc(label)}</div>`;

  return {
    esc, el, table, toast, ok, err, modal, confirmDialog, methodBadge, methodRowClass,
    legend, yesNo, sampleTag, stationDot, pickerFieldset, checkedValues, fmtDate, spinner,
  };
})();
