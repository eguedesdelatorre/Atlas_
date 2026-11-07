'use strict';
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
    this.authenticated = false;
  }

  async login() {
    const body = new URLSearchParams({ identifier: this.email, password: this.password });
    const response = await fetch('https://auth.iqoption.com/api/v2/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        origin: 'https://iqoption.com',
        referer: 'https://iqoption.com/'
      },
      body
    });
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
    const candidates = [
      msg?.result?.actives,
      msg?.result?.binary?.actives,
      msg?.result?.turbo?.actives,
      msg?.result?.digital?.actives,
      msg?.actives,
      msg?.binary?.actives,
      msg?.turbo?.actives,
      msg?.digital?.actives
    ];
    const raw = candidates.find(value => value && typeof value === 'object') || {};
    const entries = Array.isArray(raw)
      ? raw.map((item, index) => [String(item.active_id ?? item.id ?? index), item])
      : Object.entries(raw);
    return entries.map(([id, item]) => ({
      activeId: Number(item.active_id ?? item.id ?? id),
      asset: String(item.name || item.title || item.instrument_name || id),
      enabled: item.enabled !== false && item.is_enabled !== false,
      suspended: Boolean(item.is_suspended || item.suspended)
    })).filter(item => Number.isFinite(item.activeId) && item.activeId > 0);
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
        this.requestMarketData(assets.filter(asset => asset.enabled && !asset.suspended).slice(0, 100));
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
    for (const asset of assets) {
      for (const size of [60, 300]) {
        this.subscribe('candle-generated', { routingFilters: { active_id: asset.activeId, size } });
        const requestId = 'history:' + asset.activeId + ':' + size;
        this.sendMessage('get-candles', '2.0', {
          active_id: asset.activeId,
          size,
          to: Math.floor(Date.now() / 1000),
          count: 100
        }, requestId);
      }
    }
  }

  reconnect() {
    if (this.stopped) return;
    const delay = Math.min(30000, 2000 * (2 ** Math.min(this.retry++, 4)));
    this.emit('reconnecting', { delay });
    setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}

module.exports = { NexusIqConnector };
