/**
 * app.js
 * 界面交互与视图逻辑：视图切换、学习/复习会话、生词本、统计。
 * 所有数据读写均通过 dataService。
 */
(function () {
  "use strict";

  var ds = window.dataService;
  function $(id) { return document.getElementById(id); }

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

  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast-msg";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // 朗读（Web Speech API，英文发音）
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略不支持的情况 */ }
  }

  // 按顺序朗读多段文本（先单词后例句）
  function speakThen(texts) {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      speakNext(texts, 0);
    } catch (e) { /* 忽略不支持的情况 */ }
  }

  function speakNext(texts, i) {
    if (i >= texts.length) return;
    var u = new SpeechSynthesisUtterance(texts[i]);
    u.lang = "en-US";
    u.rate = 0.9;
    u.onend = function () { speakNext(texts, i + 1); };
    window.speechSynthesis.speak(u);
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
      toast(mode === "learn" ? "没有待学习的新词了" : "没有需要复习的单词");
      return;
    }
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
      $("studyProgressBar").style.width = (session.learned / session.total * 100) + "%";
    } else {
      $("studyProgressText").textContent = (session.index + 1) + " / " + session.queue.length;
      $("studyProgressBar").style.width = (session.index / session.queue.length * 100) + "%";
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
    var msg;
    if (session.mode === "learn") {
      msg = "本次学习了 " + session.total + " 个新词！";
    } else {
      msg = "本次复习 " + session.queue.length + " 个，答对 " + session.correct + " 个。";
    }
    session = null;
    switchView("today");
    toast("🎉 " + msg);
  }

  // 复习模式：四选一
  function renderQuiz(cur) {
    $("quizWord").textContent = cur.word;
    updateNotebookBtn(cur.id);
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
    var buttons = container.querySelectorAll(".quiz-option");
    buttons.forEach(function (b) { b.classList.add("disabled"); });

    var correctBtn = container.querySelector('.quiz-option[data-correct="true"]');
    if (correct) {
      btn.classList.add("correct");
    } else {
      btn.classList.add("wrong");
      correctBtn.classList.add("correct");
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

    var fb = $("quizFeedback");
    fb.classList.remove("hidden");
    fb.classList.toggle("bg-emerald-50", correct);
    fb.classList.toggle("bg-rose-50", !correct);
    fb.innerHTML = "";
    var p1 = document.createElement("p");
    p1.className = "font-bold text-slate-700";
    p1.textContent = cur.word + "  " + (cur.phonetic || "");
    var p2 = document.createElement("p");
    p2.className = "text-slate-600 mt-1";
    p2.textContent = cur.meaning;
    var p3 = document.createElement("p");
    p3.className = "text-slate-400 mt-1 italic";
    p3.textContent = cur.example || "";
    fb.appendChild(p1); fb.appendChild(p2); fb.appendChild(p3);

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
      item.className = "flex items-center justify-between rounded-xl bg-white p-4 shadow-sm";

      var left = document.createElement("div");
      left.className = "text-left";
      var wEl = document.createElement("p");
      wEl.className = "font-semibold text-slate-800";
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
    $("statsStreak").textContent = ds.getStreak();
    $("statsMastered").textContent = ds.getMasteredCount();
    $("statsLearned").textContent = ds.getLearnedCount();
    $("statsTotalStudy").textContent = ds.getTotalStudyCount();
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
    toast(added ? "已加入生词本" : "已移出生词本");
  });

  $("btnNextQuiz").addEventListener("click", function () {
    if (!session) return;
    advance();
  });

  $("btnSpeak").addEventListener("click", function () {
    if (!session) return;
    speak(session.queue[session.index].word);
  });

  $("btnReset").addEventListener("click", function () {
    if (confirm("确定要清空所有学习记录吗？此操作不可恢复。")) {
      ds.resetAll();
      renderStats();
      renderToday();
      toast("已重置所有数据");
    }
  });

  // —— 启动 ——
  switchView("today");
})();
