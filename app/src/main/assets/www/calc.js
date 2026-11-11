// Pure calculation logic (no DOM) so it can be unit-tested with Node.
// Mirrors the formulas of the original Google Sheet:
//   Kilometer  = next odometer - this odometer
//   KMPL       = Kilometer / Litres
//   Cost/km    = (fuel cost + tolls) / Kilometer
//   Total cost = fuel + tolls + EMI + other ; Overall cost/km = Total cost / odometer
var Calc = (function () {
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function div(a, b) { return b > 0 ? a / b : null; }

  function sortFills(fills) {
    return fills.slice().sort(function (a, b) {
      return (a.odo - b.odo) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    });
  }

  function compute(state) {
    var fills = sortFills(state.fills || []);
    var expenses = (state.expenses || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var lastOdo = fills.length ? fills[fills.length - 1].odo : 0;
    var odoNow = Math.max(num(state.currentOdo), lastOdo);

    var rows = fills.map(function (f, i) {
      var nextOdo = i + 1 < fills.length ? fills[i + 1].odo : (odoNow > f.odo ? odoNow : null);
      var km = nextOdo == null ? null : nextOdo - f.odo;
      return {
        id: f.id, date: f.date, odo: f.odo, litres: num(f.litres), cost: num(f.cost),
        price: f.price ? num(f.price) : div(num(f.cost), num(f.litres)),
        premium: !!f.premium, note: f.note || '', photos: f.photos || [], km: km, tolls: 0,
        open: i + 1 === fills.length // latest tank: distance still growing
      };
    });

    // Each toll belongs to the tank that was in use on that date (last fill on or before it).
    expenses.forEach(function (e) {
      if (e.type !== 'toll' || !rows.length) return;
      var idx = 0;
      for (var i = 0; i < rows.length; i++) if (rows[i].date <= e.date) idx = i;
      rows[idx].tolls += num(e.amount);
    });

    rows.forEach(function (r) {
      r.kmpl = r.km != null ? div(r.km, r.litres) : null;
      r.fuelCpk = r.km != null ? div(r.cost, r.km) : null;
      r.cpk = r.km != null ? div(r.cost + r.tolls, r.km) : null;
    });

    var sum = function (list, key) { return list.reduce(function (s, x) { return s + num(x[key]); }, 0); };
    var expSum = function (type) { return expenses.filter(function (e) { return e.type === type; }).reduce(function (s, e) { return s + num(e.amount); }, 0); };
    var done = rows.filter(function (r) { return r.km != null && r.km > 0; });

    var t = {
      fills: rows.length,
      litres: sum(rows, 'litres'),
      fuelCost: sum(rows, 'cost'),
      tolls: expSum('toll'), emi: expSum('emi'), other: expSum('other'),
      odoNow: odoNow,
      distance: rows.length ? odoNow - rows[0].odo : 0
    };
    t.totalCost = t.fuelCost + t.tolls + t.emi + t.other;
    var kmDone = sum(done, 'km'), litresDone = sum(done, 'litres'), costDone = sum(done, 'cost');
    t.avgKmpl = div(kmDone, litresDone);                         // true average: distance / fuel
    t.sheetAvgKmpl = mean(done.map(function (r) { return r.kmpl; })); // sheet style: average of per-fill KMPL
    t.fuelCpk = div(costDone, kmDone);
    t.runCpk = div(costDone + sum(done, 'tolls'), kmDone);      // fuel + tolls
    t.sheetCpk = mean(done.map(function (r) { return r.cpk; }));
    t.overallCpk = div(t.totalCost, odoNow);                     // sheet: total cost / odometer
    t.avgPrice = div(t.fuelCost, t.litres);
    var recent = done.slice(-5);
    t.recentKmpl = div(sum(recent, 'km'), sum(recent, 'litres'));
    t.lastKmpl = done.length ? done[done.length - 1].kmpl : null;

    function typeStats(premium) {
      var all = rows.filter(function (r) { return r.premium === premium; });
      var d = done.filter(function (r) { return r.premium === premium; });
      return {
        fills: all.length, litres: sum(all, 'litres'), cost: sum(all, 'cost'),
        avgPrice: div(sum(all, 'cost'), sum(all, 'litres')),
        lastPrice: all.length ? all[all.length - 1].price : null,
        km: sum(d, 'km'), kmpl: div(sum(d, 'km'), sum(d, 'litres')), cpk: div(sum(d, 'cost'), sum(d, 'km'))
      };
    }

    // Monthly roll-up. A tank's distance is counted in the month it was filled.
    var months = {};
    function m(key) {
      return months[key] || (months[key] = { key: key, fills: 0, litres: 0, fuel: 0, km: 0, kmLitres: 0, tolls: 0, emi: 0, other: 0 });
    }
    rows.forEach(function (r) {
      var x = m(r.date.slice(0, 7));
      x.fills++; x.litres += r.litres; x.fuel += r.cost;
      if (r.km != null && r.km > 0) { x.km += r.km; x.kmLitres += r.litres; }
    });
    expenses.forEach(function (e) {
      var x = m(e.date.slice(0, 7));
      if (e.type === 'toll') x.tolls += num(e.amount);
      else if (e.type === 'emi') x.emi += num(e.amount);
      else x.other += num(e.amount);
    });
    var monthly = Object.keys(months).sort().map(function (k) {
      var x = months[k];
      x.total = x.fuel + x.tolls + x.emi + x.other;
      x.kmpl = div(x.km, x.kmLitres);
      x.cpk = div(x.fuel + x.tolls, x.km);
      return x;
    });

    return { rows: rows, expenses: expenses, totals: t, regular: typeStats(false), premium: typeStats(true), monthly: monthly };
  }

  // Trip prediction: fuel needed = distance / mileage ; cost = fuel * price (+ tolls).
  function trip(distanceKm, kmpl, pricePerL, tolls) {
    if (!(distanceKm > 0) || !(kmpl > 0) || !(pricePerL > 0)) return null;
    var litres = distanceKm / kmpl, fuel = litres * pricePerL, total = fuel + num(tolls);
    return { litres: litres, fuelCost: fuel, total: total, perKm: total / distanceKm };
  }

  return { compute: compute, trip: trip, sortFills: sortFills };
})();
if (typeof module !== 'undefined') module.exports = Calc;
