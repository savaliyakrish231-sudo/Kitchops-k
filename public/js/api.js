/* Thin fetch wrapper. Every call carries the auth cookie and surfaces the
   server's error message, including the 403s produced by RBAC. */
window.API = (function () {
  async function request(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }

    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const qs = (params = {}) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') s.append(k, v);
    }
    const out = s.toString();
    return out ? `?${out}` : '';
  };

  return {
    qs,
    get: (url, params) => request('GET', url + qs(params)),
    post: (url, body) => request('POST', url, body ?? {}),
    put: (url, body) => request('PUT', url, body ?? {}),
    patch: (url, body) => request('PATCH', url, body ?? {}),
    del: (url, body) => request('DELETE', url, body),
  };
})();
