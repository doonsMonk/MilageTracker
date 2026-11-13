(function () {
  'use strict';

  // ---------- storage (native file via the Android bridge, localStorage in a browser) ----------
  var KEY = 'mileage-log-v1';
  var native = window.Android || null;
  var store = {
    load: function () {
      try {
        var s = native ? native.loadData() : localStorage.getItem(KEY);
        if (s) return JSON.parse(s);
      } catch (e) { /* fall through to seed */ }
      return null;
    },
    save: function (st) {
      var s = JSON.stringify(st);
      if (native) native.saveData(s); else localStorage.setItem(KEY, s);
    }
  };

  function isLog(x) { return !!x && Array.isArray(x.fills) && Array.isArray(x.expenses); }
  function validState(s) { return isLog(s) || (!!s && Array.isArray(s.vehicles) && s.vehicles.length > 0 && s.vehicles.every(isLog)); }
  // Version 1 kept one car at the top level; version 2 keeps a list of vehicles.
  function migrate(s) {
    if (!Array.isArray(s.vehicles)) {
      s = { version: 2, settings: s.settings, activeId: 'v1', vehicles: [{
        id: 'v1', name: (s.car && s.car.name) || 'My car', type: 'car', photo: null, stockPhoto: 'car.jpg',
        currentOdo: s.currentOdo || null, fills: s.fills, expenses: s.expenses }] };
    }
    if (!s.settings) s.settings = { theme: 'system' };
    if (!s.vehicles.some(function (v) { return v.id === s.activeId; })) s.activeId = s.vehicles[0].id;
    return s;
  }
  // "2 vehicles, 49 fill-ups and 27 expenses" for either data version.
  function describe(s) {
    var vs = Array.isArray(s.vehicles) ? s.vehicles : [s];
    var f = 0, e = 0; vs.forEach(function (v) { f += v.fills.length; e += v.expenses.length; });
    return (vs.length > 1 ? vs.length + ' vehicles, ' : '') + f + ' fill-ups and ' + e + ' expenses';
  }
  var state = store.load();
  var fresh = !validState(state) || !Array.isArray(state.vehicles);
  // seed.js (personal starting data) is optional and not in version control; without it start empty.
  if (!validState(state)) {
    state = typeof SEED_DATA !== 'undefined' ? JSON.parse(JSON.stringify(SEED_DATA))
      : { version: 2, activeId: 'v1', vehicles: [{ id: 'v1', name: 'My car', type: 'car', photo: null, stockPhoto: null, currentOdo: null, fills: [], expenses: [] }] };
  }
  state = migrate(state);
  if (fresh) store.save(state);
  var veh; // the vehicle currently shown
  function pickVehicle() { veh = state.vehicles.filter(function (v) { return v.id === state.activeId; })[0] || state.vehicles[0]; }
  pickVehicle();
  function vehIcon(v) { return v.type === 'motorcycle' ? '🏍️' : '🚗'; }

  // ---------- theme (System / Light / Dark) ----------
  var systemDark = native ? !!native.isDark() : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var C_REG, C_PREM; // chart series colours, read from the active theme
  function applyTheme() {
    var th = state.settings.theme;
    var dark = th === 'dark' || (th !== 'light' && systemDark);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var cs = getComputedStyle(document.documentElement);
    C_REG = cs.getPropertyValue('--series-regular').trim();
    C_PREM = cs.getPropertyValue('--series-premium').trim();
  }
  window.onSystemTheme = function (dark) { systemDark = !!dark; applyTheme(); render(); };
  applyTheme();

  // ---------- cloud file status (kept in sync by the Android shell) ----------
  var cloud = { connected: false, account: '', lastSync: 0, error: '', busy: false };
  function readCloud() { if (native) { try { cloud = JSON.parse(native.cloudStatus()); } catch (e) { /* keep default */ } } }
  readCloud();
  function allPhotos(st) {
    var out = [];
    (st.fills || []).concat(st.expenses || []).forEach(function (x) { (x.photos || []).forEach(function (p) { out.push(p); }); });
    return out;
  }

  var data;            // result of Calc.compute(state)
  var tab = 'home';
  var logKind = 'fills';
  var monthMetric = 'total';
  var tripForm = null;

  function commit() { store.save(state); refresh(); }
  function refresh() { pickVehicle(); data = Calc.compute(veh); render(); }
  function uid(p) { return p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  // ---------- formatting ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(v, d) { return v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function rs(v, d) { return v == null || !isFinite(v) ? '–' : '₹' + n(v, d); }
  function fdate(iso) { var p = iso.split('-'); return p[2] + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function fmonth(key) { var p = key.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  var TYPE_LABEL = { toll: 'Toll', emi: 'EMI', other: 'Consumables / other' };
  function fuelName(premium) { return premium ? '95 octane' : 'Regular'; }

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var view = $('#view');

  // ---------- tiny bar chart (inline SVG, tap for details) ----------
  // items: [{value, color, tip, xlabel}]  opts: {height, ref, refLabel, fmt}
  function barChart(host, items, opts) {
    opts = opts || {};
    var W = Math.max(host.clientWidth, 260), H = opts.height || 170;
    var padL = 30, padR = 6, padT = 12, padB = 18;
    var max = Math.max.apply(null, items.map(function (i) { return i.value || 0; }).concat([opts.ref || 0, 1]));
    var step = niceStep(max / 3), top = Math.ceil(max / step) * step;
    var pw = W - padL - padR, ph = H - padT - padB;
    var slot = pw / Math.max(items.length, 1), bw = Math.max(2, Math.min(28, slot - 2));
    var y = function (v) { return padT + ph - (v / top) * ph; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="img">';
    for (var g = 0; g <= top + 1e-9; g += step) {
      s += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(g) + '" y2="' + y(g) + '"/>' +
        '<text x="' + (padL - 5) + '" y="' + (y(g) + 3) + '" text-anchor="end">' + (opts.fmt ? opts.fmt(g) : g) + '</text>';
    }
    items.forEach(function (it, i) {
      var v = it.value || 0; if (v <= 0) return;
      var x = padL + i * slot + (slot - bw) / 2, yy = y(v), h = padT + ph - yy, r = Math.min(4, bw / 2, h);
      s += '<path fill="' + it.color + '" d="M' + x + ' ' + (yy + h) + 'V' + (yy + r) + 'q0 -' + r + ' ' + r + ' -' + r + 'h' + (bw - 2 * r) + 'q' + r + ' 0 ' + r + ' ' + r + 'V' + (yy + h) + 'z"/>';
    });
    // sparse x labels: first, middle, last
    [0, Math.floor((items.length - 1) / 2), items.length - 1].filter(function (v, i, a) { return v >= 0 && a.indexOf(v) === i; }).forEach(function (i, k, a) {
      var anchor = k === 0 ? 'start' : (k === a.length - 1 ? 'end' : 'middle');
      var x = k === 0 ? padL : (k === a.length - 1 ? W - padR : padL + i * slot + slot / 2);
      s += '<text x="' + x + '" y="' + (H - 4) + '" text-anchor="' + anchor + '">' + esc(items[i].xlabel || '') + '</text>';
    });
    if (opts.ref) {
      s += '<line class="ref" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(opts.ref) + '" y2="' + y(opts.ref) + '"/>' +
        '<text class="reflbl" x="' + (W - padR) + '" y="' + (y(opts.ref) - 4) + '" text-anchor="end">' + esc(opts.refLabel || '') + '</text>';
    }
    s += '</svg><div class="tip" hidden></div>';
    host.innerHTML = s;
    var tip = $('.tip', host);
    function show(ev) {
      var rect = host.getBoundingClientRect();
      var px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      var i = Math.floor((px * (W / rect.width) - padL) / slot);
      if (i < 0 || i >= items.length) { tip.hidden = true; return; }
      tip.innerHTML = items[i].tip; tip.hidden = false;
      var tw = tip.offsetWidth, cx = (padL + i * slot + slot / 2) * (rect.width / W);
      tip.style.left = Math.max(0, Math.min(rect.width - tw, cx - tw / 2)) + 'px';
    }
    host.addEventListener('click', show);
    host.addEventListener('touchmove', show, { passive: true });
  }
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- views ----------
  function render() {
    $('#subtitle').textContent = vehIcon(veh) + ' ' + veh.name + '  ▾';
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    $('#fab').hidden = !(tab === 'home' || tab === 'log');
    ({ home: renderHome, log: renderLog, monthly: renderMonthly, trip: renderTrip, more: renderMore })[tab]();
  }

  function renderHome() {
    var t = data.totals, reg = data.regular, pr = data.premium;
    if (!data.rows.length) {
      view.innerHTML = vehPicHtml(veh) + '<div class="empty">No fill-ups yet for this vehicle.<br>Tap + to add the first one.</div>';
      return;
    }
    view.innerHTML =
      vehPicHtml(veh) +
      '<div class="tiles">' +
        '<div class="tile hero"><div><div class="lbl">Average mileage</div><div class="val">' + n(t.avgKmpl, 1) + '<small>km/l</small></div>' +
          '<div class="sub">Last 5 tanks ' + n(t.recentKmpl, 1) + ' · last tank ' + n(t.lastKmpl, 1) + '</div></div></div>' +
        '<div class="tile odo"><div><div class="lbl">Odometer</div><div class="val">' + n(t.odoNow) + '<small>km</small></div></div>' +
          '<button class="btn ghost" id="odoBtn">Update</button></div>' +
        tile('Fuel cost per km', rs(t.fuelCpk, 2), 'with tolls ' + rs(t.runCpk, 2)) +
        tile('Overall cost per km', rs(t.overallCpk, 2), 'fuel + tolls + EMI + other') +
        tile('Total fuel', n(t.litres, 1) + '<small>L</small>', t.fills + ' fill-ups · avg ' + rs(t.avgPrice, 2) + '/L') +
        tile('Distance logged', n(t.distance) + '<small>km</small>', 'since first fill-up') +
      '</div>' +
      '<div class="card"><h2>Total cost so far</h2>' +
        kv('Fuel', rs(t.fuelCost)) + kv('Tolls', rs(t.tolls)) + kv('EMI', rs(t.emi)) + kv('Consumables / other', rs(t.other)) +
        '<div class="kv total"><span>Total</span><b>' + rs(t.totalCost) + '</b></div></div>' +
      '<div class="card"><h2>Mileage per fill-up <small>(km/l)</small></h2>' +
        '<div class="legend"><span><i class="dot reg"></i>Regular (92–93)</span><span><i class="dot prem"></i>95 octane</span></div>' +
        '<div class="chart" id="kmplChart"></div>' +
        '<p class="note">Tap a bar for details. Partial fills make single-tank figures jump around; the average is distance ÷ fuel.</p></div>' +
      '<div class="card"><h2>Regular vs 95 octane</h2><table class="cmp"><thead><tr><th></th><th><i class="dot reg"></i>Regular</th><th><i class="dot prem"></i>95 octane</th></tr></thead><tbody>' +
        cmp('Fill-ups', reg.fills, pr.fills) + cmp('Litres', n(reg.litres, 1), n(pr.litres, 1)) + cmp('Spent', rs(reg.cost), rs(pr.cost)) +
        cmp('Avg price / L', rs(reg.avgPrice, 2), rs(pr.avgPrice, 2)) + cmp('Mileage (km/l)', n(reg.kmpl, 1), n(pr.kmpl, 1)) + cmp('Fuel cost / km', rs(reg.cpk, 2), rs(pr.cpk, 2)) +
        '</tbody></table><p class="note">Approximate: each tank’s distance is credited to the fuel filled at its start.</p></div>';

    var items = data.rows.filter(function (r) { return r.kmpl != null; }).map(function (r) {
      return { value: r.kmpl, color: r.premium ? C_PREM : C_REG, xlabel: fmonth(r.date.slice(0, 7)),
        tip: '<b>' + n(r.kmpl, 1) + ' km/l</b> · ' + fuelName(r.premium) + '<br>' + fdate(r.date) + ' · ' + n(r.km) + ' km on ' + n(r.litres, 2) + ' L' };
    });
    barChart($('#kmplChart'), items, { ref: t.avgKmpl, refLabel: 'avg ' + n(t.avgKmpl, 1) });
    $('#odoBtn').onclick = odoSheet;
  }
  function vehPicHtml(v) {
    var src = v.photo ? 'bills/' + v.photo : v.stockPhoto;
    return '<div class="carpic' + (src ? '' : ' nopic') + '">' + (src ? '<img src="' + esc(src) + '" alt="" onerror="this.parentNode.classList.add(\'nopic\')">' : '') +
      '<b class="ico">' + vehIcon(v) + '</b><span>' + esc(v.name) + '</span></div>';
  }
  function tile(lbl, val, sub) { return '<div class="tile"><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div><div class="sub">' + sub + '</div></div>'; }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }
  function cmp(k, a, b) { return '<tr><td>' + k + '</td><td>' + a + '</td><td>' + b + '</td></tr>'; }

  function fillRowHtml(r) {
    var perf = r.km == null ? 'distance pending' :
      n(r.km) + ' km · ' + n(r.kmpl, 1) + ' km/l · ' + rs(r.cpk, 2) + '/km' + (r.open ? ' (so far)' : '');
    return '<div class="row ' + (r.premium ? 'prem' : 'reg') + '" data-fill="' + esc(r.id) + '"><div class="a"><div class="t">' + fdate(r.date) + '</div>' +
      '<div class="s">' + perf + '</div>' +
      '<span class="badge ' + (r.premium ? 'prem' : '') + '">' + fuelName(r.premium) + '</span>' + clip(r.photos) + (r.note ? ' <span class="s">' + esc(r.note) + '</span>' : '') + '</div>' +
      '<div class="b"><div class="t">' + rs(r.cost) + '</div><div class="s">' + n(r.litres, 2) + ' L @ ' + rs(r.price, 2) + '</div><div class="s">odo ' + n(r.odo) + '</div></div></div>';
  }
  function clip(photos) { return photos && photos.length ? '<span class="clip">📎 ' + photos.length + (photos.length === 1 ? ' bill' : ' bills') + '</span>' : ''; }
  function expRowHtml(e) {
    return '<div class="row" data-exp="' + esc(e.id) + '"><div class="a"><div class="t">' + TYPE_LABEL[e.type] + clip(e.photos) + '</div><div class="s">' + fdate(e.date) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div>' +
      '<div class="b"><div class="t">' + rs(e.amount) + '</div></div></div>';
  }
  function grouped(list, rowFn) {
    var out = '', cur = '';
    list.forEach(function (x) {
      var k = x.date.slice(0, 7);
      if (k !== cur) { cur = k; out += '<div class="month-head">' + fmonth(k) + '</div>'; }
      out += rowFn(x);
    });
    return out;
  }
  function bindRows(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-fill]'), function (el) { el.onclick = function () { fillSheet(el.dataset.fill); }; });
    Array.prototype.forEach.call(root.querySelectorAll('[data-exp]'), function (el) { el.onclick = function () { expenseSheet(el.dataset.exp); }; });
  }

  function renderLog() {
    var list = logKind === 'fills' ? data.rows.slice().reverse() : data.expenses.slice().reverse();
    view.innerHTML = '<div class="seg"><button data-k="fills" class="' + (logKind === 'fills' ? 'on' : '') + '">Fill-ups (' + data.rows.length + ')</button>' +
      '<button data-k="exp" class="' + (logKind === 'exp' ? 'on' : '') + '">Tolls, EMI & other (' + data.expenses.length + ')</button></div>' +
      (list.length ? grouped(list, logKind === 'fills' ? fillRowHtml : expRowHtml) : '<div class="empty">Nothing here yet. Tap + to add.</div>');
    Array.prototype.forEach.call(view.querySelectorAll('.seg button'), function (b) { b.onclick = function () { logKind = b.dataset.k; render(); }; });
    bindRows(view);
  }

  var METRICS = {
    total: { label: 'Total spend', get: function (m) { return m.total; }, fmt: function (v) { return rs(v); } },
    fuel: { label: 'Fuel spend', get: function (m) { return m.fuel; }, fmt: function (v) { return rs(v); } },
    km: { label: 'Distance', get: function (m) { return m.km; }, fmt: function (v) { return n(v) + ' km'; } },
    kmpl: { label: 'Mileage', get: function (m) { return m.kmpl; }, fmt: function (v) { return n(v, 1) + ' km/l'; } }
  };
  function axisFmt(v) { return v >= 1000 ? (v / 1000) + 'k' : String(v); }

  function renderMonthly() {
    var ms = data.monthly;
    if (!ms.length) { view.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    var mt = METRICS[monthMetric];
    view.innerHTML = '<div class="chips">' + Object.keys(METRICS).map(function (k) {
      return '<button data-m="' + k + '" class="' + (k === monthMetric ? 'on' : '') + '">' + METRICS[k].label + '</button>'; }).join('') + '</div>' +
      '<div class="card"><h2>' + mt.label + ' by month</h2><div class="chart" id="mChart"></div></div>' +
      ms.slice().reverse().map(function (m) {
        return '<div class="card" data-month="' + m.key + '"><div class="mhead"><span class="t">' + fmonth(m.key) + '</span><span class="v">' + rs(m.total) + '</span></div>' +
          '<div class="mgrid">' +
          mg('Distance', n(m.km) + ' km') + mg('Mileage', n(m.kmpl, 1) + ' km/l') + mg('Fuel', n(m.litres, 1) + ' L') +
          mg('Fuel cost', rs(m.fuel)) + mg('Tolls', rs(m.tolls)) + mg('EMI', rs(m.emi)) +
          mg('Other', rs(m.other)) + mg('Fill-ups', m.fills) + mg('Fuel+toll / km', rs(m.cpk, 2)) +
          '</div></div>';
      }).join('');
    barChart($('#mChart'), ms.map(function (m) {
      return { value: mt.get(m), color: C_REG, xlabel: fmonth(m.key), tip: '<b>' + mt.fmt(mt.get(m)) + '</b><br>' + fmonth(m.key) };
    }), { fmt: axisFmt });
    Array.prototype.forEach.call(view.querySelectorAll('.chips button'), function (b) { b.onclick = function () { monthMetric = b.dataset.m; render(); }; });
    Array.prototype.forEach.call(view.querySelectorAll('[data-month]'), function (c) { c.onclick = function () { monthSheet(c.dataset.month); }; });
  }
  function mg(k, v) { return '<div><span>' + k + '</span><b>' + v + '</b></div>'; }

  function monthSheet(key) {
    var fills = data.rows.filter(function (r) { return r.date.slice(0, 7) === key; });
    var exps = data.expenses.filter(function (e) { return e.date.slice(0, 7) === key; });
    openSheet('<h3>' + fmonth(key) + '</h3>' +
      (fills.length ? '<div class="month-head">Fill-ups</div>' + fills.map(fillRowHtml).join('') : '') +
      (exps.length ? '<div class="month-head">Tolls, EMI & other</div>' + exps.map(expRowHtml).join('') : '') +
      '<div class="actions"><button class="btn ghost" id="mClose">Close</button><button class="btn primary" id="mPrint">Print this month</button></div>');
    bindRows($('#sheet'));
    $('#mClose').onclick = closeSheet;
    $('#mPrint').onclick = function () { closeSheet(); showReport('month', key); };
  }

  function renderTrip() {
    var t = data.totals;
    if (!tripForm) {
      var lastPremium = data.rows.length ? data.rows[data.rows.length - 1].premium : false;
      tripForm = { distance: 250, round: false, premium: lastPremium, price: '', basis: 'avg', custom: '', tolls: '' };
    }
    var f = tripForm;
    view.innerHTML =
      '<div class="result" id="tripResult"></div>' +
      '<div class="card"><h2>Trip</h2>' +
        '<label class="f"><span>Distance (km)</span><input id="tDist" type="number" inputmode="decimal" value="' + esc(f.distance) + '"></label>' +
        '<label class="check"><input id="tRound" type="checkbox"' + (f.round ? ' checked' : '') + '> Round trip (double the distance)</label>' +
        '<div class="seg" id="tFuel"><button data-p="0" class="' + (!f.premium ? 'on' : '') + '">Regular (92–93)</button><button data-p="1" class="' + (f.premium ? 'on prem' : '') + '">95 octane</button></div>' +
        '<div class="grid2"><label class="f"><span>Fuel price (₹/L)</span><input id="tPrice" type="number" inputmode="decimal" value="' + esc(f.price) + '"></label>' +
        '<label class="f"><span>Expected tolls (₹)</span><input id="tTolls" type="number" inputmode="decimal" placeholder="0" value="' + esc(f.tolls) + '"></label></div>' +
        '<label class="f"><span>Mileage to assume</span><select id="tBasis">' +
          opt('avg', 'Overall average – ' + n(t.avgKmpl, 1) + ' km/l', f.basis) +
          opt('recent', 'Last 5 tanks – ' + n(t.recentKmpl, 1) + ' km/l', f.basis) +
          opt('custom', 'Custom…', f.basis) + '</select></label>' +
        '<label class="f" id="tCustomWrap"><span>Custom mileage (km/l)</span><input id="tCustom" type="number" inputmode="decimal" value="' + esc(f.custom) + '"></label>' +
      '</div>';

    function defaultPrice() { var p = (f.premium ? data.premium : data.regular).lastPrice || t.avgPrice; return p ? p.toFixed(2) : ''; }
    if (f.price === '') { f.price = defaultPrice(); $('#tPrice').value = f.price; }
    function calc() {
      f.distance = $('#tDist').value; f.round = $('#tRound').checked; f.price = $('#tPrice').value;
      f.tolls = $('#tTolls').value; f.basis = $('#tBasis').value; f.custom = $('#tCustom').value;
      $('#tCustomWrap').hidden = f.basis !== 'custom';
      var kmpl = f.basis === 'avg' ? t.avgKmpl : f.basis === 'recent' ? t.recentKmpl : parseFloat(f.custom);
      var dist = parseFloat(f.distance) * (f.round ? 2 : 1);
      var r = Calc.trip(dist, kmpl, parseFloat(f.price), parseFloat(f.tolls) || 0);
      $('#tripResult').innerHTML = r ?
        '<div class="lbl">Estimated trip cost · ' + n(dist) + ' km</div><div class="big">' + rs(r.total) + '</div>' +
        '<div class="rgrid"><div><span class="lbl">Fuel needed</span><b>' + n(r.litres, 1) + ' L</b></div>' +
        '<div><span class="lbl">Fuel cost</span><b>' + rs(r.fuelCost) + '</b></div>' +
        '<div><span class="lbl">Per km</span><b>' + rs(r.perKm, 2) + '</b></div></div>' :
        '<div class="lbl">Estimated trip cost</div><div class="big">–</div><div class="lbl">Enter distance, fuel price and mileage.</div>';
    }
    ['tDist', 'tRound', 'tPrice', 'tTolls', 'tBasis', 'tCustom'].forEach(function (id) { $('#' + id).addEventListener('input', calc); });
    Array.prototype.forEach.call(document.querySelectorAll('#tFuel button'), function (b) {
      b.onclick = function () { calc(); f.premium = b.dataset.p === '1'; f.price = ''; renderTrip(); };
    });
    calc();
  }
  function opt(v, label, cur) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; }

  function renderMore() {
    var th = state.settings.theme || 'system';
    view.innerHTML =
      '<div class="card"><h2>Vehicles</h2><div class="menu">' +
        state.vehicles.map(function (v) {
          return '<button data-veh="' + esc(v.id) + '"><span>' + vehIcon(v) + ' ' + esc(v.name) + '<small>' + (v.id === veh.id ? 'Showing now · ' : '') + v.fills.length + ' fill-ups · tap to edit</small></span></button>'; }).join('') +
        mi('vehAdd', '＋ Add a car or motorcycle', '') + '</div></div>' +
      '<div class="card"><h2>Appearance</h2><div class="seg" id="themeSeg" style="margin:0">' + ['system', 'light', 'dark'].map(function (k) {
        return '<button data-th="' + k + '" class="' + (k === th ? 'on' : '') + '">' + { system: 'System', light: 'Light', dark: 'Dark' }[k] + '</button>'; }).join('') + '</div></div>' +
      cloudCardHtml() +
      '<div class="card"><h2>Print</h2><div class="menu">' +
        mi('pFull', 'Full report', 'Summary, monthly table and every entry') +
        mi('pMonthly', 'Monthly summary', 'Summary and month-by-month table') +
        mi('pMonth', 'One month…', 'Entries for a single month') + '</div></div>' +
      '<div class="card"><h2>Export & backup</h2><div class="menu">' +
        mi('xFills', 'Export fill-ups (CSV)', 'Opens in Google Sheets / Excel') +
        mi('xExp', 'Export tolls, EMI & other (CSV)', '') +
        mi('xBackup', 'Back up all data', native ? 'One .zip with the log and all bill photos' : 'Saves a .json file you can restore later') +
        mi('xRestore', 'Restore from backup', 'Replaces the data in the app') + '</div></div>' +
      '<div class="card"><h2>Data</h2><div class="menu">' +
        mi('odo', 'Update odometer', esc(veh.name) + ' · ' + n(data.totals.odoNow) + ' km') +
        '<button id="wipe" class="dangerous"><span>Delete all data</span></button></div></div>' +
      updateCardHtml();
    $('#pFull').onclick = function () { showReport('full'); };
    $('#pMonthly').onclick = function () { showReport('monthly'); };
    $('#pMonth').onclick = pickMonthSheet;
    $('#xFills').onclick = function () { saveFile('fill-ups.csv', 'text/csv', fillsCsv()); };
    $('#xExp').onclick = function () { saveFile('expenses.csv', 'text/csv', expensesCsv()); };
    Array.prototype.forEach.call(document.querySelectorAll('#themeSeg button'), function (b) {
      b.onclick = function () { state.settings.theme = b.dataset.th; applyTheme(); commit(); };
    });
    bindCloudCard();
    bindUpdateCard();
    $('#xBackup').onclick = function () { if (native) { native.saveBackupZip('milagetracker-backup-' + today() + '.zip'); return; } saveFile('milagetracker-backup-' + today() + '.json', 'application/json', JSON.stringify(state, null, 1)); };
    $('#xRestore').onclick = pickFile;
    Array.prototype.forEach.call(view.querySelectorAll('[data-veh]'), function (b) { b.onclick = function () { vehicleSheet(b.dataset.veh); }; });
    $('#vehAdd').onclick = function () { vehicleSheet(null); };
    $('#odo').onclick = odoSheet;
    $('#wipe').onclick = function () {
      confirmSheet('Delete all data?', 'Every vehicle, fill-up, expense and bill photo in the app will be removed. Make a backup first if you might want it back.', 'Delete everything', function () {
        if (native) native.deleteAllPhotos();
        state = migrate({ version: 2, settings: state.settings, activeId: 'v1', vehicles: [{ id: 'v1', name: veh.name, type: veh.type, photo: null, stockPhoto: veh.stockPhoto || null, currentOdo: null, fills: [], expenses: [] }] });
        tripForm = null; commit(); toast('All data deleted');
      });
    };
  }
  function mi(id, title, sub) { return '<button id="' + id + '"><span>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</span></button>'; }

  // ---------- bottom sheets ----------
  var sheet = $('#sheet'), scrim = $('#scrim');
  var sheetCleanup = null; // runs when a sheet is dismissed without saving
  function runCleanup() { var c = sheetCleanup; sheetCleanup = null; if (c) c(); }
  function openSheet(html) { runCleanup(); sheet.innerHTML = html; sheet.hidden = false; scrim.hidden = false; sheet.scrollTop = 0; }
  function closeSheet() { runCleanup(); sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = ''; }
  scrim.onclick = closeSheet;
  var toastTimer;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600); }

  function confirmSheet(title, body, okLabel, onOk) {
    openSheet('<h3>' + title + '</h3><p>' + body + '</p><div class="actions"><button class="btn ghost" id="cNo">Cancel</button><button class="btn danger" id="cYes">' + okLabel + '</button></div>');
    $('#cNo').onclick = closeSheet;
    $('#cYes').onclick = function () { closeSheet(); onOk(); };
  }

  // ---------- bill photos ----------
  var photoTarget = null; // receives the next photo delivered by the Android shell
  function dropPhotos(list) { if (native) (list || []).forEach(function (p) { native.deletePhoto(p); }); }
  window.onPhotoAdded = function (name) {
    if (!name) { toast('Could not add the photo'); return; }
    if (photoTarget) photoTarget(name); else dropPhotos([name]);
  };
  // Thumbnails + Camera/Gallery buttons inside a form. Nothing is permanent until commit().
  function photoEditor(box, initial) {
    var photos = (initial || []).slice(), added = [], removed = [];
    function paint() {
      box.innerHTML = photos.map(function (p, i) { return '<img class="ph" data-i="' + i + '" src="bills/' + esc(p) + '" alt="bill">'; }).join('') +
        (native ? '<button type="button" class="add" data-src="camera">📷 Camera</button><button type="button" class="add" data-src="gallery">🖼 Gallery</button>'
                : '<span class="note" style="margin:0">Photos can be attached in the Android app.</span>');
      Array.prototype.forEach.call(box.querySelectorAll('.ph'), function (img) {
        img.onclick = function () {
          var p = photos[+img.dataset.i];
          openViewer(p, function () {
            photos.splice(photos.indexOf(p), 1);
            if (added.indexOf(p) >= 0) { added.splice(added.indexOf(p), 1); dropPhotos([p]); } else removed.push(p);
            paint();
          });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('.add'), function (b) {
        b.onclick = function () {
          photoTarget = function (name) { photos.push(name); added.push(name); paint(); };
          native.addPhoto(b.dataset.src);
        };
      });
    }
    paint();
    sheetCleanup = function () { photoTarget = null; dropPhotos(added); }; // form dismissed: discard new photos
    return {
      list: function () { return photos.slice(); },
      commit: function () { sheetCleanup = null; photoTarget = null; dropPhotos(removed); }
    };
  }
  var viewer = $('#viewer');
  function openViewer(name, onRemove) {
    $('#viewerImg').innerHTML = '<img src="bills/' + esc(name) + '" alt="bill">';
    $('#viewerRemove').hidden = !onRemove;
    $('#viewerRemove').onclick = function () { closeViewer(); onRemove(); };
    viewer.hidden = false;
  }
  function closeViewer() { viewer.hidden = true; $('#viewerImg').innerHTML = ''; }
  $('#viewerClose').onclick = closeViewer;

  function addSheet() {
    openSheet('<h3>Add</h3><div class="menu card">' + mi('aFill', '⛽ Fuel fill-up', 'Odometer, litres and amount') +
      mi('aToll', 'Toll', '') + mi('aEmi', 'EMI', '') + mi('aOther', 'Consumables / other', 'Service, repairs, accessories…') + '</div>');
    $('#aFill').onclick = function () { fillSheet(null); };
    $('#aToll').onclick = function () { expenseSheet(null, 'toll'); };
    $('#aEmi').onclick = function () { expenseSheet(null, 'emi'); };
    $('#aOther').onclick = function () { expenseSheet(null, 'other'); };
  }

  function fillSheet(id) {
    var f = id ? veh.fills.filter(function (x) { return x.id === id; })[0] : null;
    var last = data.rows[data.rows.length - 1];
    var premium = f ? !!f.premium : (last ? last.premium : false);
    openSheet('<h3>' + (f ? 'Edit fill-up' : 'New fill-up') + '</h3>' +
      '<div class="seg" id="fFuel"><button data-p="0">Regular (92–93)</button><button data-p="1">95 octane</button></div>' +
      '<div class="grid2"><label class="f"><span>Date</span><input id="fDate" type="date" value="' + (f ? f.date : today()) + '"></label>' +
      '<label class="f"><span>Odometer (km)</span><input id="fOdo" type="number" inputmode="numeric" value="' + (f ? f.odo : '') + '" placeholder="' + (last ? '> ' + data.totals.odoNow : '') + '"></label></div>' +
      '<div class="grid3"><label class="f"><span>Amount (₹)</span><input id="fCost" type="number" inputmode="decimal" value="' + (f ? f.cost : '') + '"></label>' +
      '<label class="f"><span>Price / L (₹)</span><input id="fPrice" type="number" inputmode="decimal" value="' + (f && f.price ? f.price : '') + '"></label>' +
      '<label class="f"><span>Litres</span><input id="fLitres" type="number" inputmode="decimal" value="' + (f ? f.litres : '') + '"></label></div>' +
      '<p class="note" style="margin:-4px 0 12px">Enter any two of amount, price and litres – the third is worked out.</p>' +
      '<label class="f" style="margin-bottom:4px"><span>Fuel bill photos</span></label><div class="photos" id="fPh"></div>' +
      '<label class="f"><span>Note (optional)</span><input id="fNote" type="text" value="' + esc(f ? f.note : '') + '"></label>' +
      '<p class="err" id="fErr"></p>' +
      '<div class="actions">' + (f ? '<button class="btn danger" id="fDel">Delete</button>' : '<button class="btn ghost" id="fCancel">Cancel</button>') +
      '<button class="btn primary" id="fSave">Save</button></div>');

    var ed = photoEditor($('#fPh'), f ? f.photos : null);
    function paintFuel() {
      Array.prototype.forEach.call(document.querySelectorAll('#fFuel button'), function (b) {
        var on = (b.dataset.p === '1') === premium;
        b.className = on ? (premium ? 'on prem' : 'on') : '';
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('#fFuel button'), function (b) { b.onclick = function () { premium = b.dataset.p === '1'; paintFuel(); }; });
    paintFuel();

    // Keep amount / price / litres consistent: the two most recently typed win.
    var els = { cost: $('#fCost'), price: $('#fPrice'), litres: $('#fLitres') };
    var touched = f ? ['cost', 'litres'] : [];
    Object.keys(els).forEach(function (k) {
      els[k].addEventListener('input', function () {
        touched = [k].concat(touched.filter(function (x) { return x !== k; })).slice(0, 2);
        if (touched.length < 2) return;
        var third = ['cost', 'price', 'litres'].filter(function (x) { return touched.indexOf(x) < 0; })[0];
        var c = parseFloat(els.cost.value), p = parseFloat(els.price.value), l = parseFloat(els.litres.value), v = null;
        if (third === 'litres' && c > 0 && p > 0) v = c / p;
        if (third === 'price' && c > 0 && l > 0) v = c / l;
        if (third === 'cost' && p > 0 && l > 0) v = p * l;
        if (v != null) els[third].value = v.toFixed(2);
      });
    });

    if (f) $('#fDel').onclick = function () {
      confirmSheet('Delete this fill-up?', fdate(f.date) + ' · ' + rs(f.cost) + ' · odometer ' + n(f.odo), 'Delete', function () {
        dropPhotos(f.photos); veh.fills = veh.fills.filter(function (x) { return x.id !== id; }); commit(); toast('Fill-up deleted');
      });
    }; else $('#fCancel').onclick = closeSheet;

    $('#fSave').onclick = function () {
      var odo = parseFloat($('#fOdo').value), cost = parseFloat(els.cost.value), litres = parseFloat(els.litres.value), price = parseFloat(els.price.value), date = $('#fDate').value;
      var err = !date ? 'Pick a date.' : !(odo >= 0) ? 'Enter the odometer reading.' : !(cost > 0) ? 'Enter the amount paid.' : !(litres > 0) ? 'Enter litres (or the price per litre).' : '';
      if (!err && veh.fills.some(function (x) { return x.id !== id && x.odo === odo; })) err = 'There is already a fill-up at this odometer reading.';
      if (err) { $('#fErr').textContent = err; return; }
      var rec = { id: id || uid('f'), date: date, odo: odo, litres: litres, cost: cost, price: price > 0 ? price : +(cost / litres).toFixed(2), premium: premium, note: $('#fNote').value.trim(), photos: ed.list() };
      ed.commit();
      if (f) veh.fills[veh.fills.indexOf(f)] = rec; else veh.fills.push(rec);
      closeSheet(); commit(); toast('Fill-up saved');
    };
  }

  function expenseSheet(id, type) {
    var e = id ? veh.expenses.filter(function (x) { return x.id === id; })[0] : null;
    type = e ? e.type : type;
    openSheet('<h3>' + (e ? 'Edit' : 'New') + ' expense</h3>' +
      '<label class="f"><span>Type</span><select id="eType">' + Object.keys(TYPE_LABEL).map(function (k) { return opt(k, TYPE_LABEL[k], type); }).join('') + '</select></label>' +
      '<div class="grid2"><label class="f"><span>Date</span><input id="eDate" type="date" value="' + (e ? e.date : today()) + '"></label>' +
      '<label class="f"><span>Amount (₹)</span><input id="eAmt" type="number" inputmode="decimal" value="' + (e ? e.amount : '') + '"></label></div>' +
      '<label class="f" style="margin-bottom:4px"><span>Bill photos (service bill, receipt…)</span></label><div class="photos" id="ePh"></div>' +
      '<label class="f"><span>Note (optional)</span><input id="eNote" type="text" value="' + esc(e ? e.note : '') + '"></label>' +
      '<p class="err" id="eErr"></p>' +
      '<div class="actions">' + (e ? '<button class="btn danger" id="eDel">Delete</button>' : '<button class="btn ghost" id="eCancel">Cancel</button>') +
      '<button class="btn primary" id="eSave">Save</button></div>');
    var ed = photoEditor($('#ePh'), e ? e.photos : null);
    if (e) $('#eDel').onclick = function () {
      confirmSheet('Delete this expense?', TYPE_LABEL[e.type] + ' · ' + fdate(e.date) + ' · ' + rs(e.amount), 'Delete', function () {
        dropPhotos(e.photos); veh.expenses = veh.expenses.filter(function (x) { return x.id !== id; }); commit(); toast('Expense deleted');
      });
    }; else $('#eCancel').onclick = closeSheet;
    $('#eSave').onclick = function () {
      var amt = parseFloat($('#eAmt').value), date = $('#eDate').value;
      if (!date || !(amt > 0)) { $('#eErr').textContent = 'Enter a date and an amount.'; return; }
      var rec = { id: id || uid('e'), date: date, type: $('#eType').value, amount: amt, note: $('#eNote').value.trim(), photos: ed.list() };
      ed.commit();
      if (e) veh.expenses[veh.expenses.indexOf(e)] = rec; else veh.expenses.push(rec);
      closeSheet(); logKind = 'exp'; commit(); toast('Expense saved');
    };
  }

  function odoSheet() {
    var lastOdo = data.rows.length ? data.rows[data.rows.length - 1].odo : 0;
    openSheet('<h3>Current odometer</h3><p class="note" style="margin:0 0 12px">Used to work out the distance and mileage of the tank you are on now.</p>' +
      '<label class="f"><span>Odometer (km)</span><input id="oVal" type="number" inputmode="numeric" value="' + data.totals.odoNow + '"></label><p class="err" id="oErr"></p>' +
      '<div class="actions"><button class="btn ghost" id="oCancel">Cancel</button><button class="btn primary" id="oSave">Save</button></div>');
    $('#oCancel').onclick = closeSheet;
    $('#oSave').onclick = function () {
      var v = parseFloat($('#oVal').value);
      if (!(v >= lastOdo)) { $('#oErr').textContent = 'Must be at least ' + n(lastOdo) + ' km (your last fill-up).'; return; }
      veh.currentOdo = v; closeSheet(); commit(); toast('Odometer updated');
    };
  }

  function switchVehicle(id) { state.activeId = id; tripForm = null; tab = tab === 'more' ? 'home' : tab; commit(); view.scrollTop = 0; }

  // Tap on the header: choose which vehicle to show.
  function vehiclesSheet() {
    openSheet('<h3>Vehicles</h3><div class="menu card">' + state.vehicles.map(function (v) {
      var c = Calc.compute(v).totals;
      return '<button data-veh="' + esc(v.id) + '"><span>' + vehIcon(v) + ' ' + esc(v.name) + (v.id === veh.id ? ' ✓' : '') +
        '<small>' + (v.fills.length ? n(c.odoNow) + ' km · ' + n(c.avgKmpl, 1) + ' km/l' : 'No fill-ups yet') + '</small></span></button>'; }).join('') +
      mi('vsAdd', '＋ Add a car or motorcycle', '') + '</div>');
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-veh]'), function (b) { b.onclick = function () { closeSheet(); switchVehicle(b.dataset.veh); }; });
    $('#vsAdd').onclick = function () { vehicleSheet(null); };
  }

  // Add or edit a vehicle.
  function vehicleSheet(id) {
    var v = id ? state.vehicles.filter(function (x) { return x.id === id; })[0] : null;
    var type = v ? (v.type || 'car') : 'car';
    openSheet('<h3>' + (v ? 'Edit vehicle' : 'Add vehicle') + '</h3>' +
      '<div class="seg" id="vType"><button data-t="car">🚗 Car</button><button data-t="motorcycle">🏍️ Motorcycle</button></div>' +
      '<label class="f"><span>Name</span><input id="vName" type="text" placeholder="e.g. Royal Enfield Classic 350" value="' + esc(v ? v.name : '') + '"></label>' +
      '<label class="f" style="margin-bottom:4px"><span>Photo (optional)</span></label><div class="photos" id="vPh"></div>' +
      '<p class="err" id="vErr"></p>' +
      '<div class="actions">' + (v && state.vehicles.length > 1 ? '<button class="btn danger" id="vDel">Delete</button>' : '<button class="btn ghost" id="vCancel">Cancel</button>') +
      '<button class="btn primary" id="vSave">Save</button></div>');
    var ed = photoEditor($('#vPh'), v && v.photo ? [v.photo] : null);
    function paintType() { Array.prototype.forEach.call(document.querySelectorAll('#vType button'), function (b) { b.className = b.dataset.t === type ? 'on' : ''; }); }
    Array.prototype.forEach.call(document.querySelectorAll('#vType button'), function (b) { b.onclick = function () { type = b.dataset.t; paintType(); }; });
    paintType();

    if ($('#vCancel')) $('#vCancel').onclick = closeSheet;
    if ($('#vDel')) $('#vDel').onclick = function () {
      confirmSheet('Delete ' + esc(v.name) + '?', 'Its ' + describe(v) + ' and bill photos will be removed from the app. Other vehicles are not affected.', 'Delete vehicle', function () {
        v.fills.concat(v.expenses).forEach(function (x) { dropPhotos(x.photos); });
        if (v.photo) dropPhotos([v.photo]);
        state.vehicles = state.vehicles.filter(function (x) { return x.id !== id; });
        if (state.activeId === id) state.activeId = state.vehicles[0].id;
        tripForm = null; commit(); toast('Vehicle deleted');
      });
    };
    $('#vSave').onclick = function () {
      var name = $('#vName').value.trim();
      if (!name) { $('#vErr').textContent = 'Give the vehicle a name.'; return; }
      var photos = ed.list(), photo = photos.length ? photos[photos.length - 1] : null; // newest photo wins
      ed.commit();
      dropPhotos(photos.slice(0, -1));
      if (v) { v.name = name; v.type = type; v.photo = photo; closeSheet(); commit(); toast('Vehicle saved'); }
      else {
        var nv = { id: uid('v'), name: name, type: type, photo: photo, stockPhoto: null, currentOdo: null, fills: [], expenses: [] };
        state.vehicles.push(nv); closeSheet(); switchVehicle(nv.id); toast('Vehicle added');
      }
    };
  }

  function pickMonthSheet() {
    openSheet('<h3>Print which month?</h3><div class="menu card">' + data.monthly.slice().reverse().map(function (m) {
      return '<button data-pm="' + m.key + '"><span>' + fmonth(m.key) + '<small>' + rs(m.total) + ' · ' + n(m.km) + ' km</small></span></button>'; }).join('') + '</div>');
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-pm]'), function (b) { b.onclick = function () { closeSheet(); showReport('month', b.dataset.pm); }; });
  }

  // ---------- printable report ----------
  function table(head, rows, leftCols) {
    var cls = function (i) { return i < (leftCols || 1) ? ' class="l"' : ''; };
    return '<div class="scroll"><table><thead><tr>' + head.map(function (h, i) { return '<th' + cls(i) + '>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (r.cls ? ' class="' + r.cls + '"' : '') + '>' + r.cells.map(function (c, i) { return '<td' + cls(i) + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function fillsTable(rows) {
    return table(['Date', 'Fuel', 'Odometer', 'Km', 'Litres', '₹ Cost', '₹ / L', 'KMPL', 'Tolls', '₹ / km'], rows.map(function (r) {
      return { cls: r.premium ? 'prem' : '', cells: [fdate(r.date), fuelName(r.premium), n(r.odo), n(r.km), n(r.litres, 2), n(r.cost), n(r.price, 2), n(r.kmpl, 1), r.tolls ? n(r.tolls) : '', n(r.cpk, 2)] };
    }), 2);
  }
  function expTable(list) {
    return table(['Date', 'Type', 'Note', '₹ Amount'], list.map(function (e) { return { cells: [fdate(e.date), TYPE_LABEL[e.type], esc(e.note || ''), n(e.amount)] }; }), 3);
  }
  function monthlyTable() {
    var t = data.totals;
    var rows = data.monthly.map(function (m) {
      return { cells: [fmonth(m.key), m.fills, n(m.km), n(m.litres, 1), n(m.kmpl, 1), n(m.fuel), n(m.tolls), n(m.emi), n(m.other), n(m.total)] };
    });
    rows.push({ cls: 'tot', cells: ['Total', t.fills, n(t.distance), n(t.litres, 1), n(t.avgKmpl, 1), n(t.fuelCost), n(t.tolls), n(t.emi), n(t.other), n(t.totalCost)] });
    return table(['Month', 'Fills', 'Km', 'Litres', 'KMPL', '₹ Fuel', '₹ Tolls', '₹ EMI', '₹ Other', '₹ Total'], rows);
  }
  function sumBlock(pairs) { return '<div class="sum">' + pairs.map(function (p) { return '<div><span>' + p[0] + '</span><b>' + p[1] + '</b></div>'; }).join('') + '</div>'; }

  var reportTitle = 'MilageTracker';
  function showReport(kind, key) {
    var t = data.totals, html, name = esc(veh.name || 'MilageTracker');
    var meta = '<div class="meta">Printed ' + fdate(today()) + ' · Odometer ' + n(t.odoNow) + ' km · Orange rows = 95 octane fuel</div>';
    if (kind === 'month') {
      var m = data.monthly.filter(function (x) { return x.key === key; })[0];
      var fills = data.rows.filter(function (r) { return r.date.slice(0, 7) === key; });
      var exps = data.expenses.filter(function (e) { return e.date.slice(0, 7) === key; });
      reportTitle = 'MilageTracker ' + fmonth(key);
      html = '<h1>' + name + ' – ' + fmonth(key) + '</h1>' + meta +
        sumBlock([['Distance', n(m.km) + ' km'], ['Mileage', n(m.kmpl, 1) + ' km/l'], ['Fuel', n(m.litres, 2) + ' L'], ['Fuel cost', rs(m.fuel)],
          ['Tolls', rs(m.tolls)], ['EMI', rs(m.emi)], ['Consumables / other', rs(m.other)], ['Month total', rs(m.total)]]) +
        (fills.length ? '<h2>Fill-ups</h2>' + fillsTable(fills) : '') + (exps.length ? '<h2>Tolls, EMI & other</h2>' + expTable(exps) : '');
    } else {
      reportTitle = 'MilageTracker ' + (kind === 'full' ? 'full report' : 'monthly summary');
      html = '<h1>' + name + ' – MilageTracker</h1>' + meta + '<h2>Summary</h2>' +
        sumBlock([['Average mileage', n(t.avgKmpl, 1) + ' km/l'], ['Fuel cost per km', rs(t.fuelCpk, 2)], ['Total fuel', n(t.litres, 2) + ' L'], ['Total cost of fuel', rs(t.fuelCost)],
          ['Total toll paid', rs(t.tolls)], ['Total EMI cost', rs(t.emi)], ['Other miscellaneous cost', rs(t.other)], ['Total cost so far', rs(t.totalCost)],
          ['Distance travelled (odometer)', n(t.odoNow) + ' km'], ['Overall cost per km', rs(t.overallCpk, 2)],
          ['Regular fuel mileage', n(data.regular.kmpl, 1) + ' km/l'], ['95 octane mileage', n(data.premium.kmpl, 1) + ' km/l']]) +
        '<h2>Monthly</h2>' + monthlyTable() +
        (kind === 'full' ? '<h2>Fill-ups</h2>' + fillsTable(data.rows) + '<h2>Tolls, EMI & other</h2>' + expTable(data.expenses) : '');
    }
    $('#printArea').innerHTML = html;
    $('#printWrap').hidden = false;
    $('#printWrap').scrollTop = 0;
  }
  function closeReport() { $('#printWrap').hidden = true; $('#printArea').innerHTML = ''; }
  $('#printClose').onclick = closeReport;
  $('#printGo').onclick = function () { if (native) native.print(reportTitle); else window.print(); };
  $('#printBtn').onclick = function () { showReport('full'); };

  // ---------- export / import ----------
  function csv(rows) {
    return rows.map(function (r) { return r.map(function (c) { c = c == null ? '' : String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\r\n') + '\r\n';
  }
  function r2(v) { return v == null ? '' : Math.round(v * 100) / 100; }
  function fillsCsv() {
    return csv([['Date', 'Fuel', 'Odometer', 'Kilometer', 'Litres', 'Total Cost', 'Per Liter Cost', 'KMPL', 'Tolls', 'Cost per Kilometer', 'Note']].concat(
      data.rows.map(function (r) { return [r.date, fuelName(r.premium), r.odo, r.km == null ? '' : r.km, r.litres, r.cost, r2(r.price), r2(r.kmpl), r.tolls || '', r2(r.cpk), r.note]; })));
  }
  function expensesCsv() {
    return csv([['Date', 'Type', 'Amount', 'Note']].concat(data.expenses.map(function (e) { return [e.date, TYPE_LABEL[e.type], e.amount, e.note || '']; })));
  }
  function saveFile(name, mime, content) {
    if (native) { native.saveFile(name, mime, content); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime })); a.download = name; a.click();
  }
  function pickFile() {
    if (native) { native.pickFile(); return; }
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = function () { var fr = new FileReader(); fr.onload = function () { window.onFilePicked(fr.result); }; fr.readAsText(inp.files[0]); };
    inp.click();
  }
  // Called by the Android shell (or the browser fallback) with the chosen backup file's text.
  window.onFilePicked = function (text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (!validState(parsed)) { toast('That file is not a MilageTracker backup'); return; }
    confirmSheet('Restore this backup?', 'It has ' + describe(parsed) + ', and will replace the ' + describe(state) + ' now in the app.', 'Replace', function () {
        adopt(parsed); toast('Backup restored');
      });
  };
  // Replace the app's data with a restored copy (from a backup or the cloud file).
  function adopt(parsed) {
    state = migrate(parsed);
    tripForm = null; applyTheme(); commit();
  }

  // ---------- cloud file (Google Drive via the Android file picker) ----------
  function ftime(ms) { return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function cloudCardHtml() {
    if (!native) return '';
    var body;
    if (!cloud.connected) {
      body = (cloud.error ? '<div class="cloud-state bad"><i></i><div><b>Not connected</b><small>' + esc(cloud.error) + '</small></div></div>' : '') +
        '<p class="note" style="margin:0 0 6px">Sign in with Google to keep your log and bill photos in a “MilageTracker” folder in your Google Drive. It syncs after every change.</p>' +
        '<div class="menu">' + mi('cOn', 'Connect Google Drive', 'Sign in with your Google account') + '</div>';
    } else {
      var bad = !!cloud.error;
      body = '<div class="cloud-state ' + (bad ? 'bad' : 'ok') + '"><i></i><div><b>Google Drive' + (cloud.account ? ' · ' + esc(cloud.account) : '') + '</b><small>' +
        (cloud.busy ? 'Syncing…' : bad ? esc(cloud.error) : cloud.lastSync ? 'Last synced ' + ftime(cloud.lastSync) : 'Not synced yet') + '</small></div></div>' +
        '<div class="menu">' + mi('cSync', 'Sync now', '') + (bad ? mi('cOn', 'Sign in again', '') : '') +
        mi('cRestore', 'Load data from Drive', 'Replaces the data in the app') +
        mi('cOff', 'Disconnect', 'Files already in Drive are kept') + '</div>';
    }
    return '<div class="card"><h2>Cloud storage</h2>' + body + '</div>';
  }
  function bindCloudCard() {
    if (!native) return;
    var on = function (id, fn) { var el = $('#' + id); if (el) el.onclick = fn; };
    on('cOn', function () { native.cloudConnect(); });
    on('cSync', function () { native.cloudSyncNow(); });
    on('cRestore', function () { native.cloudRead(); });
    on('cOff', function () { native.cloudDisconnect(); });
  }
  // ---------- app updates (latest release on GitHub) ----------
  var upd = { state: 'idle' };
  function updateCardHtml() {
    if (!native || !native.appVersion) return '';
    var ver = native.appVersion(), u = upd, row;
    var mb = u.size ? (u.size / 1048576).toFixed(1) + ' MB ' : '';
    if (u.state === 'available') row = mi('uInstall', 'Update to version ' + esc(u.latest), 'Downloads ' + mb + 'from GitHub and installs it. Your data is kept.');
    else if (u.state === 'checking') row = mi('uBusy', 'Checking for updates…', '');
    else if (u.state === 'downloading') row = mi('uBusy', 'Downloading version ' + esc(u.latest) + '…', (u.percent || 0) + '%');
    else if (u.state === 'installing') row = mi('uBusy', 'Installing version ' + esc(u.latest) + '…', 'Confirm the update when Android asks');
    else row = mi('uCheck', 'Check for updates', u.state === 'none' ? 'You have the latest version' : u.state === 'error' ? esc(u.error) : 'Looks for a newer version on GitHub');
    return '<div class="card" id="updCard"><h2>App <small>version ' + esc(ver) + '</small></h2><div class="menu">' + row + '</div></div>';
  }
  function bindUpdateCard() {
    if (!native || !native.appVersion) return;
    var c = $('#uCheck'), i = $('#uInstall');
    if (c) c.onclick = function () { native.updateCheck(); };
    if (i) i.onclick = function () { native.updateInstall(); };
  }
  window.onUpdateStatus = function (s) {
    upd = s;
    var el = $('#updCard');
    if (el) { el.outerHTML = updateCardHtml(); bindUpdateCard(); }
  };

  window.onPhotosChanged = function () { if (sheet.hidden) render(); };
  window.onCloudStatus = function (s) { cloud = s; if (tab === 'more' && sheet.hidden) render(); };
  // Text of the connected cloud file arrived (after connecting to an existing file, or "Load data").
  window.onCloudData = function (text) {
    readCloud();
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (!validState(parsed)) {
      native.cloudSyncNow(); toast('No usable log in Drive yet – uploading this phone’s data');
      return;
    }
    openSheet('<h3>Log found in Drive</h3><p>Drive has ' + describe(parsed) + '. This phone has ' + describe(state) + '. Which should be kept?</p>' +
      '<div class="menu card">' + mi('kCloud', 'Use the Drive data', 'Replaces what is in the app') + mi('kPhone', 'Keep this phone’s data', 'Overwrites the copy in Drive') + '</div>');
    $('#kCloud').onclick = function () { closeSheet(); adopt(parsed); toast('Loaded from Drive'); };
    $('#kPhone').onclick = function () { closeSheet(); native.cloudSyncNow(); if (tab === 'more') render(); };
  };

  window.onFileSaved = function (ok) { toast(ok ? 'File saved' : 'Could not save the file'); };

  // Android back button: close whatever is open first. Returns true if handled.
  window.handleBack = function () {
    if (!viewer.hidden) { closeViewer(); return true; }
    if (!$('#printWrap').hidden) { closeReport(); return true; }
    if (!sheet.hidden) { closeSheet(); return true; }
    if (tab !== 'home') { tab = 'home'; render(); view.scrollTop = 0; return true; }
    return false;
  };

  // ---------- wiring ----------
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.onclick = function () { tab = b.dataset.tab; render(); view.scrollTop = 0; };
  });
  $('#fab').onclick = addSheet;
  $('#vehBtn').onclick = vehiclesSheet;
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (sheet.hidden && (tab === 'home' || tab === 'monthly')) render(); }, 200); });

  // Optional deep link (index.html#monthly, #report …) – handy for testing in a desktop browser.
  var hash = location.hash.slice(1);
  if (['home', 'log', 'monthly', 'trip', 'more'].indexOf(hash) >= 0) tab = hash;
  refresh();
  if (hash === 'report') showReport('full');
})();
