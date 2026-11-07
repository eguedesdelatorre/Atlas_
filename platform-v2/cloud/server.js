'use strict';

const http = require('node:http');
const PORT = Number(process.env.PORT || 3101);

const state = {
  app: 'ATLAS AI',
  mode: 'READ_ONLY',
  broker: { name: 'IQ_OPTION', configured: false, connected: false },
  strategy: { name: 'ATLAS_AI', configured: false, active: false },
  dataMode: 'no_live_data'
};

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  if (url.pathname === '/health') return send(res, 200, { ok: true, app: state.app });
  if (url.pathname === '/api/v1/status') return send(res, 200, state);
  if (url.pathname === '/api/v1/signals') return send(res, 200, { signals: [], dataMode: state.dataMode });
  if (url.pathname === '/api/v1/history') return send(res, 200, { history: [], dataMode: state.dataMode });
  return send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ATLAS AI platform-v2 listening on ' + PORT);
});
