(function () {
  'use strict';

  var DATA = readData();
  var ALL = 'all';

  function readData() {
    var el = document.getElementById('report-data');
    if (!el) return { managers: {}, lines: {}, lineManagers: {} };
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error('[report] не вдалося прочитати дані сторінки:', err);
      return { managers: {}, lines: {}, lineManagers: {} };
    }
  }

  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function select(group, active, attr) {
    each(group, function (el) {
      el.setAttribute('aria-selected', el.dataset[attr] === active ? 'true' : 'false');
    });
  }

  function initManagerTabs() {
    var tabs = document.querySelectorAll('[data-manager-tab]');
    var cards = document.querySelectorAll('[data-manager-card]');
    if (!tabs.length) return;

    function show(name) {
      each(cards, function (card) {
        card.hidden = card.dataset.managerCard !== name;
      });
      each(tabs, function (tab) {
        tab.setAttribute('aria-selected', tab.dataset.managerTab === name ? 'true' : 'false');
      });
    }

    each(tabs, function (tab) {
      tab.addEventListener('click', function () {
        show(tab.dataset.managerTab);
      });
    });
    show(tabs[0].dataset.managerTab);
  }


  var TREND_SERIES = [
    { key: 'sales', title: 'Угоди', color: '#3b6fb0', axis: 'left' },
    { key: 'success', title: 'Записи', color: '#2f7d58', axis: 'left' },
    { key: 'conversion', title: 'Конверсія', color: '#b5603a', axis: 'right', suffix: '%' },
    { key: 'score', title: 'Бал', color: '#8c5aa8', axis: 'right', scale: 10, decimals: 1 }
  ];

  var TH = 240, PL = 40, PR = 40, PT = 16, PB = 30;
  var AXIS_SIZE = 12, AXIS_FILL = '#667085', GRID_STROKE = '#e7ebf0';

  function niceMax(v) {
    if (!v || v <= 0) return 4;
    var step = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = Math.ceil(v / step) * step;
    if (n / v > 2) n = (Math.ceil((v * 2) / step) * step) / 2;
    return Math.max(4, n);
  }

  function fmtVal(sr, v) {
    if (v == null) return '—';
    return (sr.decimals ? v.toFixed(sr.decimals).replace('.', ',') : String(v)) + (sr.suffix || '');
  }

  function trendState(card) {
    if (!card.__trend) card.__trend = { hidden: {}, points: [], hover: null, note: '' };
    return card.__trend;
  }

  function axisText(x, y, value, anchor) {
    return '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" font-size="' + AXIS_SIZE + '" fill="' + AXIS_FILL + '">' + value + '</text>';
  }

  function drawTrend(card) {
    var svg = card.querySelector('[data-trend]');
    if (!svg) return;
    var st = trendState(card);
    var pts = st.points;
    var shown = TREND_SERIES.filter(function (sr) { return !st.hidden[sr.key]; });

    var TW = Math.max(320, Math.round(svg.getBoundingClientRect().width || 680));
    var PLOT_W = TW - PL - PR;
    var PLOT_H = TH - PT - PB;
    svg.setAttribute('viewBox', '0 0 ' + TW + ' ' + TH);
    svg.setAttribute('height', TH);

    if (!pts.length) {
      svg.innerHTML = axisText(TW / 2, TH / 2, 'За цей період даних немає', 'middle');
      each(card.querySelectorAll('[data-series-val]'), function (el) { el.textContent = '—'; });
      var empty = card.querySelector('[data-trend-note]');
      if (empty) empty.textContent = st.note;
      return;
    }

    var maxLeft = 0;
    for (var i = 0; i < pts.length; i += 1) {
      for (var q = 0; q < shown.length; q += 1) {
        if (shown[q].axis !== 'left') continue;
        var lv = pts[i][shown[q].key];
        if (lv != null && lv > maxLeft) maxLeft = lv;
      }
    }
    maxLeft = niceMax(maxLeft);

    var x = function (n) { return pts.length < 2 ? PL + PLOT_W / 2 : PL + (n * PLOT_W) / (pts.length - 1); };
    var yL = function (v) { return PT + PLOT_H - (v / maxLeft) * PLOT_H; };
    var yR = function (v) { return PT + PLOT_H - (v / 100) * PLOT_H; };

    var out = '';
    for (var t = 0; t <= 4; t += 1) {
      var frac = t / 4;
      var gy = PT + PLOT_H - frac * PLOT_H;
      out += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (PL + PLOT_W) + '" y2="' + gy + '" stroke="' + GRID_STROKE + '" stroke-width="1"/>';
      out += axisText(PL - 8, gy + 4, Math.round(maxLeft * frac), 'end');
      out += axisText(PL + PLOT_W + 8, gy + 4, Math.round(100 * frac) + '%', 'start');
    }

    var step = Math.max(1, Math.ceil(pts.length / 12));
    for (var k = 0; k < pts.length; k += 1) {
      if (k % step !== 0 && k !== pts.length - 1) continue;
      out += axisText(x(k).toFixed(1), TH - 9, pts[k].label, 'middle');
    }

    for (var sIdx = 0; sIdx < shown.length; sIdx += 1) {
      var sr = shown[sIdx];
      var d = '';
      var open = false;
      for (var a = 0; a < pts.length; a += 1) {
        var raw = pts[a][sr.key];
        if (raw == null) { open = false; continue; }
        var py = sr.axis === 'left' ? yL(raw) : yR(raw * (sr.scale || 1));
        d += (open ? 'L' : 'M') + x(a).toFixed(1) + ' ' + py.toFixed(1) + ' ';
        open = true;
      }
      if (d) out += '<path d="' + d.replace(/\s+$/, '') + '" fill="none" stroke="' + sr.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      if (pts.length <= 14) {
        for (var b = 0; b < pts.length; b += 1) {
          var rv = pts[b][sr.key];
          if (rv == null) continue;
          var cy = sr.axis === 'left' ? yL(rv) : yR(rv * (sr.scale || 1));
          out += '<circle cx="' + x(b).toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3" fill="#ffffff" stroke="' + sr.color + '" stroke-width="2"/>';
        }
      }
    }

    var at = st.hover == null ? pts.length - 1 : st.hover;
    out += '<line x1="' + x(at).toFixed(1) + '" y1="' + PT + '" x2="' + x(at).toFixed(1) + '" y2="' + (PT + PLOT_H) + '" stroke="#98a2b3" stroke-width="1" stroke-dasharray="3 3"/>';

    svg.innerHTML = out;

    each(card.querySelectorAll('[data-series-val]'), function (el) {
      var found = TREND_SERIES.filter(function (z) { return z.key === el.dataset.seriesVal; })[0];
      el.textContent = fmtVal(found, pts[at][found.key]);
    });
    var note = card.querySelector('[data-trend-note]');
    if (note) note.textContent = st.note + ' · ' + pts[at].label;
  }

  function initTrend(card) {
    var svg = card.querySelector('[data-trend]');
    if (!svg) return;
    var st = trendState(card);

    each(card.querySelectorAll('[data-series]'), function (btn) {
      btn.addEventListener('click', function () {
        st.hidden[btn.dataset.series] = !st.hidden[btn.dataset.series];
        btn.setAttribute('aria-selected', st.hidden[btn.dataset.series] ? 'false' : 'true');
        drawTrend(card);
      });
    });

    svg.addEventListener('mousemove', function (event) {
      if (!st.points.length) return;
      var box = svg.getBoundingClientRect();
      var rel = event.clientX - box.left;
      var plotW = Math.max(1, box.width - PL - PR);
      var idx = st.points.length < 2 ? 0 : Math.round(((rel - PL) / plotW) * (st.points.length - 1));
      idx = Math.max(0, Math.min(st.points.length - 1, idx));
      if (idx === st.hover) return;
      st.hover = idx;
      drawTrend(card);
    });
    svg.addEventListener('mouseleave', function () {
      st.hover = null;
      drawTrend(card);
    });
  }

  function applyMonth(card, month) {
    var buckets = DATA.managers[card.dataset.managerCard] || {};
    var bucket = buckets[month] || {};

    var totalCalls = 0;
    each(card.querySelectorAll('[data-cat]'), function (el) {
      totalCalls += bucket[el.dataset.cat] || 0;
    });
    each(card.querySelectorAll('[data-cat]'), function (el) {
      el.textContent = bucket[el.dataset.cat] || 0;
    });
    each(card.querySelectorAll('[data-cat-seg]'), function (el) {
      var part = bucket[el.dataset.catSeg] || 0;
      var share = totalCalls ? (part / totalCalls) * 100 : 0;
      el.style.width = share.toFixed(2) + '%';
      el.style.minWidth = part && share < 1 ? '3px' : '0';
    });
    each(card.querySelectorAll('[data-cat-share]'), function (el) {
      var part = bucket[el.dataset.catShare] || 0;
      el.textContent = totalCalls ? Math.round((part / totalCalls) * 100) + '% від усіх' : '';
    });

    var st = trendState(card);
    st.points = ((DATA.series || {})[card.dataset.managerCard] || {})[month] || [];
    st.hover = null;
    st.note = month === ALL ? 'по місяцях' : 'по днях';
    drawTrend(card);

    select(card.querySelectorAll('[data-month-tab]'), month, 'month');
  }

  function initMonthTabs() {
    each(document.querySelectorAll('[data-manager-card]'), function (card) {
      each(card.querySelectorAll('[data-month-tab]'), function (tab) {
        tab.addEventListener('click', function () {
          applyMonth(card, tab.dataset.month);
        });
      });
      initTrend(card);
      applyMonth(card, ALL);
    });
  }

  var METRICS = {
    conv: {
      get: function (b) {
        return b.conversion;
      },
      fmt: function (v) {
        return v + '%';
      },
      sub: function (b) {
        if (!b.reachable) return 'угод, які можна було взяти, не було';
        return 'записались ' + (b.success || 0) + ' з ' + b.reachable;
      },
      top: null,
    },
    score: {
      get: function (b) {
        return b.avgScore;
      },
      fmt: function (v) {
        return String(v);
      },
      sub: function (b) {
        return b.avgScore == null ? 'бал ще не рахувався' : 'з 10';
      },
      top: 10,
    },
    sales: {
      get: function (b) {
        return b.sales;
      },
      fmt: function (v) {
        return String(v);
      },
      sub: function (b) {
        return (b.calls || 0) + ' дзвінків усього';
      },
      top: null,
    },
  };

  function applyCompare(month) {
    Object.keys(METRICS).forEach(function (key) {
      var metric = METRICS[key];
      var rows = document.querySelectorAll('[data-cmp="' + key + '"]');
      if (!rows.length) return;

      var items = [];
      each(rows, function (row) {
        var bucket = (DATA.managers[row.dataset.manager] || {})[month] || {};
        items.push({ row: row, bucket: bucket, value: metric.get(bucket) });
      });

      var max = metric.top || items.reduce(function (n, x) {
        return Math.max(n, x.value || 0);
      }, 0);

      items.forEach(function (x) {
        var width = x.value == null || !max ? 0 : Math.max(2, (x.value / max) * 100);
        x.row.querySelector('[data-cmp-bar]').style.width = width.toFixed(1) + '%';
        x.row.querySelector('[data-cmp-val]').textContent = x.value == null ? '—' : metric.fmt(x.value);
        x.row.querySelector('[data-cmp-sub]').textContent = metric.sub(x.bucket);
      });
    });
    select(document.querySelectorAll('[data-compare-tab]'), month, 'compareTab');
  }

  function initCompare() {
    var tabs = document.querySelectorAll('[data-compare-tab]');
    if (!tabs.length) return;
    each(tabs, function (tab) {
      tab.addEventListener('click', function () {
        applyCompare(tab.dataset.compareTab);
      });
    });
    applyCompare(ALL);
  }

  function lineSummary(bucket) {
    var calls = bucket.calls || 0;
    if (!calls) return 'за цей місяць дзвінків не було';
    var parts = ['<b>' + calls + '</b> ' + plural(calls, 'дзвінок', 'дзвінки', 'дзвінків')];
    if (bucket.sales) parts.push('<b>' + bucket.sales + '</b> ' + plural(bucket.sales, 'угода', 'угоди', 'угод'));
    if (bucket.success) parts.push('<b>' + bucket.success + '</b> ' + plural(bucket.success, 'запис', 'записи', 'записів'));
    return parts.join(' · ');
  }

  function applyLines(month) {
    each(document.querySelectorAll('[data-line]'), function (card) {
      var bucket = (DATA.lines[card.dataset.line] || {})[month] || {};
      var incoming = bucket.incoming || 0;
      var outgoing = bucket.outgoing || 0;
      var known = incoming + outgoing;

      card.querySelector('[data-line-in]').textContent = incoming;
      card.querySelector('[data-line-out]').textContent = outgoing;
      card.querySelector('[data-line-sub]').innerHTML = lineSummary(bucket);
      card.querySelector('[data-line-bar-in]').style.width = known ? ((incoming / known) * 100).toFixed(1) + '%' : '0%';
      card.querySelector('[data-line-bar-out]').style.width = known ? ((outgoing / known) * 100).toFixed(1) + '%' : '0%';
    });
    each(document.querySelectorAll('[data-lm-field]'), function (cell) {
      var perManager = (DATA.lineManagers || {})[cell.dataset.lmLine] || {};
      var bucket = (perManager[cell.dataset.lmName] || {})[month] || {};
      cell.textContent = bucket[cell.dataset.lmField] || 0;
    });
    select(document.querySelectorAll('[data-line-tab]'), month, 'lineTab');
  }

  function initLines() {
    var tabs = document.querySelectorAll('[data-line-tab]');
    if (!document.querySelector('[data-line]')) return;
    each(tabs, function (tab) {
      tab.addEventListener('click', function () {
        applyLines(tab.dataset.lineTab);
      });
    });
    applyLines(ALL);
  }

  function ratio(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  function applyIntro(month) {
    var cards = document.querySelectorAll('[data-intro-card]');
    each(cards, function (card) {
      var byMonth = (DATA.intro || {})[card.dataset.introCard] || {};
      var b = byMonth[month] || {};
      var checked = b.checked || 0;

      card.querySelector('[data-intro-sub]').innerHTML = checked
        ? '<b>' + checked + '</b> ' + plural(checked, 'дзвінок', 'дзвінки', 'дзвінків') + ' на своєму номері'
        : 'за цей місяць дзвінків не було';

      each(card.querySelectorAll('[data-intro-bar]'), function (bar) {
        var field = bar.dataset.introBar === 'name' ? 'withName' : 'withCompany';
        var value = b[field] || 0;
        bar.style.width = ratio(value, checked) + '%';
      });
      each(card.querySelectorAll('[data-intro-pct]'), function (cell) {
        var field = cell.dataset.introPct === 'name' ? 'withName' : 'withCompany';
        var value = b[field] || 0;
        cell.textContent = checked ? value + ' з ' + checked + ' · ' + ratio(value, checked) + '%' : '—';
      });

      card.querySelector('[data-intro-dir]').textContent = checked
        ? 'імʼя: вхідні ' + (b.withNameIn || 0) + ' з ' + (b.checkedIn || 0) +
          ' · вихідні ' + (b.withNameOut || 0) + ' з ' + (b.checkedOut || 0)
        : '';
    });
    select(document.querySelectorAll('[data-intro-tab]'), month, 'introTab');
  }

  function initIntro() {
    if (!document.querySelector('[data-intro-card]')) return;
    each(document.querySelectorAll('[data-intro-tab]'), function (tab) {
      tab.addEventListener('click', function () {
        applyIntro(tab.dataset.introTab);
      });
    });
    applyIntro(ALL);
  }

  function initDeclineTabs() {
    var tabs = document.querySelectorAll('[data-decline-tab]');
    var rows = document.querySelectorAll('[data-decline-month]');
    if (!tabs.length) return;

    function show(month) {
      each(rows, function (row) {
        row.hidden = month !== ALL && row.dataset.declineMonth !== month;
      });
      select(tabs, month, 'declineTab');
    }

    each(tabs, function (tab) {
      tab.addEventListener('click', function () {
        show(tab.dataset.declineTab);
      });
    });
    show(ALL);
  }

  function initTips() {
    document.addEventListener('click', function (event) {
      each(document.querySelectorAll('[data-tip][open]'), function (tip) {
        if (!tip.contains(event.target)) tip.removeAttribute('open');
      });
    });
  }

  function initClips() {
    var players = document.querySelectorAll('[data-clip]');
    if (!players.length) return;

    var audio = new Audio();
    audio.preload = 'none';
    var current = null;

    function fmt(seconds) {
      if (!isFinite(seconds) || seconds < 0) seconds = 0;
      var m = Math.floor(seconds / 60);
      var s = Math.floor(seconds % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function paint(player, playing) {
      var icon = player.querySelector('[data-clip-icon]');
      if (icon) icon.textContent = playing ? '❚❚' : '▶';
      player.setAttribute('data-playing', playing ? 'true' : 'false');
    }

    function reset(player) {
      paint(player, false);
      var fill = player.querySelector('[data-clip-fill]');
      if (fill) fill.style.width = '0%';
      var time = player.querySelector('[data-clip-time]');
      if (time) time.textContent = player.dataset.clipLength || '0:00';
    }

    function stop() {
      audio.pause();
      if (current) reset(current);
      current = null;
    }

    function play(player) {
      if (current === player) {
        if (audio.paused) {
          audio.play().catch(fail);
          paint(player, true);
        } else {
          audio.pause();
          paint(player, false);
        }
        return;
      }
      stop();
      current = player;
      audio.src = player.dataset.clip;
      audio.currentTime = 0;
      paint(player, true);
      audio.play().catch(fail);
    }

    function fail(err) {
      console.error('[report] фрагмент не відтворився:', err);
      if (current) {
        var time = current.querySelector('[data-clip-time]');
        if (time) time.textContent = 'немає запису';
        reset(current);
        current = null;
      }
    }

    audio.addEventListener('timeupdate', function () {
      if (!current || !isFinite(audio.duration) || !audio.duration) return;
      var fill = current.querySelector('[data-clip-fill]');
      if (fill) fill.style.width = ((audio.currentTime / audio.duration) * 100).toFixed(1) + '%';
      var time = current.querySelector('[data-clip-time]');
      if (time) time.textContent = fmt(audio.duration - audio.currentTime);
    });
    audio.addEventListener('ended', function () {
      if (current) reset(current);
      current = null;
    });
    audio.addEventListener('error', fail);

    each(players, function (player) {
      var button = player.querySelector('[data-clip-play]');
      if (button) {
        button.addEventListener('click', function () {
          play(player);
        });
      }
      var track = player.querySelector('[data-clip-track]');
      if (track) {
        track.addEventListener('click', function (event) {
          if (current !== player || !isFinite(audio.duration) || !audio.duration) return;
          var box = track.getBoundingClientRect();
          var ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
          audio.currentTime = ratio * audio.duration;
        });
      }
    });
  }

  function boot() {
    initManagerTabs();
    initMonthTabs();
    initCompare();
    initLines();
    initIntro();
    initDeclineTabs();
    initTips();
    initClips();

    var resizeAt = null;
    window.addEventListener('resize', function () {
      if (resizeAt) clearTimeout(resizeAt);
      resizeAt = setTimeout(function () {
        each(document.querySelectorAll('[data-manager-card]'), drawTrend);
      }, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
