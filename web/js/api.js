// API client: token handling, JSON requests and the live event stream.

function readToken() {
  const url = new URL(location.href);
  const t = url.searchParams.get('t');
  if (t) {
    sessionStorage.setItem('fc-token', t);
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return t;
  }
  return sessionStorage.getItem('fc-token') || '';
}

export const token = readToken();

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-freecode-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Not authorized. Restart FreeCode and use the link it opens.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, body = {}) => request('POST', p, body),
};

/** Opens the server-sent event stream; reconnects automatically. */
export function connectEvents(onMessage, onStatus) {
  let es;
  let wasOpen = false;
  const open = () => {
    es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
    es.onopen = () => {
      onStatus?.(wasOpen ? 'reconnected' : 'open');
      wasOpen = true;
    };
    es.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (e) {
        console.error('bad event', e);
      }
    };
    es.onerror = () => {
      onStatus?.('error');
    };
  };
  open();
  return () => es?.close();
}
