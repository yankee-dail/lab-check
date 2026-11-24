(() => {
  const $ = (id) => document.getElementById(id);
  let key = sessionStorage.getItem("adminKey") || "";
  let labs = [];
  let filterLab = "";

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const dt = (s) => (s ? new Date(s).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" }) : "—");
  const kb = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " МБ" : Math.round(n / 1024) + " КБ");

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "x-admin-key": key } });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      logout();
      throw new Error("Невірний пароль");
    }
    if (!r.ok) throw new Error(data.error || "Помилка");
    return data;
  }

  // ---------- auth ----------
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    key = $("pw").value;
    try {
      await login();
    } catch (err) {
      $("loginErr").textContent = err.message;
    }
  });
  $("logout").onclick = logout;
  function logout() {
    key = "";
    sessionStorage.removeItem("adminKey");
    $("main").hidden = true;
    $("logout").hidden = true;
    $("login").hidden = false;
  }
  async function login() {
    const info = await api("/api/admin/login", { method: "POST" });
    sessionStorage.setItem("adminKey", key);
    $("login").hidden = true;
    $("main").hidden = false;
    $("logout").hidden = false;
    $("mailInfo").textContent = info.mail && info.teacherEmail
      ? `Звіти надсилаються на ${info.teacherEmail}`
      : "⚠️ Пошта не налаштована — звіти видно лише тут (див. README: RESEND_API_KEY, TEACHER_EMAIL).";
    await loadLabs();
    showTab("attempts");
  }
  if (key) login().catch(() => {});

  // ---------- tabs ----------
  document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  function showTab(t) {
    document.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === t);
      b.classList.toggle("secondary", b.dataset.tab !== t);
    });
    $("tab-attempts").hidden = t !== "attempts";
    $("tab-labs").hidden = t !== "labs";
    if (t === "attempts") renderAttempts();
    else renderLabs();
  }

  // ---------- labs ----------
  async function loadLabs() {
    labs = await api("/api/admin/labs");
  }

  function labForm(l) {
    l = l || { title: "", description: "", lecture_text: "", question_count: 10, seconds_per_question: 40, max_violations: 3, active: true, files: [] };
    return `<form class="card labform" data-id="${l.id || ""}">
      <h2>${l.id ? "Редагування" : "Нова лабораторна"}</h2>
      <label>Назва</label>
      <input type="text" name="title" value="${esc(l.title)}" required>
      <label>Завдання (коротко, необов'язково)</label>
      <textarea name="description" style="min-height:70px">${esc(l.description)}</textarea>
      <label>Лекція — файли (PDF, DOCX, PPTX, TXT, MD, ZIP)</label>
      <input type="file" name="files" multiple>
      ${l.files?.length ? `<ul class="files">${l.files.map((f) => `<li><span>${esc(f.name)} <span class="muted">(${kb(f.size)})</span></span><button type="button" data-delfile="${f.id}">видалити</button></li>`).join("")}</ul>` : ""}
      <label>Лекція — текст (можна вставити замість файлу або додатково)</label>
      <textarea name="lecture_text">${esc(l.lecture_text)}</textarea>
      <div class="row3">
        <div><label>Кількість питань</label><input type="number" name="question_count" min="3" max="20" value="${l.question_count}"></div>
        <div><label>Секунд на питання</label><input type="number" name="seconds_per_question" min="15" max="180" value="${l.seconds_per_question}"></div>
        <div><label>Порушень до закриття</label><input type="number" name="max_violations" min="1" max="10" value="${l.max_violations}"></div>
      </div>
      ${l.id ? `<label><input type="checkbox" name="active" ${l.active ? "checked" : ""}> Відкрита для студентів</label>` : ""}
      <div class="flex" style="margin-top:16px">
        <button class="btn">${l.id ? "Зберегти" : "Створити"}</button>
        ${l.id ? `<button type="button" class="btn danger" data-dellab="${l.id}">Видалити лабораторну</button>` : ""}
      </div>
      <div class="error"></div>
    </form>`;
  }

  function renderLabs() {
    const base = location.origin;
    $("tab-labs").innerHTML =
      labs
        .map(
          (l) => `<div class="card">
        <div class="between">
          <div><h2 style="margin:0">${esc(l.title)}</h2>
          <span class="pill ${l.active ? "ok" : ""}">${l.active ? "відкрита" : "закрита"}</span>
          <span class="muted small">· ${l.question_count} пит. · ${l.seconds_per_question} с · ліміт ${l.max_violations} · спроб: ${l.attempts} · лекція: ${l.files.length} файл(ів)${l.lecture_text ? " + текст" : ""}</span></div>
          <button class="btn secondary small" data-edit="${l.id}">Редагувати</button>
        </div>
        <p class="small" style="margin-top:10px">Посилання для студентів:</p>
        <div class="link">${base}/?lab=${l.id}</div>
        <div id="edit-${l.id}"></div>
      </div>`,
        )
        .join("") + labForm(null);
    bindForms();
  }

  $("tab-labs").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.edit) {
      const box = $("edit-" + t.dataset.edit);
      if (box.innerHTML) box.innerHTML = "";
      else {
        box.innerHTML = labForm(labs.find((l) => String(l.id) === t.dataset.edit));
        bindForms();
      }
    } else if (t.dataset.delfile) {
      if (!confirm("Видалити файл лекції?")) return;
      await api("/api/admin/lab-files/" + t.dataset.delfile, { method: "DELETE" });
      await loadLabs();
      renderLabs();
    } else if (t.dataset.dellab) {
      if (!confirm("Видалити лабораторну разом з усіма результатами студентів?")) return;
      await api("/api/admin/labs/" + t.dataset.dellab, { method: "DELETE" });
      await loadLabs();
      renderLabs();
    }
  });

  function bindForms() {
    document.querySelectorAll("form.labform").forEach((f) => {
      if (f.dataset.bound) return;
      f.dataset.bound = 1;
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(f);
        if (f.dataset.id) fd.set("active", f.querySelector('[name="active"]').checked ? "true" : "false");
        const btn = f.querySelector("button.btn");
        btn.disabled = true;
        try {
          await api("/api/admin/labs" + (f.dataset.id ? "/" + f.dataset.id : ""), { method: f.dataset.id ? "PUT" : "POST", body: fd });
          await loadLabs();
          renderLabs();
        } catch (err) {
          f.querySelector(".error").textContent = err.message;
          btn.disabled = false;
        }
      });
    });
  }

  // ---------- attempts ----------
  const STATUS = {
    generating: ["генерація", ""],
    ready: ["не розпочато", ""],
    in_progress: ["проходить", "warn"],
    finished: ["завершено", "ok"],
    terminated: ["закрито: порушення", "bad"],
    abandoned: ["покинуто", "bad"],
    failed: ["помилка генерації", "bad"],
  };

  async function renderAttempts() {
    const box = $("tab-attempts");
    const list = await api("/api/admin/attempts" + (filterLab ? "?lab=" + filterLab : ""));
    box.innerHTML = `<div class="card">
      <div class="between" style="margin-bottom:12px">
        <select id="labFilter" style="max-width:360px"><option value="">Усі лабораторні</option>${labs
          .map((l) => `<option value="${l.id}" ${String(l.id) === filterLab ? "selected" : ""}>${esc(l.title)}</option>`)
          .join("")}</select>
        <div class="flex"><button class="btn secondary small" id="csv">CSV</button><button class="btn secondary small" id="refresh">Оновити</button></div>
      </div>
      <div class="scroll"><table class="list">
        <tr><th>Студент</th><th>Група</th><th>Лабораторна</th><th>Бал</th><th>Порушення</th><th>Статус</th><th>Лист</th><th>Дата</th></tr>
        ${list
          .map((a) => {
            const [st, cls] = STATUS[a.status] || [a.status, ""];
            return `<tr class="click" data-id="${a.id}">
            <td>${esc(a.student_name)}</td><td>${esc(a.student_group)}</td><td>${esc(a.lab_title)}</td>
            <td><b>${a.score ?? "—"}</b>${a.total ? " / " + a.total : ""}</td>
            <td>${a.violations ? `<span class="pill warn">${a.violations}</span>` : "0"}</td>
            <td><span class="pill ${cls}">${st}</span></td>
            <td class="small muted">${esc(a.email_status || "")}</td>
            <td class="small">${dt(a.created_at)}</td></tr>
            <tr hidden id="detail-${a.id}"><td colspan="8"></td></tr>`;
          })
          .join("") || `<tr><td colspan="8" class="muted">Поки немає спроб</td></tr>`}
      </table></div></div>`;
    $("labFilter").onchange = (e) => {
      filterLab = e.target.value;
      renderAttempts();
    };
    $("refresh").onclick = renderAttempts;
    $("csv").onclick = () => {
      const rows = [["Студент", "Група", "Лабораторна", "Бал", "З", "Порушення", "Статус", "Дата"]].concat(
        list.map((a) => [a.student_name, a.student_group, a.lab_title, a.score ?? "", a.total, a.violations, (STATUS[a.status] || [a.status])[0], dt(a.created_at)]),
      );
      const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "results.csv";
      a.click();
    };
    box.querySelectorAll("tr.click").forEach((tr) => (tr.onclick = () => toggleDetail(tr.dataset.id)));
  }

  const EV = {
    tab_hidden: "Інша вкладка / згортання", window_blur: "Вікно втратило фокус", fullscreen_exit: "Вихід з повноекранного",
    fullscreen_enter: "Повернувся в повноекранний", copy_attempt: "Спроба копіювання", paste_attempt: "Спроба вставлення",
    context_menu: "Права кнопка", devtools_key: "Інструменти розробника", print_attempt: "Друк / збереження", printscreen_key: "PrintScreen",
    select_all: "Виділити все", resize: "Зміна розміру вікна", reload: "Перезавантаження сторінки", timeout: "Час вичерпано",
    started: "Розпочато", finished: "Завершено", terminated: "Закрито (ліміт порушень)", abandoned: "Покинуто",
  };

  async function toggleDetail(id) {
    const row = $("detail-" + id);
    if (!row.hidden) return (row.hidden = true);
    const a = await api("/api/admin/attempts/" + id);
    const L = ["A", "B", "C", "D"];
    const qs = (a.questions || [])
      .map((q, i) => {
        const ans = a.answers[i];
        const mark = !ans ? "—" : ans.choice === null ? "⏱" : ans.correct ? "✅" : "❌";
        return `<li style="margin-bottom:10px">${mark} <b>${esc(q.question)}</b>
          ${q.code_snippet ? `<pre class="code">${esc(q.code_snippet)}</pre>` : ""}
          <div class="small">${q.options.map((o, j) => `${L[j]}) ${esc(o)}${j === q.correct ? " ✔" : ""}${ans && ans.choice === j ? " ← відповідь" : ""}`).join("<br>")}</div>
          <div class="small muted">${ans?.ms != null ? (ans.ms / 1000).toFixed(1) + " с" : ""} ${esc(q.explanation)}</div></li>`;
      })
      .join("");
    const start = a.started_at ? new Date(a.started_at).getTime() : null;
    const evs = a.events
      .map(
        (e) =>
          `<tr${e.counted ? ' style="background:#fff4e5"' : ""}><td class="small">${new Date(e.at).toLocaleTimeString("uk-UA")}${start ? ` (+${Math.max(0, Math.round((new Date(e.at) - start) / 1000))} с)` : ""}</td>
          <td class="small">${e.question_index != null ? "Пит. " + (e.question_index + 1) : ""}</td><td>${e.counted ? "⚠️ " : ""}${esc(EV[e.type] || e.type)}</td><td class="small muted">${esc(e.detail)}</td></tr>`,
      )
      .join("");
    row.cells[0].innerHTML = `<div style="padding:8px 0 16px">
      <div class="flex" style="margin-bottom:12px">
        ${a.files.map((f) => `<a class="btn secondary small" href="/api/admin/files/${f.id}?key=${encodeURIComponent(key)}">⬇ ${esc(f.name)}</a>`).join("")}
        <button class="btn secondary small" data-resend="${a.id}">Надіслати звіт ще раз</button>
        <button class="btn danger small" data-delattempt="${a.id}">Видалити спробу (дозволить перездати)</button>
      </div>
      ${a.error ? `<p class="error">${esc(a.error)}</p>` : ""}
      <p class="small muted">${esc(a.submission_note)} · IP ${esc(a.ip)} · ${esc(a.user_agent)}</p>
      <div class="row"><div><h2>Питання</h2><ol style="padding-left:18px">${qs || "<li class='muted'>Немає</li>"}</ol></div>
      <div><h2>Журнал дій</h2><table class="list">${evs || "<tr><td class='muted'>Подій немає</td></tr>"}</table></div></div>
    </div>`;
    row.hidden = false;
    row.querySelector("[data-resend]").onclick = async (e) => {
      e.target.disabled = true;
      const r = await api(`/api/admin/attempts/${id}/resend`, { method: "POST" });
      e.target.textContent = r.email_status || "Готово";
    };
    row.querySelector("[data-delattempt]").onclick = async () => {
      if (!confirm("Видалити цю спробу?")) return;
      await api("/api/admin/attempts/" + id, { method: "DELETE" });
      renderAttempts();
    };
  }
})();
