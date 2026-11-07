'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.PORT || 3000);
const root = path.resolve(__dirname, '..', 'public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true,app:'ATLAS AI',status:'online',feed:'not_connected',mode:'read_only'}));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify({status:'online',feedConnected:false,feedMessage:'Integração com a Safirion ainda não configurada',assets:[],signals:[],mode:'read_only'}));
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, requested);
  if (file !== path.join(root,'index.html') && !file.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {'content-type':type,'cache-control':'no-cache'});
    res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('ATLAS AI online on port ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
