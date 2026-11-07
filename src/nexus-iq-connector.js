'use strict';
const dns = require('node:dns');
// Railway may prefer an unreachable IPv6 route; prefer IPv4 for IQ HTTPS/WebSocket.
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
const EventEmitter = require('node:events');
const WebSocket = require('ws');

class NexusIqConnector extends EventEmitter {
  constructor({ email, password } = {}) {
    super();
    if (!email || !password) throw new Error('IQ credentials missing');
    this.email = email;
    this.password = password;
    this.ws = null;
    this.ssid = null;
    this.stopped = false;
    this.retry = 0;
    this.requestSeq = 0;
    this.assets = new Map();
    this.pendingHistory = new Map();
    this.subscriptions = new Set();
    this.requestQueue = [];
    this.queueTimer = null;
    this.authenticated = false;
  }

  async login() {
    const body = new URLSearchParams();
    body.set('identifier', this.email);
    body.set('password', this.password);
    let response;
    try {
      response = await fetch('https://auth.iqoption.com/api/v2/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': 'NEXUS-Cloud/1.0',
          origin: 'https://iqoption.com',
          referer: 'https://iqoption.com/'
        },
        body,
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      const cause = error?.cause?.code || error?.cause?.message || error?.message || 'network error';
      throw new Error('IQ login transport failed: ' + String(cause).slice(0,160));
    }
    if (!response.ok) throw new Error('IQ Option authentication failed (HTTP ' + response.status + ')');
    const data = await response.json();
    const ssid = data.ssid || data?.data?.ssid || data?.result?.ssid;
    if (!ssid) throw new Error('IQ Option did not return an SSID; login may require 2FA or a supported login flow');
    return String(ssid);
  }

  async connect() {
    if (this.stopped) return;
    try {
      this.ssid = await this.login();
      const ws = new WebSocket('wss://iqoption.com/echo/websocket', {
        headers: { Origin: 'https://iqoption.com' },
        handshakeTimeout: 15000
      });
      this.ws = ws;
      ws.on('open', () => {
        this.sendRaw({ name: 'ssid', msg: this.ssid });
      });
      ws.on('message', raw => {
        try {
          const packet = JSON.parse(raw.toString());
          this.emit('packet', { name: packet.name || packet.msg?.name || 'unknown' });
          this.handle(packet);
        } catch (error) {
          this.emit('protocolError', error);
        }
      });
      ws.on('error', error => this.emit('error', error));
      ws.on('close', () => {
        this.authenticated = false;
        this.subscriptions.clear();
        this.requestQueue = [];
        if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
        this.emit('disconnected');
        if (!this.stopped) this.reconnect();
      });
    } catch (error) {
      this.emit('error', error);
      this.reconnect();
    }
  }

