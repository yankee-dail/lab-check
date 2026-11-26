const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const EVENT_LABELS = {
  tab_hidden: "Перехід на іншу вкладку / згортання",
  window_blur: "Вікно браузера втратило фокус",
  fullscreen_exit: "Вихід з повноекранного режиму",
  copy_attempt: "Спроба копіювання",
  paste_attempt: "Спроба вставлення",
  context_menu: "Права кнопка миші",
  devtools_key: "Комбінація інструментів розробника",
  print_attempt: "Спроба друку / збереження сторінки",
  printscreen_key: "Клавіша PrintScreen",
  select_all: "Спроба виділити все",
  resize: "Зміна розміру вікна",
  reload: "Сторінку перезавантажено",
  timeout: "Час на питання вичерпано",
  started: "Тест розпочато",
  finished: "Тест завершено",
  terminated: "Тест примусово закрито",
  abandoned: "Студент покинув тест",
  fullscreen_enter: "Увійшов у повноекранний режим",
  assistant_hotkey: "Гаряча клавіша асистента (Gemini, Siri, ChatGPT тощо)",
  key_press: "Сторонні клавіші",
};

export const eventLabel = (t) => EVENT_LABELS[t] || t;

export function timingStats(answers) {
  const times = answers.filter((a) => a.choice !== null && a.ms != null).map((a) => a.ms / 1000);
  if (!times.length) return { mean: 0, sd: 0, flags: [] };
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const sd = Math.sqrt(times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length);
  const flags = [];
  if (times.length >= 5 && mean > 15 && sd < 3) flags.push("Підозріло рівні паузи на всіх питаннях (схоже на очікування відповіді ззовні)");
  const late = times.filter((t) => t > 25).length;
  if (times.length >= 5 && late / times.length >= 0.6) flags.push(`${late} з ${times.length} відповідей дано в останні секунди`);
  return { mean, sd, flags };
}

export function buildReport({ attempt, lab, events }) {
  const answers = attempt.answers || [];
  const questions = attempt.questions || [];
  const total = questions.length;
  const stats = timingStats(answers);
  const statusText = {
    finished: "Завершено",
    terminated: "Закрито через порушення",
    abandoned: "Покинуто (студент не завершив)",
  }[attempt.status] || attempt.status;

  const letters = ["A", "B", "C", "D"];
  const qRows = questions
    .map((q, i) => {
      const a = answers[i];
      const choice = a ? a.choice : null;
      const ok = choice === q.correct;
      const mark = !a ? "—" : choice === null ? "⏱ час вийшов" : ok ? "✅" : "❌";
      return `<tr style="background:${ok ? "#f0fdf4" : a ? "#fef2f2" : "#fff"}">
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top">${i + 1}</td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top">${esc(q.question)}${
          q.code_snippet ? `<pre style="background:#f5f5f5;padding:6px;font-size:12px;white-space:pre-wrap">${esc(q.code_snippet)}</pre>` : ""
        }<div style="font-size:12px;color:#555">${q.options.map((o, j) => `${letters[j]}) ${esc(o)}${j === q.correct ? " ✔" : ""}`).join("<br>")}</div></td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top;text-align:center">${choice === null || choice === undefined ? "—" : letters[choice]}</td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top;text-align:center">${mark}</td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top;text-align:center">${a?.ms != null ? (a.ms / 1000).toFixed(1) + " с" : "—"}</td>
      </tr>`;
    })
    .join("");

  const start = attempt.started_at ? new Date(attempt.started_at).getTime() : null;
  const evRows = events
    .map((e) => {
      const rel = start ? `+${Math.max(0, Math.round((new Date(e.at).getTime() - start) / 1000))} с` : "";
      return `<tr${e.counted ? ' style="background:#fff7ed"' : ""}>
        <td style="padding:4px 6px;border:1px solid #ddd;white-space:nowrap">${esc(new Date(e.at).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv" }))} ${rel}</td>
        <td style="padding:4px 6px;border:1px solid #ddd">${e.question_index != null ? "Пит. " + (e.question_index + 1) : ""}</td>
        <td style="padding:4px 6px;border:1px solid #ddd">${e.counted ? "⚠️ " : ""}${esc(eventLabel(e.type))}</td>
        <td style="padding:4px 6px;border:1px solid #ddd;color:#555">${esc(e.detail)}</td>
      </tr>`;
    })
    .join("");

  const html = `<div style="font-family:Arial,sans-serif;max-width:900px;color:#111">
    <h2 style="margin:0 0 4px">${esc(attempt.student_name)}${attempt.student_group ? ` (${esc(attempt.student_group)})` : ""} — ${attempt.score ?? 0}/${total}</h2>
    <div style="color:#555;margin-bottom:12px">${esc(lab.title)} · ${statusText}</div>
    <table style="border-collapse:collapse;margin-bottom:16px;font-size:14px">
      ${attempt.student_email ? `<tr><td style="padding:3px 12px 3px 0;color:#555">Email студента</td><td>${esc(attempt.student_email)}</td></tr>` : ""}
      <tr><td style="padding:3px 12px 3px 0;color:#555">Оцінка</td><td><b>${attempt.score ?? 0} з ${total}</b> (${total ? Math.round(((attempt.score ?? 0) / total) * 100) : 0}%)</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Порушень</td><td><b>${attempt.violations}</b> (ліміт ${lab.max_violations})</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Початок</td><td>${attempt.started_at ? new Date(attempt.started_at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }) : "—"}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Кінець</td><td>${attempt.finished_at ? new Date(attempt.finished_at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }) : "—"}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Середній час відповіді</td><td>${stats.mean.toFixed(1)} с (розкид ±${stats.sd.toFixed(1)} с)</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">IP / браузер</td><td style="font-size:12px">${esc(attempt.ip)} · ${esc(attempt.user_agent)}</td></tr>
      ${attempt.submission_note ? `<tr><td style="padding:3px 12px 3px 0;color:#555">Файли</td><td style="font-size:12px">${esc(attempt.submission_note)}</td></tr>` : ""}
    </table>
    ${stats.flags.length ? `<div style="background:#fef3c7;border:1px solid #f59e0b;padding:8px 12px;margin-bottom:16px"><b>Підозріло:</b><br>${stats.flags.map(esc).join("<br>")}</div>` : ""}
    <h3>Відповіді</h3>
    <table style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="background:#f3f4f6"><th style="padding:6px;border:1px solid #ddd">#</th><th style="padding:6px;border:1px solid #ddd">Питання</th><th style="padding:6px;border:1px solid #ddd">Відповідь</th><th style="padding:6px;border:1px solid #ddd">Результат</th><th style="padding:6px;border:1px solid #ddd">Час</th></tr>
      ${qRows}
    </table>
    <h3>Журнал дій</h3>
    <table style="border-collapse:collapse;font-size:12px;width:100%">${evRows || "<tr><td>Подій немає</td></tr>"}</table>
    <p style="color:#888;font-size:12px">Помаранчевим позначено порушення, що зараховуються до ліміту. Файли роботи студента — у вкладеннях.</p>
  </div>`;

  const subject = `[${lab.title}] ${attempt.student_name}${attempt.student_group ? " " + attempt.student_group : ""}: ${attempt.score ?? 0}/${total}${
    attempt.violations ? `, порушень ${attempt.violations}` : ""
  }${attempt.status !== "finished" ? ` (${statusText.toLowerCase()})` : ""}`;

  return { subject, html };
}

