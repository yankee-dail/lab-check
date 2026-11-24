(() => {
  const token = location.hash.slice(1);
  const app = document.getElementById("app");
  const overlay = document.getElementById("fsOverlay");
  const api = (p) => `/api/attempts/${encodeURIComponent(token)}${p}`;
  const LETTERS = ["A", "B", "C", "D"];

  let state = null;
  let current = null; // current question payload
  let deadline = 0;
  let tick = null;
  let answering = false;
  let testRunning = false;
  let ended = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  async function post(path, body) {
    const r = await fetch(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      keepalive: true,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Помилка зв'язку");
    return data;
  }

  // ---------- event reporting ----------
  function report(type, detail) {
    if (ended || !state || !["ready", "in_progress"].includes(state.status)) return;
    post("/event", { type, detail: detail || "" })
      .then((r) => {
        if (r.counted) state.violations = r.violations;
        updateViol();
        if (r.status === "terminated") finish({ status: "terminated" });
      })
      .catch(() => {});
  }
  window.guardReport = (type, detail) => testRunning && report(type, detail);

  document.addEventListener("visibilitychange", () => {
    if (testRunning && document.visibilityState === "hidden") report("tab_hidden", "Сторінку приховано");
  });
  window.addEventListener("blur", () => {
    if (testRunning) report("window_blur", "Фокус перейшов в інше вікно/програму");
  });
  document.addEventListener("fullscreenchange", () => {
    if (!testRunning) return;
    if (!document.fullscreenElement) {
      report("fullscreen_exit");
      showOverlay();
    } else {
      overlay.classList.remove("show");
      report("fullscreen_enter");
    }
  });
  let lastResize = 0;
  window.addEventListener("resize", () => {
    if (!testRunning || !document.fullscreenElement) return;
    if (Date.now() - lastResize < 3000) return;
    lastResize = Date.now();
    if (window.innerWidth < screen.width * 0.9 || window.innerHeight < screen.height * 0.8) {
      report("resize", `${window.innerWidth}×${window.innerHeight} при екрані ${screen.width}×${screen.height}`);
    }
  });

  function showOverlay() {
    document.getElementById("fsViol").innerHTML = `Порушень: <b>${state.violations}</b> з ${state.maxViolations}`;
    overlay.classList.add("show");
  }
  document.getElementById("fsBack").addEventListener("click", () => enterFullscreen());

  async function enterFullscreen() {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      return true;
    } catch {
      return false;
    }
  }

  function updateViol() {
    const el = document.getElementById("viol");
    if (el && state) el.innerHTML = `Порушень: <b>${state.violations}</b> / ${state.maxViolations}`;
    if (overlay.classList.contains("show")) showOverlay();
  }

  // ---------- canvas text (questions are drawn, not placed as text) ----------
  function wrapLines(ctx, text, maxWidth) {
    const out = [];
    for (const para of String(text).split("\n")) {
      const words = para.split(/(\s+)/);
      let line = "";
      for (const w of words) {
        const test = line + w;
        if (ctx.measureText(test).width > maxWidth && line.trim()) {
          out.push(line.trimEnd());
          line = w.trimStart();
          // very long tokens (code) – hard-break
          while (ctx.measureText(line).width > maxWidth && line.length > 1) {
            let cut = line.length - 1;
            while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
            out.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        } else line = test;
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  function drawBlocks(canvas, blocks, { pad = 20, watermark = "" } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.parentElement.clientWidth;
    const ctx = canvas.getContext("2d");
    const inner = width - pad * 2;
    const layout = [];
    let h = pad;
    for (const b of blocks) {
      ctx.font = b.font;
      const lines = b.mono ? b.text.split("\n").flatMap((l) => wrapLines(ctx, l.replace(/\t/g, "    "), inner - 20)) : wrapLines(ctx, b.text, inner);
      const lh = b.lineHeight;
      const blockH = lines.length * lh + (b.mono ? 20 : 0);
      layout.push({ ...b, lines, y: h, h: blockH });
      h += blockH + (b.gap ?? 14);
    }
    h += pad - 14;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, h);
    for (const b of layout) {
      ctx.font = b.font;
      ctx.textBaseline = "top";
      if (b.mono) {
        ctx.fillStyle = "#f3f5f8";
        ctx.fillRect(pad, b.y, inner, b.h);
      }
      ctx.fillStyle = b.color || "#15181e";
      b.lines.forEach((ln, i) => ctx.fillText(ln, pad + (b.mono ? 10 : 0), b.y + (b.mono ? 10 : 0) + i * b.lineHeight));
    }
    if (watermark) {
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = "#000";
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.rotate(-0.2);
      for (let y = 20; y < h + width * 0.3; y += 70) {
        for (let x = -100; x < width; x += 260) ctx.fillText(watermark, x, y);
      }
      ctx.restore();
    }
  }

  const FONT = '18px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const FONT_B = '600 19px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const MONO = '15px ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

  // ---------- screens ----------
  async function load() {
    if (!token) {
      app.innerHTML = `<div class="card">Посилання некоректне. <a href="/">Повернутися</a></div>`;
      return;
    }
    try {
      const r = await fetch(api(""));
      state = await r.json();
      if (!r.ok) throw new Error(state.error || "Спробу не знайдено");
    } catch (e) {
      app.innerHTML = `<div class="card">${esc(e.message)} <a href="/">На головну</a></div>`;
      return;
    }
    route();
  }

  function route() {
    const s = state.status;
    if (s === "generating") return generating();
    if (s === "failed") {
      app.innerHTML = `<div class="card"><h2>Не вдалося скласти тест</h2><p class="muted">${esc(state.error || "")}</p><a class="btn" href="/">Спробувати ще раз</a></div>`;
      return;
    }
    if (s === "ready") return intro(false);
    if (s === "in_progress") return intro(true);
    return finish(state);
  }

  function generating() {
    app.innerHTML = `<div class="card center"><div class="spinner"></div><h2>Аналізуємо твою роботу</h2>
      <p class="muted">Складаємо питання по твоєму коду і лекції. Зазвичай це 30–90 секунд. Не закривай сторінку.</p></div>`;
    setTimeout(load, 2500);
  }

  function intro(resume) {
    app.innerHTML = `<div class="card">
      <h2>${esc(state.labTitle)}</h2>
      <p class="muted">${esc(state.studentName)}</p>
      ${resume ? `<div class="notice" style="margin-bottom:12px">Тест уже розпочато. Повернення після закриття сторінки записано в журнал. Час на поточне питання не зупинявся.</div>` : ""}
      <ul class="rules">
        <li><b>${state.total}</b> питань, по <b>${state.secondsPerQuestion} с</b> на кожне. Після відповіді — одразу наступне, назад не можна.</li>
        <li>Тест іде <b>лише у повноекранному режимі</b>.</li>
        <li>Перемикання вкладок, вікон, згортання браузера і вихід з повноекранного режиму — порушення. Після <b>${state.maxViolations}</b> тест закривається.</li>
        <li>Відповідати можна мишкою або клавішами <b>1–4</b>.</li>
        <li>Результат і журнал дій надсилаються викладачу.</li>
      </ul>
      <button class="btn block" id="go">${resume ? "Продовжити" : "Почати"} у повноекранному режимі</button>
      <div class="error" id="err"></div>
    </div>`;
    document.getElementById("go").addEventListener("click", async () => {
      const ok = await enterFullscreen();
      if (!ok || !document.fullscreenElement) {
        document.getElementById("err").textContent = "Браузер не дозволив повноекранний режим. Спробуйте Chrome, Edge або Firefox на комп'ютері.";
        return;
      }
      try {
        state = await post("/start");
      } catch (e) {
        document.getElementById("err").textContent = e.message;
        return;
      }
      if (state.status !== "in_progress") return route();
      testRunning = true;
      nextQuestion();
    });
  }

  async function nextQuestion() {
    clearInterval(tick);
    answering = false;
    let data;
    try {
      data = await post("/question");
    } catch (e) {
      app.innerHTML = `<div class="card"><p>Помилка зв'язку: ${esc(e.message)}</p><button class="btn" id="retry">Повторити</button></div>`;
      document.getElementById("retry").onclick = nextQuestion;
      return;
    }
    if (data.done) return finish(data.state);
    current = data;
    state.violations = data.violations;
    deadline = Date.now() + data.remainingMs;
    renderQuestion();
  }

  function renderQuestion() {
    const qn = current;
    app.innerHTML = `
      <div class="test-top">
        <div><b>Питання ${qn.index + 1}</b> з ${qn.total}</div>
        <div class="viol" id="viol"></div>
        <div class="timer" id="timer"></div>
      </div>
      <div class="bar" id="bar"><div id="barFill"></div></div>
      <canvas class="qcanvas" id="qc"></canvas>
      <div class="options" id="opts">
        ${qn.options.map((_, i) => `<button class="opt" data-i="${i}"><span class="letter">${i + 1}</span><canvas></canvas></button>`).join("")}
      </div>`;
    updateViol();

    const wm = `${state.studentName} · ${new Date().toLocaleDateString("uk-UA")}`;
    const draw = () => {
      const blocks = [{ text: qn.question, font: FONT_B, lineHeight: 28 }];
      if (qn.code) blocks.push({ text: qn.code, font: MONO, lineHeight: 22, mono: true });
      drawBlocks(document.getElementById("qc"), blocks, { watermark: wm });
      document.querySelectorAll(".opt canvas").forEach((c, i) => {
        const isCode = /[;{}()=<>[\]]/.test(qn.options[i]) && qn.options[i].length < 120;
        drawBlocks(c, [{ text: qn.options[i], font: isCode ? MONO : FONT, lineHeight: 26, gap: 0 }], { pad: 6 });
      });
    };
    draw();
    window.onresize = () => current === qn && draw();

    document.getElementById("opts").addEventListener("click", (e) => {
      const b = e.target.closest(".opt");
      if (b) answer(Number(b.dataset.i));
    });

    const total = state.secondsPerQuestion * 1000;
    const step = () => {
      const left = Math.max(0, deadline - Date.now());
      const t = document.getElementById("timer");
      if (!t) return;
      t.textContent = Math.ceil(left / 1000) + " с";
      const low = left < 10000;
      t.classList.toggle("low", low);
      document.getElementById("bar").classList.toggle("low", low);
      document.getElementById("barFill").style.width = (left / total) * 100 + "%";
      if (left <= 0) answer(null);
    };
    step();
    tick = setInterval(step, 200);
  }

  document.addEventListener("keydown", (e) => {
    if (!testRunning || !current || answering) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 4) answer(n - 1);
  });

  async function answer(choice) {
    if (answering || !current) return;
    answering = true;
    clearInterval(tick);
    document.querySelectorAll(".opt").forEach((b) => (b.disabled = true));
    const idx = current.index;
    current = null;
    try {
      const r = await post("/answer", { index: idx, choice });
      if (r.done) return finish(r.state);
    } catch {
      /* server applies timeouts itself; just move on */
    }
    nextQuestion();
  }

  async function finish(s) {
    testRunning = false;
    ended = true;
    clearInterval(tick);
    overlay.classList.remove("show");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (s.score === undefined) {
      try {
        const r = await fetch(api(""));
        s = await r.json();
      } catch {}
    }
    const title = {
      finished: "Тест завершено",
      terminated: "Тест закрито через порушення",
      abandoned: "Тест закрито через неактивність",
    }[s.status] || "Тест завершено";
    app.innerHTML = `<div class="card center">
      <h2>${title}</h2>
      ${s.score !== undefined && s.score !== null ? `<div class="score">${s.score} / ${s.total}</div>` : ""}
      <p class="muted">Результат і журнал дій надіслано викладачу. Сторінку можна закрити.</p>
    </div>`;
  }

  load();
})();