  sendRaw(packet) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(packet));
  }

  sendMessage(name, version, body, requestId) {
    const id = requestId || String(++this.requestSeq);
    this.sendRaw({
      name: 'sendMessage',
      request_id: id,
      local_time: Date.now(),
      msg: { name, version, body }
    });
    return id;
  }

  subscribe(name, params) {
    const id = String(++this.requestSeq);
    this.sendRaw({
      name: 'subscribeMessage',
      request_id: id,
      msg: { name, params }
    });
  }

  extractActives(msg) {
    const roots = [msg?.result, msg?.data, msg];
    const merged = new Map();
    const add = (raw, modality) => {
      if (!raw || typeof raw !== 'object') return;
      const entries = Array.isArray(raw) ? raw.map((item, index) => [String(item?.active_id ?? item?.id ?? index), item]) : Object.entries(raw);
      for (const [key, item] of entries) {
        if (!item || typeof item !== 'object') continue;
        const activeId = Number(item.active_id ?? item.activeId ?? item.id ?? key);
        if (!Number.isFinite(activeId) || activeId <= 0) continue;
        const asset = String(item.name || item.title || item.instrument_name || item.symbol || key);
        const current = merged.get(activeId) || { activeId, asset, enabled: false, suspended: true, isOtc: false, modalities: [], productStatus: {} };
        current.asset = current.asset || asset;
        current.enabled = current.enabled || (item.enabled !== false && item.is_enabled !== false && item.enabled !== 0);
        current.suspended = current.suspended && Boolean(item.is_suspended || item.suspended);
        current.isOtc = current.isOtc || item.is_otc === true || item.isOtc === true || /(?:^|[._ -])OTC$/i.test(asset);
        if (modality) {
          if (!current.modalities.includes(modality)) current.modalities.push(modality);
          current.productStatus[modality] = { enabled: item.enabled !== false && item.is_enabled !== false, suspended: Boolean(item.is_suspended || item.suspended) };
        }
        merged.set(activeId, current);
      }
    };
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue;
      add(root.binary?.actives ?? root.binary, 'binary');
      add(root.turbo?.actives ?? root.turbo, 'binary');
      add(root.digital?.actives ?? root.digital, 'digital');
      add(root.digital_options?.actives ?? root.digital_options, 'digital');
      add(root.actives, null);
    }
    return [...merged.values()];
  }

  handle(packet) {
    const outerName = packet?.name;
    const msg = packet?.msg || {};
    const name = outerName === 'sendMessage' ? (msg.name || msg.status) : outerName;

    if (name === 'profile' || name === 'authenticated') {
      this.authenticated = true;
      this.retry = 0;
      this.emit('connected');
      this.sendMessage('get-initialization-data', '3.0', {});
      // Compatibility request for servers still exposing the older initialization channel.
      this.sendRaw({ name: 'api_option_init_all', msg: '' });
      return;
    }

    if (name === 'heartbeat') {
      this.sendRaw({ name: 'heartbeat', msg });
      return;
    }

    if (name === 'initialization-data' || name === 'api_option_init_all' || name === 'api_option_init_all_result') {
      const assets = this.extractActives(msg);
      if (assets.length) {
        this.assets = new Map(assets.map(asset => [asset.activeId, asset]));
        this.emit('assets', assets);
        this.requestMarketData(assets.filter(asset => asset.enabled && !asset.suspended));
      }
      return;
    }

    if (name === 'candles') {
      const requestId = String(packet.request_id || '');
      const match = requestId.match(/^history:(\d+):(60|300)$/);
      if (match) {
        const asset = this.assets.get(Number(match[1]));
        const candles = Array.isArray(msg) ? msg : (msg?.candles || msg?.data || msg?.result || []);
        if (asset && Array.isArray(candles)) {
          this.emit('candles', {
            asset: asset.asset,
            activeId: asset.activeId,
            timeframe: Number(match[2]) === 60 ? 'M1' : 'M5',
            candles
          });
        }
      }
      return;
    }

    if (name === 'candle-generated') {
      const candle = msg?.msg || msg;
      const id = Number(candle?.active_id ?? candle?.activeId);
      const size = Number(candle?.size);
      const asset = this.assets.get(id);
      if (asset && (size === 60 || size === 300)) {
        this.emit('candle', {
          asset: asset.asset,
          activeId: id,
          timeframe: size === 60 ? 'M1' : 'M5',
          candle
        });
      }
    }
  }

  requestMarketData(assets) {
    for (const asset of assets) for (const size of [60, 300]) {
      this.requestQueue.push({ type: 'subscribe', asset, size });
      this.requestQueue.push({ type: 'history', asset, size });
    }
    this.pumpQueue();
  }

  pumpQueue() {
    if (this.queueTimer || this.stopped || !this.authenticated) return;
    const item = this.requestQueue.shift();
    if (!item) return;
    if (item.type === 'subscribe') {
      const params = { routingFilters: { active_id: item.asset.activeId, size: item.size } };
      const key = 'candle-generated:' + JSON.stringify(params);
      if (!this.subscriptions.has(key)) {
        this.subscriptions.add(key);
        this.sendRaw({ name: 'subscribeMessage', request_id: String(++this.requestSeq), msg: { name: 'candle-generated', params } });
      }
    } else {
      this.sendMessage('get-candles', '2.0', { active_id: item.asset.activeId, size: item.size, to: Math.floor(Date.now() / 1000), count: 100 }, 'history:' + item.asset.activeId + ':' + item.size);
    }
    this.queueTimer = setTimeout(() => { this.queueTimer = null; this.pumpQueue(); }, 40);
  }

  reconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30000, 2000 * (2 ** Math.min(this.retry++, 4)));
    this.emit('reconnecting', { delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
  }
}

module.exports = { NexusIqConnector };