export function buildStudentReport({ attempt, lab }) {
  const questions = attempt.questions || [];
  const answers = attempt.answers || [];
  const total = questions.length;
  const score = attempt.score ?? 0;
  const statusText = {
    finished: "Тест завершено",
    terminated: "Тест закрито через порушення правил",
    abandoned: "Тест закрито через неактивність",
  }[attempt.status] || "Тест завершено";

  const rows = questions
    .map((q, i) => {
      const a = answers[i];
      const mark = !a || a.missed ? "— без відповіді" : a.choice === null ? "⏱ час вийшов" : a.correct ? "✅ правильно" : "❌ неправильно";
      return `<tr>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top">${i + 1}</td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top">${esc(q.question)}</td>
        <td style="padding:6px;border:1px solid #ddd;vertical-align:top;white-space:nowrap">${mark}</td>
      </tr>`;
    })
    .join("");

  const html = `<div style="font-family:Arial,sans-serif;max-width:720px;color:#111">
    <p>Вітаємо, ${esc(attempt.student_name)}!</p>
    <p>${statusText}: <b>${esc(lab.title)}</b>.</p>
    <p style="font-size:28px;margin:12px 0"><b>${score} з ${total}</b> <span style="color:#555;font-size:16px">(${total ? Math.round((score / total) * 100) : 0}%)</span></p>
    ${attempt.violations ? `<p>Зафіксовано порушень: <b>${attempt.violations}</b>. Деталі передано викладачу.</p>` : ""}
    <table style="border-collapse:collapse;font-size:14px;width:100%">
      <tr style="background:#f3f4f6"><th style="padding:6px;border:1px solid #ddd">#</th><th style="padding:6px;border:1px solid #ddd">Питання</th><th style="padding:6px;border:1px solid #ddd">Результат</th></tr>
      ${rows}
    </table>
    <p style="color:#888;font-size:12px">Результат і журнал проходження також надіслано викладачу. Остаточну оцінку виставляє викладач.</p>
  </div>`;

  return { subject: `Результат тесту: ${lab.title} — ${score}/${total}`, html };
}

export function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

/** attachments: [{name, data(Buffer)}] */
export async function sendMail({ to, subject, html, attachments = [] }) {
  const from = process.env.MAIL_FROM || "Lab Check <onboarding@resend.dev>";

  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        html,
        attachments: attachments.map((a) => ({ filename: a.name, content: Buffer.from(a.data).toString("base64") })),
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }

  throw new Error("Пошта не налаштована (RESEND_API_KEY)");
}
