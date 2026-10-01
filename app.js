/**
 * app.js
 * 界面交互与视图逻辑：视图切换、学习/复习会话、生词本、统计、吉祥物互动。
 * 所有数据读写均通过 dataService。
 */
(function () {
  "use strict";

  var ds = window.dataService;
  function $(id) { return document.getElementById(id); }

  // —— 第三方库能力探测（CDN 未加载时优雅降级，不影响主流程）——
  var hasConfetti = typeof window.confetti === "function";
  var CountUpCtor = (window.countUp && window.countUp.CountUp) || null;
  var CONFETTI_COLORS = ["#f43f5e", "#fb923c", "#facc15", "#34d399", "#60a5fa"];

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // 小爆发：答对时的即时正反馈
  function burstConfetti() {
    if (!hasConfetti || prefersReducedMotion()) return;
    try {
      window.confetti({
        particleCount: 42, spread: 62, startVelocity: 32, scalar: 0.85, ticks: 130,
        origin: { y: 0.72 }, colors: CONFETTI_COLORS
      });
    } catch (e) { /* 忽略 */ }
  }

  // 大庆祝：整轮学习/复习结束，两侧持续喷射约 0.9 秒
  function celebrate() {
    if (!hasConfetti || prefersReducedMotion()) return;
    try {
      window.confetti({
        particleCount: 90, spread: 100, startVelocity: 42,
        origin: { y: 0.6 }, colors: CONFETTI_COLORS
      });
      var end = Date.now() + 900;
      (function frame() {
        window.confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors: CONFETTI_COLORS });
        window.confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors: CONFETTI_COLORS });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    } catch (e) { /* 忽略 */ }
  }

  // 数字滚动：统计页数字「跳」到目标值
  function countTo(id, value) {
    var el = $(id);
    if (!el) return;
    if (!CountUpCtor || prefersReducedMotion()) { el.textContent = value; return; }
    try {
      var cu = new CountUpCtor(id, value, { duration: 1.1, separator: "," });
      if (!cu.error) { cu.start(); return; }
    } catch (e) { /* 落到直接赋值 */ }
    el.textContent = value;
  }

  // 重播一个 CSS 动画（先移除 class 并强制重排）
  function replay(el, cls) {
    if (!el || prefersReducedMotion()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  var session = null; // { mode, queue, index, correct, wrong }

  var TITLES = {
    today: ["今日", "开始今天的背单词吧"],
    study: ["学习", "练习与巩固"],
    notebook: ["生词本", "收藏的单词"],
    stats: ["统计", "学习记录与打卡"],
    shop: ["商城", "给咕噜换新装"]
  };

  // —— 工具 ——
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function dateKeyOffset(n) {
    var d = new Date(Date.now() - n * 86400000);
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // DaisyUI toast：往固定容器里插一条 alert，自动消失
  function toast(msg, type) {
    var wrap = $("toastWrap");
    if (!wrap) return;
    var el = document.createElement("div");
    var cls = "alert shadow-lg";
    if (type === "success") cls += " alert-success";
    else if (type === "error") cls += " alert-error";
    else cls += " alert-info";
    el.className = cls;
    var span = document.createElement("span");
    span.textContent = msg;
    el.appendChild(span);
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  // —— 朗读（Web Speech API，英文发音）——
  // 为降低 Chromium 首句延迟，做三件事：
  //  1) 固定一个离线(localService)英文音色，规避在线自然音/网络音色的网络延迟；
  //  2) 首次触摸页面即播一段无声朗读，把音频/语音服务提前拉起来（见启动处的 pointerdown）；
  //  3) cancel() 后紧跟 resume()，规避 Chromium 卡在暂停态导致下一句延迟/被丢弃。
  var synth = ("speechSynthesis" in window) ? window.speechSynthesis : null;
  var cachedVoices = [];
  var preferredVoice = null;

  function pickEnglishVoice(list) {
    var en = list.filter(function (v) { return /^en/i.test(v.lang); });
    var local = en.filter(function (v) { return v.localService; });
    var pool = local.length ? local : en;
    if (!pool.length) return null;
    function score(v) {
      var n = v.name.toLowerCase();
      var s = 0;
      if (/zira|aria|jenny|david|mark|samantha|michelle|george|guy|ava|emma|allison|susan|hazel/i.test(n)) s += 4;
      if (/united states|en-us/i.test(n + " " + v.lang)) s += 2;
      if (/female/i.test(n)) s += 1;
      return s;
    }
    pool.sort(function (a, b) { return score(b) - score(a); });
    return pool[0];
  }

  function refreshVoices() {
    if (!synth) return;
    var list = synth.getVoices();
    if (list && list.length) cachedVoices = list;
    preferredVoice = pickEnglishVoice(cachedVoices);
  }

  if (synth) {
    refreshVoices();
    if ("onvoiceschanged" in synth) synth.onvoiceschanged = refreshVoices;
  }

  function primeSpeech() {
    if (!synth) return;
    try {
      if (synth.speaking) return; // 有声音在播就不打断
      var u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.rate = 4;
      u.lang = "en-US";
      if (preferredVoice) u.voice = preferredVoice;
      synth.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  function makeUtterance(text) {
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    if (preferredVoice) u.voice = preferredVoice;
    return u;
  }

  function speak(text) {
    if (!synth) return;
    try {
      synth.cancel();
      synth.resume();
      synth.speak(makeUtterance(text));
    } catch (e) { /* 忽略不支持的情况 */ }
  }

  function speakThen(texts) {
    if (!synth) return;
    try {
      synth.cancel();
      synth.resume();
      speakNext(texts, 0);
    } catch (e) { /* 忽略不支持的情况 */ }
  }

  function speakNext(texts, i) {
    if (i >= texts.length) return;
    var u = makeUtterance(texts[i]);
    u.onend = function () { speakNext(texts, i + 1); };
    synth.speak(u);
  }

  // —— 吉祥物互动 ——
  var GROW_XP = 100; // 累计经验值满 100（升到 Lv.2），咕噜从小馒头长成大团子
  function grown() { return ds.getXp() >= GROW_XP; }

  // 商城时装目录（id 对应 SVG 符号 #gulu-outfit-<id>）
  var OUTFITS = [
    { id: "crown", name: "皇冠", price: 60 },
    { id: "hat", name: "草帽", price: 80 },
    { id: "scarf", name: "围巾", price: 90 },
    { id: "bow", name: "蝴蝶结", price: 100 },
    { id: "santa", name: "圣诞帽", price: 120 },
    { id: "ears", name: "兔耳朵", price: 150 }
  ];
  var COMBO_MILESTONES = [3, 5, 10, 15, 20];
  function comboBonus(combo) { return COMBO_MILESTONES.indexOf(combo) !== -1 ? 10 : 0; }
  // 按表情 + 成长形态返回符号 id（未长成时追加 -bun 后缀）
  function guluRef(mood) { return "#gulu-" + mood + (grown() ? "" : "-bun"); }

  function heroUse() { return document.querySelector("#mascotHero use"); }
  function feedbackUse() { return document.querySelector("#feedbackMascot use"); }

  // 把常驻吉祥物（头像/首页/导航/生词本/结算）统一刷成当前成长形态
  function renderMascotGrowth() {
    var targets = [
      ["#headerMascotUse", "idle"],
      ["#mascotHero use", "idle"],
      ['.nav-tab[data-view="today"] use', "idle"],
      ['.nav-tab[data-view="study"] use', "happy"],
      ['.nav-tab[data-view="notebook"] use', "heart"],
      ['.nav-tab[data-view="stats"] use', "celebrate"],
      ['.nav-tab[data-view="shop"] use', "happy"],
      ["#notebookMascotUse", "heart"],
      ["#doneMascotUse", "celebrate"],
      ["#feedbackMascot use", "idle"]
    ];
    targets.forEach(function (t) {
      var el = document.querySelector(t[0]);
      if (el) el.setAttribute("href", guluRef(t[1]));
    });
    applyOutfit();
  }

  // 更新首页气泡文字并弹出
  function sayBubble(msg) {
    var b = $("bubble");
    if (!b) return;
    b.textContent = msg;
    replay(b, "bubble-pop");
  }

  // 答题反馈区吉祥物切换表情
  function setMascotMood(happy) {
    var u = feedbackUse();
    if (!u) return;
    u.setAttribute("href", guluRef(happy ? "happy" : "sad"));
    replay($("feedbackMascot"), "mascot-pop");
  }

  function resetMascotMood() {
    var u = feedbackUse();
    if (u) u.setAttribute("href", guluRef("idle"));
  }

  // 待机小动作：首页吉祥物偶尔眨眼
  function startMascotIdle() {
    var u = heroUse();
    if (!u) return;
    setInterval(function () {
      u.setAttribute("href", guluRef("blink"));
      setTimeout(function () { u.setAttribute("href", guluRef("idle")); }, 150);
    }, 4600);
  }

  // 穿戴中的时装叠加到头像 + 首页英雄吉祥物上
  function applyOutfit() {
    var outfit = ds.getEquippedOutfit();
    var href = outfit ? "#gulu-outfit-" + outfit : "#gulu-outfit-none";
    var hero = $("heroOutfit");
    var header = $("headerOutfit");
    if (hero) hero.setAttribute("href", href);
    if (header) header.setAttribute("href", href);
  }

  // 连击徽章
  function updateCombo(hitMilestone) {
    var badge = $("comboBadge");
    if (!badge) return;
    var c = session ? session.combo : 0;
    if (c >= 2) {
      badge.classList.remove("hidden");
      badge.textContent = "🔥 x" + c;
      if (hitMilestone) replay(badge, "combo-pop");
    } else {
      badge.classList.add("hidden");
    }
  }

  // 飘字反馈（+XP / +金币）
  function showFloat(text, anchor) {
    var el = document.createElement("div");
    el.className = "xp-float";
    el.textContent = text;
    var r = anchor.getBoundingClientRect();
    el.style.left = (r.left + r.width / 2) + "px";
    el.style.top = r.top + "px";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 900);
  }

  // Web Audio 合成音效（无音频文件）
  var audioCtx = null;
  function playSfx(kind) {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      var t0 = audioCtx.currentTime;
      function tone(freq, start, dur, type, vol) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = type || "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0 + start);
        o.stop(t0 + start + dur + 0.03);
      }
      if (kind === "correct") { tone(880, 0, 0.12, "sine", 0.16); tone(1318.5, 0.09, 0.16, "sine", 0.14); }
      else if (kind === "wrong") { tone(160, 0, 0.24, "sawtooth", 0.10); tone(110, 0.02, 0.22, "sawtooth", 0.08); }
      else if (kind === "combo") { tone(1046.5, 0, 0.10, "sine", 0.15); tone(1318.5, 0.07, 0.10, "sine", 0.15); tone(1568, 0.14, 0.18, "sine", 0.15); }
      else if (kind === "levelup") { tone(523.25, 0, 0.12, "sine", 0.15); tone(659.25, 0.10, 0.12, "sine", 0.15); tone(784, 0.20, 0.12, "sine", 0.15); tone(1046.5, 0.30, 0.26, "sine", 0.16); }
      else if (kind === "coin") { tone(988, 0, 0.09, "square", 0.07); tone(1318.5, 0.08, 0.15, "square", 0.07); }
    } catch (e) { /* 忽略音频异常 */ }
  }

  // —— 视图切换 ——
  function switchView(name) {
    renderMascotGrowth();
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.add("hidden");
    });
    $("view-" + name).classList.remove("hidden");

    document.querySelectorAll(".nav-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.view === name);
    });

    $("viewTitle").textContent = TITLES[name][0];
    $("viewSubtitle").textContent = TITLES[name][1];
    $("headerStreak").textContent = ds.getStreak();
    $("headerCoins").textContent = ds.getCoins();
    $("headerLevel").textContent = "Lv." + ds.getLevel();

    if (name === "today") renderToday();
    if (name === "notebook") renderNotebook();
    if (name === "stats") renderStats();
    if (name === "study") renderStudyHome();
    if (name === "shop") renderShop();
  }

  // —— 今日 ——
  function renderToday() {
    var t = ds.getTodayStats();
    $("todayStreak").textContent = ds.getStreak();
    $("todayLearned").textContent = ds.getLearnedCount();
    $("todayMastered").textContent = ds.getMasteredCount();
    $("todayNewCount").textContent = t.newCount;
    $("todayTotal").textContent = ds.getTotal();
    $("todayTotalStudy").textContent = ds.getTotalStudyCount();
    $("newCountBadge").textContent = ds.getNewCount();
    $("reviewCountBadge").textContent = ds.getDueCount();
    renderCheckIn();
  }

  // 每日签到
  function renderCheckIn() {
    var state = ds.getCheckIn();
    var btn = $("checkInBtn");
    var label = $("checkInLabel");
    if (!btn) return;
    if (state.checkedToday) {
      btn.textContent = "今日已签到";
      btn.disabled = true;
      btn.classList.add("btn-disabled");
      label.textContent = "已连签 " + state.streak + " 天 · 明日再领 " + (10 + state.streak * 5) + " 金币";
    } else {
      var nextStreak = state.streak + 1;
      btn.textContent = "签到领奖";
      btn.disabled = false;
      btn.classList.remove("btn-disabled");
      label.textContent = "连签第 " + nextStreak + " 天可领 " + (10 + (nextStreak - 1) * 5) + " 金币 + 5 XP";
    }
  }

  // —— 学习会话 ——
  function startSession(mode) {
    var pool = mode === "learn" ? ds.getNewWords() : ds.getDueWords();
    if (pool.length === 0) {
      toast(mode === "learn" ? "没有待学习的新词了" : "没有需要复习的单词", "info");
      return;
    }
    primeSpeech(); // 进入会话前再预热一次，拉近与首次发音的间隔
    shuffle(pool);
    var queue = pool.slice(0, Math.min(10, pool.length));
    session = {
      mode: mode,
      queue: queue,
      index: 0,
      correct: 0,
      wrong: 0,
      total: queue.length,
      learned: 0,
      combo: 0,
      xp: 0,
      coins: 0
    };
    $("studyHome").classList.add("hidden");
    $("studySession").classList.remove("hidden");
    renderStudy();
  }

  function renderStudyHome() {
    $("newCountBadge2").textContent = ds.getNewCount();
    $("reviewCountBadge2").textContent = ds.getDueCount();
    if (session && session.index < session.queue.length) {
      $("studyHome").classList.add("hidden");
      $("studySession").classList.remove("hidden");
      renderStudy();
    } else {
      session = null;
      $("studyHome").classList.remove("hidden");
      $("studySession").classList.add("hidden");
    }
  }

  function renderStudy() {
    var cur = session.queue[session.index];
    if (session.mode === "learn") {
      $("studyProgressText").textContent = "已掌握 " + session.learned + " / " + session.total;
      $("studyProgressBar").value = (session.learned / session.total * 100);
    } else {
      $("studyProgressText").textContent = (session.index + 1) + " / " + session.queue.length;
      $("studyProgressBar").value = (session.index / session.queue.length * 100);
    }
    renderQuiz(cur);
  }

  function updateNotebookBtn(id) {
    var inNB = ds.isInNotebook(id);
    var btn = $("btnToggleNotebook");
    btn.textContent = inNB ? "★ 已加入生词本" : "☆ 标记生词";
    btn.classList.toggle("text-amber-500", inNB);
    btn.classList.toggle("text-slate-600", !inNB);
  }

  function advance() {
    session.index++;
    if (session.index >= session.queue.length) {
      finishSession();
    } else {
      renderStudy();
    }
  }

  function finishSession() {
    var isLearn = session.mode === "learn";
    var total = session.total;
    var reviewed = session.queue.length;
    var correct = session.correct;
    var xp = session.xp || 0;
    var coins = session.coins || 0;
    var levelBefore = Math.floor((ds.getXp() - xp) / 100) + 1;
    var levelNow = ds.getLevel();

    var body;
    if (isLearn) {
      body = "掌握了 <b>" + total + "</b> 个新词，继续加油！";
    } else {
      var rate = reviewed ? Math.round(correct / reviewed * 100) : 0;
      body = "共 <b>" + reviewed + "</b> 个，答对 <b>" + correct + "</b> 个 · 正确率 <b>" + rate + "%</b>";
    }
    body += "<div class='mt-2 text-sm text-slate-500'>本轮 +<b>" + xp + "</b> 经验值 · +<b>" + coins + "</b> 金币</div>";
    if (levelNow > levelBefore) {
      body += "<div class='mt-1 text-lg font-bold text-orange-500'>🎉 升级到 Lv." + levelNow + "！</div>";
    }

    session = null;
    switchView("today");
    celebrate();
    if (levelNow > levelBefore) playSfx("levelup");
    $("doneModalTitle").textContent = isLearn ? "本轮新词学完啦！" : "本轮复习完成！";
    $("doneModalBody").innerHTML = body;
    $("doneModal").showModal();
  }

  // 四选一
  function renderQuiz(cur) {
    var wordEl = $("quizWord");
    wordEl.textContent = cur.word;
    replay(wordEl, "word-pop");
    updateNotebookBtn(cur.id);
    resetMascotMood();
    $("quizFeedback").classList.add("hidden");
    $("btnNextQuiz").classList.add("hidden");

    var all = ds.getWords();
    var distractors = [];
    shuffle(all);
    for (var i = 0; i < all.length && distractors.length < 3; i++) {
      if (all[i].id !== cur.id) distractors.push(all[i]);
    }
    var options = [{ id: cur.id, meaning: cur.meaning, correct: true }]
      .concat(distractors.map(function (w) {
        return { id: w.id, meaning: w.meaning, correct: false };
      }));
    shuffle(options);

    var container = $("quizOptions");
    container.innerHTML = "";
    options.forEach(function (opt) {
      var btn = document.createElement("button");
      btn.className = "quiz-option";
      btn.textContent = opt.meaning;
      btn.dataset.correct = opt.correct ? "true" : "false";
      btn.addEventListener("click", function () {
        answerQuiz(opt.correct, btn, container, cur);
      });
      container.appendChild(btn);
    });
  }

  function answerQuiz(correct, btn, container, cur) {
    // 会话可能已结束（点了退出、或上一题刚答完本轮），忽略残留按钮的点击
    if (!session) return;
    var buttons = container.querySelectorAll(".quiz-option");
    buttons.forEach(function (b) { b.classList.add("disabled"); });

    var correctBtn = container.querySelector('.quiz-option[data-correct="true"]');
    if (correct) {
      btn.classList.add("correct");
      burstConfetti();
      setMascotMood(true);
      // 连击 + 经验值 + 金币
      session.combo++;
      var bonus = comboBonus(session.combo);
      var xp = 10 + bonus;
      session.xp += xp;
      session.coins += 2;
      ds.addXp(xp);
      ds.addCoins(2);
      showFloat("+" + xp + " XP", btn);
      updateCombo(bonus > 0);
      playSfx("correct");
      if (bonus > 0) { playSfx("combo"); burstConfetti(); }
    } else {
      btn.classList.add("wrong");
      correctBtn.classList.add("correct");
      setMascotMood(false);
      // 答错：连击归零 + 抖动 + 低鸣
      session.combo = 0;
      updateCombo(false);
      replay(btn, "shake");
      playSfx("wrong");
    }

    if (session.mode === "learn") {
      if (correct) {
        session.correct++;
        session.learned++;
        ds.markLearned(cur.id);
      } else {
        session.wrong++;
        if (!ds.isInNotebook(cur.id)) { ds.toggleNotebook(cur.id); }
        session.queue.push(cur);
      }
      updateNotebookBtn(cur.id);
    } else {
      ds.recordAnswer(cur.id, correct);
      if (correct) session.correct++;
    }

    var fb = $("quizFeedbackAlert");
    fb.classList.remove("alert-info", "alert-success", "alert-error");
    fb.classList.add(correct ? "alert-success" : "alert-error");
    $("feedbackBody").innerHTML = "";
    var p1 = document.createElement("p");
    p1.className = "font-bold text-slate-700";
    p1.textContent = cur.word + "  " + (cur.phonetic || "");
    var p2 = document.createElement("p");
    p2.className = "text-slate-600 mt-1";
    p2.textContent = cur.meaning;
    var p3 = document.createElement("p");
    p3.className = "text-slate-400 mt-1 italic";
    p3.textContent = cur.example || "";
    $("feedbackBody").appendChild(p1);
    $("feedbackBody").appendChild(p2);
    $("feedbackBody").appendChild(p3);

    $("quizFeedback").classList.remove("hidden");
    $("btnNextQuiz").classList.remove("hidden");

    speakThen([cur.word, cur.example].filter(Boolean));
  }

  // —— 生词本 ——
  function renderNotebook() {
    var list = ds.getNotebook();
    $("notebookCount").textContent = list.length;
    $("notebookEmpty").classList.toggle("hidden", list.length !== 0);

    var container = $("notebookList");
    container.innerHTML = "";
    list.forEach(function (w) {
      var item = document.createElement("div");
      item.className = "notebook-item flex items-center justify-between rounded-xl bg-white p-4 shadow-sm";

      var left = document.createElement("div");
      left.className = "text-left";
      var wEl = document.createElement("p");
      wEl.className = "font-semibold text-slate-800 font-num";
      wEl.textContent = w.word;
      var mEl = document.createElement("p");
      mEl.className = "text-xs text-slate-400 mt-0.5";
      mEl.textContent = w.meaning;
      left.appendChild(wEl); left.appendChild(mEl);

      var rm = document.createElement("button");
      rm.className = "text-slate-300 hover:text-rose-500 text-lg";
      rm.textContent = "✕";
      rm.addEventListener("click", function () {
        ds.toggleNotebook(w.id);
        renderNotebook();
      });

      item.appendChild(left); item.appendChild(rm);
      container.appendChild(item);
    });
  }

  // —— 统计 ——
  function renderStats() {
    countTo("statsStreak", ds.getStreak());
    countTo("statsMastered", ds.getMasteredCount());
    countTo("statsLearned", ds.getLearnedCount());
    countTo("statsTotalStudy", ds.getTotalStudyCount());
    countTo("statsXp", ds.getXp());
    countTo("statsCoins", ds.getCoins());
    $("statsLevel").textContent = "Lv." + ds.getLevel();
    renderHeatmap();
  }

  // 商城
  function renderShop() {
    $("shopCoins").textContent = ds.getCoins();
    var owned = ds.getOwnedOutfits();
    var equipped = ds.getEquippedOutfit();
    var container = $("shopGrid");
    container.innerHTML = "";
    OUTFITS.forEach(function (o) {
      var isOwned = owned.indexOf(o.id) !== -1;
      var isEquipped = equipped === o.id;

      var card = document.createElement("div");
      card.className = "shop-card";
      card.innerHTML =
        '<svg viewBox="0 0 220 220" class="shop-preview" aria-hidden="true">' +
          '<use href="' + guluRef("idle") + '"></use>' +
          '<use href="#gulu-outfit-' + o.id + '"></use>' +
        '</svg>' +
        '<div class="shop-name">' + o.name + '</div>' +
        '<div class="shop-price">' + (isOwned ? "已拥有" : "🪙 " + o.price) + '</div>';

      var btn = document.createElement("button");
      if (isEquipped) {
        btn.className = "btn btn-sm btn-disabled";
        btn.textContent = "穿戴中";
        btn.disabled = true;
      } else if (isOwned) {
        btn.className = "btn btn-sm btn-outline";
        btn.textContent = "穿戴";
      } else {
        btn.className = "btn btn-sm btn-primary";
        btn.textContent = "购买";
      }
      btn.addEventListener("click", function () {
        if (isOwned) {
          ds.equipOutfit(o.id);
          applyOutfit();
          renderShop();
          playSfx("coin");
        } else if (ds.buyOutfit(o.id, o.price)) {
          ds.equipOutfit(o.id);
          applyOutfit();
          renderShop();
          playSfx("coin");
        } else {
          toast("金币不足，先去签到赚金币吧", "info");
        }
      });

      card.appendChild(btn);
      container.appendChild(card);
    });
  }

  function colorFor(count) {
    if (count === 0) return "bg-slate-100";
    if (count < 5) return "bg-emerald-200";
    if (count < 10) return "bg-emerald-400";
    return "bg-emerald-600";
  }

  function renderHeatmap() {
    var stats = ds.getStats();
    var container = $("heatmap");
    container.innerHTML = "";
    for (var i = 27; i >= 0; i--) {
      var key = dateKeyOffset(i);
      var day = stats[key];
      var count = day ? (day.newCount + day.reviewCount) : 0;
      var cell = document.createElement("div");
      cell.className = "h-6 rounded " + colorFor(count);
      cell.title = key + "：" + count + " 次";
      container.appendChild(cell);
    }
  }

  // —— 事件绑定 ——
  document.querySelectorAll(".nav-tab").forEach(function (t) {
    t.addEventListener("click", function () { switchView(t.dataset.view); });
  });

  function goStudy(mode) {
    startSession(mode);
    switchView("study");
  }

  $("btnLearnNew").addEventListener("click", function () { goStudy("learn"); });
  $("btnReview").addEventListener("click", function () { goStudy("review"); });
  $("btnLearnNew2").addEventListener("click", function () { goStudy("learn"); });
  $("btnReview2").addEventListener("click", function () { goStudy("review"); });

  $("btnExitStudy").addEventListener("click", function () {
    session = null;
    switchView("today");
  });

  $("btnToggleNotebook").addEventListener("click", function () {
    if (!session) return;
    var cur = session.queue[session.index];
    var added = ds.toggleNotebook(cur.id);
    updateNotebookBtn(cur.id);
    toast(added ? "已加入生词本" : "已移出生词本", "success");
  });

  $("btnNextQuiz").addEventListener("click", function () {
    if (!session) return;
    advance();
  });

  $("btnSpeak").addEventListener("click", function () {
    if (!session) return;
    speak(session.queue[session.index].word);
  });

  // 首页吉祥物：摸一下 → 弹跳 + 彩带 + 随机鼓励语（惊喜彩蛋）
  var CHEERS = ["加油！你是最棒的～", "冲鸭！", "今天也要元气满满！", "咕噜陪你一起背单词～", "好棒呀！", "继续加油，胜利在望！"];
  $("mascotHero").addEventListener("click", function () {
    replay($("mascotHero"), "mascot-pop");
    burstConfetti();
    sayBubble(CHEERS[Math.floor(Math.random() * CHEERS.length)]);
  });

  // 每日签到
  $("checkInBtn").addEventListener("click", function () {
    var r = ds.checkIn();
    if (r.already) return;
    playSfx("coin");
    showFloat("+" + r.earnedCoins + " 🪙", $("checkInBtn"));
    toast("签到成功：+" + r.earnedCoins + " 金币、+5 XP（连签 " + r.streak + " 天）", "success");
    switchView("today");
  });

  // 重置：DaisyUI modal 确认
  $("btnReset").addEventListener("click", function () { $("resetModal").showModal(); });
  $("resetCancel").addEventListener("click", function () { $("resetModal").close(); });
  $("resetConfirm").addEventListener("click", function () {
    $("resetModal").close();
    ds.resetAll();
    renderStats();
    renderToday();
    toast("已重置所有数据", "success");
  });

  // 学习完成弹窗关闭
  $("doneClose").addEventListener("click", function () { $("doneModal").close(); });

  // 点弹窗背景关闭
  function closeOnBackdrop(id) {
    $(id).addEventListener("click", function (e) {
      if (e.target === $(id)) $(id).close();
    });
  }
  closeOnBackdrop("resetModal");
  closeOnBackdrop("doneModal");

  // —— 启动 ——
  // 首次触摸页面即预热语音引擎，之后点小喇叭/答题出音更快
  document.addEventListener("pointerdown", primeSpeech, { once: true, passive: true });
  switchView("today");
  startMascotIdle();
})();
