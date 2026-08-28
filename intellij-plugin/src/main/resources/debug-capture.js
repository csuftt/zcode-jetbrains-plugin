(function () {
  if (window.__zcodeDebug && window.__zcodeDebug.v === 1) return;
  var MAX_CONSOLE = 400, MAX_NET = 300, MAX_UNCAUGHT = 50;
  var bootT = Date.now();
  var consoleBuf = [], netBuf = [], uncaughtBuf = [];

  function trunc(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s;
  }

  function ser(v) {
    try {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      var t = typeof v;
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v);
      if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (v instanceof Error) return v.stack ? trunc(v.stack, 4000) : (v.name + ': ' + v.message);
      if (typeof HTMLElement !== 'undefined' && v instanceof HTMLElement) {
        return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
      }
      var seen = [];
      var s = JSON.stringify(v, function (k, val) {
        if (typeof val === 'function') return '[Function]';
        if (val instanceof Error) return val.stack || (val.name + ': ' + val.message);
        if (typeof val === 'object' && val !== null) {
          if (seen.indexOf(val) >= 0) return '[Circular]';
          seen.push(val);
        }
        return val;
      });
      if (s === undefined) return String(v);
      return trunc(s, 2048);
    } catch (e) {
      return String(v);
    }
  }

  function trim(a, max) {
    while (a.length > max) a.shift();
  }

  function bodyDesc(b) {
    if (b == null) return undefined;
    if (typeof b === 'string') return trunc(b, 1024);
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return trunc(String(b), 1024);
    if (typeof FormData !== 'undefined' && b instanceof FormData) return '[FormData]';
    if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + 'B]';
    return trunc(ser(b), 256);
  }

  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u); }
  }

  // ---- console.* 补丁（透传原实现）----
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(ser(arguments[i]));
        consoleBuf.push({ t: Date.now(), level: level, text: trunc(parts.join(' '), 4000) });
        trim(consoleBuf, MAX_CONSOLE);
      } catch (e) { /* 采集失败不影响页面 */ }
      return orig.apply(console, arguments);
    };
  });

  // ---- 未捕获异常 / 未处理 rejection ----
  window.addEventListener('error', function (e) {
    try {
      uncaughtBuf.push({
        t: Date.now(), kind: 'error',
        msg: e.message || String(e),
        src: (e.filename || '') + (e.lineno ? ':' + e.lineno : ''),
        stack: e.error && e.error.stack ? trunc(e.error.stack, 4000) : undefined,
      });
      trim(uncaughtBuf, MAX_UNCAUGHT);
    } catch (ex) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      uncaughtBuf.push({ t: Date.now(), kind: 'unhandledrejection', msg: ser(e.reason) });
      trim(uncaughtBuf, MAX_UNCAUGHT);
    } catch (ex) {}
  });

  // ---- fetch 补丁 ----
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var e = { t: Date.now(), via: 'fetch' };
        try {
          e.url = typeof input === 'string' ? absUrl(input) : (input && input.url) || String(input);
          e.method = (((init && init.method) || (input && input.method) || 'GET') + '').toUpperCase();
          if (init && init.body != null) e.reqBody = bodyDesc(init.body);
        } catch (ex) { /* 记录失败不拦截请求 */ }
        netBuf.push(e); trim(netBuf, MAX_NET);
        var t0 = Date.now();
        return origFetch.apply(window, arguments).then(function (resp) {
          e.ms = Date.now() - t0;
          try { e.status = resp.status; } catch (ex) {}
          try {
            var ct = (resp.headers && resp.headers.get('content-type')) || '';
            if (ct.indexOf('event-stream') < 0) {
              resp.clone().text().then(function (txt) { e.resBody = trunc(txt, 2048); })
                .catch(function () {});
            }
          } catch (ex) {}
          return resp;
        }, function (err) {
          e.ms = Date.now() - t0;
          e.failed = true;
          e.error = err && err.message ? err.message : String(err);
          throw err;
        });
      };
    }
  } catch (ex) { /* fetch 不可 patch 的环境跳过 */ }

  // ---- XMLHttpRequest 补丁 ----
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__zc = { t: Date.now(), via: 'xhr', method: String(method || 'GET').toUpperCase(), url: absUrl(url) };
      } catch (ex) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        var e = this.__zc || (this.__zc = { t: Date.now(), via: 'xhr', method: '?', url: '' });
        if (body != null) e.reqBody = bodyDesc(body);
        if (netBuf.indexOf(e) < 0) { netBuf.push(e); trim(netBuf, MAX_NET); }
        var self = this, t0 = Date.now();
        this.addEventListener('loadend', function () {
          e.ms = Date.now() - t0;
          try { e.status = self.status; } catch (ex) {}
          try {
            var ct = self.getResponseHeader('content-type') || '';
            if (self.responseType === '' || self.responseType === 'text') {
              if (ct.indexOf('event-stream') < 0) e.resBody = trunc(self.responseText, 2048);
            } else {
              e.resBody = '[' + (self.responseType || 'text') + ']';
            }
          } catch (ex) {}
        });
      } catch (ex) { /* 记录失败不拦截请求 */ }
      return origSend.apply(this, arguments);
    };
  } catch (ex) { /* XHR 不可 patch 的环境跳过 */ }

  /**
   * 读取调试数据。dump() 默认各取最近若干条；可选：
   *   dump()                          → {page, counts, console, net, uncaught}
   *   dump({console: 80, net: 80})    → 自定义条数（0 表示不要）
   *   dump({level: 'error'})          → console 只保留该级别
   */
  function dump(opts) {
    opts = opts || {};
    var nC = opts.console != null ? opts.console : 40;
    var nN = opts.net != null ? opts.net : 40;
    var nU = opts.uncaught != null ? opts.uncaught : 15;
    var cs = opts.level ? consoleBuf.filter(function (x) { return x.level === opts.level; }) : consoleBuf;
    return {
      page: location.href,
      since: bootT,
      counts: { console: consoleBuf.length, net: netBuf.length, uncaught: uncaughtBuf.length, browserMsgs: browserMsgs.length },
      console: nC > 0 ? cs.slice(-nC) : [],
      net: nN > 0 ? netBuf.slice(-nN) : [],
      uncaught: nU > 0 ? uncaughtBuf.slice(-nU) : [],
    };
  }

  /** 浏览器层消息（宿主 onConsoleMessage 合入：网络错误如 Failed to load resource: 404 等非 console API 消息）*/
  var browserMsgs = [];

  window.__zcodeDebug = { v: 1, console: consoleBuf, net: netBuf, uncaught: uncaughtBuf, browserMsgs: browserMsgs, dump: dump };
})();
