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
    stats: ["统计", "学习记录与打卡"]
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
  function heroUse() { return document.querySelector("#mascotHero use"); }
  function feedbackUse() { return document.querySelector("#feedbackMascot use"); }

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
    u.setAttribute("href", happy ? "#shinchan-happy" : "#shinchan-sad");
    replay($("feedbackMascot"), "mascot-pop");
  }

  function resetMascotMood() {
    var u = feedbackUse();
    if (u) u.setAttribute("href", "#shinchan");
  }

  // 待机小动作：首页吉祥物偶尔眨眼
  function startMascotIdle() {
    var u = heroUse();
    if (!u) return;
    setInterval(function () {
      u.setAttribute("href", "#shinchan-blink");
      setTimeout(function () { u.setAttribute("href", "#shinchan"); }, 150);
    }, 4600);
  }

  // —— 视图切换 ——
  function switchView(name) {
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

    if (name === "today") renderToday();
    if (name === "notebook") renderNotebook();
    if (name === "stats") renderStats();
    if (name === "study") renderStudyHome();
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
      learned: 0
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

    var body;
    if (isLearn) {
      body = "掌握了 <b>" + total + "</b> 个新词，继续加油！";
    } else {
      var rate = reviewed ? Math.round(correct / reviewed * 100) : 0;
      body = "共 <b>" + reviewed + "</b> 个，答对 <b>" + correct + "</b> 个 · 正确率 <b>" + rate + "%</b>";
    }

    session = null;
    switchView("today");
    celebrate();
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
    } else {
      btn.classList.add("wrong");
      correctBtn.classList.add("correct");
      setMascotMood(false);
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
    renderHeatmap();
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
  var CHEERS = ["加油！你是最棒的～", "冲鸭！", "今天也要元气满满！", "小新陪你一起背单词～", "好棒呀！", "继续加油，胜利在望！"];
  $("mascotHero").addEventListener("click", function () {
    replay($("mascotHero"), "mascot-pop");
    burstConfetti();
    sayBubble(CHEERS[Math.floor(Math.random() * CHEERS.length)]);
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
