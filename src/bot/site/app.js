// Behaviour for the call report page. Shipped as-is (no build step) and served from assets/app.js.
// The page's own numbers arrive as JSON in #report-data, so this file stays static and cacheable
// across every report we ever publish.
(function () {
  'use strict';

  var DATA = readData();
  var ALL = 'all';

  function readData() {
    var el = document.getElementById('report-data');
    if (!el) return { managers: {}, categories: [] };
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error('[report] не вдалося прочитати дані сторінки:', err);
      return { managers: {}, categories: [] };
    }
  }

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function select(group, active, attr) {
    each(group, function (el) {
      el.setAttribute('aria-selected', el.dataset[attr] === active ? 'true' : 'false');
    });
  }

  // --- manager tabs --------------------------------------------------------------------------
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

  // --- month switch inside one manager card --------------------------------------------------
  function applyMonth(card, month) {
    var buckets = DATA.managers[card.dataset.managerCard] || {};
    var bucket = buckets[month] || {};

    each(card.querySelectorAll('[data-cat]'), function (el) {
      el.textContent = bucket[el.dataset.cat] || 0;
    });
    each(card.querySelectorAll('[data-month]'), function (el) {
      if (el.hasAttribute('data-month-tab')) return;
      var on = month !== ALL && el.dataset.month === month;
      el.classList.toggle('bg-blue-50', on);
    });
    select(card.querySelectorAll('[data-month-tab]'), month, 'month');
  }

  function initMonthTabs() {
    each(document.querySelectorAll('[data-manager-card]'), function (card) {
      each(card.querySelectorAll('[data-month-tab]'), function (tab) {
        tab.addEventListener('click', function () {
          applyMonth(card, tab.dataset.month);
        });
      });
      applyMonth(card, ALL);
    });
  }

  // --- manager comparison --------------------------------------------------------------------
  // Rows keep the order they were rendered in, on purpose: re-sorting them by value on every month
  // switch made the managers swap places under the reader, and a ranking you have to re-learn on
  // each click is worse than no ranking.
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

  // --- refusals table ------------------------------------------------------------------------
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

  // --- "i" popovers --------------------------------------------------------------------------
  function initTips() {
    document.addEventListener('click', function (event) {
      each(document.querySelectorAll('[data-tip][open]'), function (tip) {
        if (!tip.contains(event.target)) tip.removeAttribute('open');
      });
    });
  }

  // --- audio evidence ------------------------------------------------------------------------
  // One shared <audio>: starting a clip stops whatever was playing, so the page never talks over
  // itself. Clips are short cuts around the quoted line, served from audio/ next to this file.
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
    initDeclineTabs();
    initTips();
    initClips();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
