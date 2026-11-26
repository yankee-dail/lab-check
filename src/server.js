import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, q, migrate } from "./db.js";
import { extractFile, joinTexts } from "./extract.js";
import { generateQuestions } from "./generate.js";
import { buildReport, buildStudentReport, sendMail, mailConfigured } from "./mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const TEACHER_EMAIL = process.env.TEACHER_EMAIL || "";
const GRACE_MS = 3000; // network latency allowance per question
const ABANDON_MINUTES = 10;
// assistant_hotkey: global shortcuts of desktop assistants (Option+Space, double Cmd/Option, …)
const COUNTED = new Set(["tab_hidden", "window_blur", "fullscreen_exit", "assistant_hotkey"]);
const LOGGED = new Set([
  ...COUNTED,
  "copy_attempt", "paste_attempt", "context_menu", "devtools_key", "print_attempt", "printscreen_key",
  "select_all", "resize", "reload", "fullscreen_enter", "key_press",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
});

const fixName = (n) => Buffer.from(n, "latin1").toString("utf8"); // multer decodes names as latin1

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : "Помилка сервера" });
  });

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// ---------- rate limit (per IP, submissions) ----------
const hits = new Map();
function rateLimit(ip, max = 8, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

// ---------- public: labs ----------
app.get(
  "/api/labs",
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT id, title, description, question_count, seconds_per_question, max_violations
       FROM labs WHERE active ORDER BY created_at DESC`,
    );
    res.json(rows);
  }),
);

// ---------- student: submit work ----------
app.post(
  "/api/attempts",
  upload.array("files", 30),
  wrap(async (req, res) => {
    const labId = Number(req.body.labId);
    const name = String(req.body.name || "").trim().slice(0, 120);
    const group = String(req.body.group || "").trim().slice(0, 40);
    const email = String(req.body.email || "").trim().toLowerCase().slice(0, 200);
    if (!name || name.split(/\s+/).length < 2) throw httpError(400, "Вкажіть прізвище та ім'я");
    if (!EMAIL_RE.test(email)) throw httpError(400, "Вкажіть коректний email — на нього прийде результат");
    if (!req.files?.length) throw httpError(400, "Додайте файли лабораторної");
    if (!rateLimit(req.ip)) throw httpError(429, "Забагато спроб з цього пристрою. Спробуйте пізніше.");

    const { rows: labs } = await q(`SELECT * FROM labs WHERE id=$1 AND active`, [labId]);
    const lab = labs[0];
    if (!lab) throw httpError(404, "Лабораторну не знайдено");

    const texts = [];
    const pdfs = [];
    const skipped = [];
    for (const f of req.files) {
      const r = await extractFile(fixName(f.originalname), f.buffer);
      texts.push(...r.texts);
      pdfs.push(...r.pdfs);
      skipped.push(...r.skipped);
    }
    const joined = joinTexts(texts);
    if (!joined.text.trim() && !pdfs.length) throw httpError(400, "Не вдалося прочитати жодного файлу. Завантажте код, .zip, .pdf або .docx.");

    const noteParts = [`${req.files.length} файл(ів), ${texts.length} текстових, ${pdfs.length} PDF`];
    if (skipped.length) noteParts.push(`пропущено: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "…" : ""}`);
    if (joined.truncated) noteParts.push("робота дуже велика — частину тексту обрізано");

    const token = crypto.randomBytes(24).toString("base64url");
    const { rows } = await q(
      `INSERT INTO attempts (token, lab_id, student_name, student_group, student_email, ip, user_agent, submission_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [token, lab.id, name, group, email, req.ip, String(req.get("user-agent") || "").slice(0, 300), noteParts.join("; ")],
    );
    const attemptId = rows[0].id;
    for (const f of req.files) {
      await q(`INSERT INTO attempt_files (attempt_id, name, mime, data) VALUES ($1,$2,$3,$4)`, [
        attemptId, fixName(f.originalname), f.mimetype || "application/octet-stream", f.buffer,
      ]);
    }

    res.json({ token });

    // generate in background; the test page polls the state
    (async () => {
      try {
        const { rows: lf } = await q(`SELECT name, mime, data, extracted_text FROM lab_files WHERE lab_id=$1 ORDER BY id`, [lab.id]);
        const lectureText = [lab.lecture_text, ...lf.filter((f) => f.extracted_text).map((f) => `===== ${f.name} =====\n${f.extracted_text}`)]
          .filter(Boolean)
          .join("\n\n");
        const questions = await generateQuestions({
          labTitle: lab.title,
          labDescription: lab.description,
          lecture: { text: lectureText, pdfs: lf.filter((f) => f.mime === "application/pdf").map((f) => ({ name: f.name, data: f.data })) },
          submission: { text: joined.text, pdfs },
          count: lab.question_count,
        });
        await q(`UPDATE attempts SET status='ready', questions=$2, last_activity=now() WHERE id=$1`, [attemptId, JSON.stringify(questions)]);
      } catch (err) {
        console.error("generation failed", attemptId, err);
        await q(`UPDATE attempts SET status='failed', error=$2 WHERE id=$1`, [attemptId, String(err.message || err).slice(0, 500)]);
      }
    })();
  }),
);

// ---------- attempt helpers ----------
async function withAttempt(token, fn) {
  const client = await pool.connect();
  let finalizeId = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT a.*, l.title AS lab_title, l.seconds_per_question, l.max_violations, l.question_count
       FROM attempts a JOIN labs l ON l.id=a.lab_id WHERE a.token=$1 FOR UPDATE OF a`,
      [token],
    );
    if (!rows[0]) throw httpError(404, "Спробу не знайдено");
    const ctx = { finalize: (id) => (finalizeId = id) };
    const result = await fn(client, rows[0], ctx);
    await client.query("COMMIT");
    if (finalizeId) sendReport(finalizeId).catch((e) => console.error("report failed", e));
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const logEvent = (db, attemptId, type, detail = "", counted = false, qi = null) =>
  db.query(`INSERT INTO events (attempt_id, type, detail, counted, question_index) VALUES ($1,$2,$3,$4,$5)`, [
    attemptId, type, String(detail).slice(0, 300), counted, qi,
  ]);

async function closeAttempt(db, a, status, ctx, detail = "") {
  const answers = a.answers || [];
  const questions = a.questions || [];
  // unanswered questions count as missed
  while (answers.length < questions.length) answers.push({ choice: null, ms: null, correct: false, missed: true });
  const score = answers.filter((x) => x.correct).length;
  await db.query(
    `UPDATE attempts SET status=$2, answers=$3, score=$4, finished_at=now(), served_at=NULL, last_activity=now() WHERE id=$1`,
    [a.id, status, JSON.stringify(answers), score],
  );
  await logEvent(db, a.id, status, detail);
  ctx.finalize(a.id);
  return score;
}

/** Applies server-side timeouts; returns the attempt state after them. */
async function advanceTimeouts(db, a, ctx) {
  if (a.status !== "in_progress") return a;
  const limit = a.seconds_per_question * 1000 + GRACE_MS;
  const answers = a.answers || [];
  let idx = a.current_index;
  let servedAt = a.served_at ? new Date(a.served_at).getTime() : null;
  let changed = false;
  while (servedAt && Date.now() - servedAt > limit && idx < a.questions.length) {
    answers[idx] = { choice: null, ms: null, correct: false, timeout: true };
    await logEvent(db, a.id, "timeout", "", false, idx);
    idx++;
    servedAt = null; // next question is not served until the client asks for it
    changed = true;
  }
  if (!changed) return a;
  await db.query(`UPDATE attempts SET answers=$2, current_index=$3, served_at=NULL WHERE id=$1`, [a.id, JSON.stringify(answers), idx]);
  const next = { ...a, answers, current_index: idx, served_at: null };
  if (idx >= a.questions.length) {
    next.score = await closeAttempt(db, next, "finished", ctx);
    next.status = "finished";
  }
  return next;
}

function publicState(a) {
  const total = a.questions?.length || a.question_count;
  return {
    status: a.status,
    error: a.status === "failed" ? "Не вдалося скласти тест по цих файлах. Спробуйте ще раз або зверніться до викладача." : undefined,
    labTitle: a.lab_title,
    studentName: a.student_name,
    total,
    index: a.current_index,
    secondsPerQuestion: a.seconds_per_question,
    maxViolations: a.max_violations,
    violations: a.violations,
    score: ["finished", "terminated", "abandoned"].includes(a.status) ? a.score : undefined,
  };
}

// ---------- student: test flow ----------
app.get(
  "/api/attempts/:token",
  wrap(async (req, res) => {
    const state = await withAttempt(req.params.token, async (db, a, ctx) => publicState(await advanceTimeouts(db, a, ctx)));
    res.json(state);
  }),
);

app.post(
  "/api/attempts/:token/start",
  wrap(async (req, res) => {
    const state = await withAttempt(req.params.token, async (db, a) => {
      if (a.status === "ready") {
        await db.query(`UPDATE attempts SET status='in_progress', started_at=now(), last_activity=now() WHERE id=$1`, [a.id]);
        await logEvent(db, a.id, "started");
        a.status = "in_progress";
      } else if (a.status === "in_progress") {
        await logEvent(db, a.id, "reload", "Повернувся до тесту після перезавантаження/закриття сторінки", false, a.current_index);
      }
      return publicState(a);
    });
    res.json(state);
  }),
);

app.post(
  "/api/attempts/:token/question",
  wrap(async (req, res) => {
    const out = await withAttempt(req.params.token, async (db, a0, ctx) => {
      const a = await advanceTimeouts(db, a0, ctx);
      if (a.status !== "in_progress") return { done: true, state: publicState(a) };
      let servedAt = a.served_at ? new Date(a.served_at) : null;
      if (!servedAt) {
        servedAt = new Date();
        await db.query(`UPDATE attempts SET served_at=$2, last_activity=now() WHERE id=$1`, [a.id, servedAt]);
      } else {
        await db.query(`UPDATE attempts SET last_activity=now() WHERE id=$1`, [a.id]);
      }
      const qn = a.questions[a.current_index];
      const remainingMs = Math.max(0, a.seconds_per_question * 1000 - (Date.now() - servedAt.getTime()));
      return {
        done: false,
        index: a.current_index,
        total: a.questions.length,
        question: qn.question,
        code: qn.code_snippet,
        options: qn.options,
        remainingMs,
        violations: a.violations,
      };
    });
    res.json(out);
  }),
);

app.post(
  "/api/attempts/:token/answer",
  wrap(async (req, res) => {
    const index = Number(req.body.index);
    const choice = req.body.choice === null ? null : Number(req.body.choice);
    const out = await withAttempt(req.params.token, async (db, a0, ctx) => {
      const a = await advanceTimeouts(db, a0, ctx);
      if (a.status !== "in_progress") return { done: true, state: publicState(a) };
      if (index !== a.current_index || !a.served_at) return { stale: true };
      const ms = Date.now() - new Date(a.served_at).getTime();
      const valid = Number.isInteger(choice) && choice >= 0 && choice < 4;
      const answers = a.answers || [];
      answers[index] = { choice: valid ? choice : null, ms, correct: valid && choice === a.questions[index].correct };
      const nextIdx = index + 1;
      await db.query(`UPDATE attempts SET answers=$2, current_index=$3, served_at=NULL, last_activity=now() WHERE id=$1`, [
        a.id, JSON.stringify(answers), nextIdx,
      ]);
      if (nextIdx >= a.questions.length) {
        const score = await closeAttempt(db, { ...a, answers, current_index: nextIdx }, "finished", ctx);
        return { done: true, state: publicState({ ...a, status: "finished", score, current_index: nextIdx }) };
      }
      return { done: false };
    });
    res.json(out);
  }),
);

app.post(
  "/api/attempts/:token/event",
  wrap(async (req, res) => {
    const type = String(req.body.type || "");
    if (!LOGGED.has(type)) throw httpError(400, "bad event");
    const detail = String(req.body.detail || "");
    const out = await withAttempt(req.params.token, async (db, a, ctx) => {
      if (!["ready", "in_progress"].includes(a.status)) return { status: a.status, violations: a.violations };
      let counted = false;
      if (a.status === "in_progress" && COUNTED.has(type)) {
        const last = a.last_violation_at ? new Date(a.last_violation_at).getTime() : 0;
        // blur + visibilitychange + fullscreen exit usually fire together: count one leave per 2 s
        counted = Date.now() - last > 2000;
      }
      await logEvent(db, a.id, type, detail, counted, a.status === "in_progress" ? a.current_index : null);
      let violations = a.violations;
      if (counted) {
        violations++;
        await db.query(`UPDATE attempts SET violations=$2, last_violation_at=now(), last_activity=now() WHERE id=$1`, [a.id, violations]);
        if (violations >= a.max_violations) {
          await closeAttempt(db, { ...a, violations }, "terminated", ctx, `Досягнуто ліміт порушень (${violations})`);
          return { status: "terminated", violations };
        }
      } else if (COUNTED.has(type)) {
        await db.query(`UPDATE attempts SET last_violation_at=now() WHERE id=$1`, [a.id]);
      }
      return { status: a.status, violations, counted };
    });
    res.json(out);
  }),
);

// ---------- report e-mail ----------
async function sendReport(attemptId) {
  const { rows } = await q(`SELECT * FROM attempts WHERE id=$1`, [attemptId]);
  const attempt = rows[0];
  if (!attempt) return;
  const { rows: labs } = await q(`SELECT * FROM labs WHERE id=$1`, [attempt.lab_id]);
  const { rows: events } = await q(`SELECT * FROM events WHERE attempt_id=$1 ORDER BY at, id`, [attemptId]);
  const { rows: files } = await q(`SELECT name, data FROM attempt_files WHERE attempt_id=$1 ORDER BY id`, [attemptId]);
  const { subject, html } = buildReport({ attempt, lab: labs[0], events });

  if (!mailConfigured()) {
    await q(`UPDATE attempts SET email_status=$2 WHERE id=$1`, [attemptId, "пошта не налаштована"]);
    return;
  }

  // student copy: score and right/wrong per question, without the teacher's log or correct answers
  if (attempt.student_email && !attempt.student_email_status?.startsWith("надіслано")) {
    try {
      const s = buildStudentReport({ attempt, lab: labs[0] });
      await sendMail({ to: attempt.student_email, subject: s.subject, html: s.html });
      await q(`UPDATE attempts SET student_email_status='надіслано' WHERE id=$1`, [attemptId]);
    } catch (err) {
      console.error("student mail failed", err);
      await q(`UPDATE attempts SET student_email_status=$2 WHERE id=$1`, [attemptId, ("помилка: " + err.message).slice(0, 300)]);
    }
  }

  if (!TEACHER_EMAIL) {
    await q(`UPDATE attempts SET email_status=$2 WHERE id=$1`, [attemptId, "TEACHER_EMAIL не задано"]);
    return;
  }
  let total = 0;
  const attachments = files.filter((f) => (total += f.data.length) < 30 * 1024 * 1024);
  try {
    await sendMail({ to: TEACHER_EMAIL, subject, html, attachments });
    await q(`UPDATE attempts SET email_status='надіслано' WHERE id=$1`, [attemptId]);
  } catch (err) {
    console.error("mail failed", err);
    await q(`UPDATE attempts SET email_status=$2 WHERE id=$1`, [attemptId, ("помилка: " + err.message).slice(0, 300)]);
  }
}

// abandoned attempts: no activity for ABANDON_MINUTES while in progress
setInterval(async () => {
  try {
    const { rows } = await q(
      `SELECT token FROM attempts WHERE status='in_progress' AND last_activity < now() - ($1 || ' minutes')::interval`,
      [String(ABANDON_MINUTES)],
    );
    for (const { token } of rows) {
      await withAttempt(token, async (db, a0, ctx) => {
        const a = await advanceTimeouts(db, a0, ctx);
        if (a.status === "in_progress") await closeAttempt(db, a, "abandoned", ctx, `Немає активності ${ABANDON_MINUTES} хв`);
      });
    }
  } catch (err) {
    console.error("sweeper", err);
  }
}, 60_000);

// ---------- admin ----------
function requireAdmin(req, res, next) {
  const key = String(req.get("x-admin-key") || "");
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Невірний пароль" });
  }
  next();
}

app.post("/api/admin/login", requireAdmin, (req, res) =>
  res.json({ ok: true, teacherEmail: TEACHER_EMAIL, mail: mailConfigured() }),
);

app.get(
  "/api/admin/labs",
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await q(`
      SELECT l.id, l.title, l.description, l.lecture_text, l.question_count, l.seconds_per_question, l.max_violations, l.active, l.created_at,
        COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'size', length(f.data)) ORDER BY f.id) FROM lab_files f WHERE f.lab_id=l.id), '[]') AS files,
        (SELECT count(*) FROM attempts a WHERE a.lab_id=l.id)::int AS attempts
      FROM labs l ORDER BY l.created_at DESC`);
    res.json(rows);
  }),
);

async function saveLabFiles(labId, files) {
  for (const f of files || []) {
    const name = fixName(f.originalname);
    const r = await extractFile(name, f.buffer);
    const isPdf = path.extname(name).toLowerCase() === ".pdf";
    const text = r.texts.map((t) => `${t.name}:\n${t.text}`).join("\n\n");
    await q(`INSERT INTO lab_files (lab_id, name, mime, data, extracted_text) VALUES ($1,$2,$3,$4,$5)`, [
      labId, name, isPdf ? "application/pdf" : f.mimetype || "application/octet-stream", f.buffer, text,
    ]);
    // a zip with PDFs inside: keep each inner PDF as its own lecture file
    if (!isPdf) {
      for (const p of r.pdfs) {
        await q(`INSERT INTO lab_files (lab_id, name, mime, data) VALUES ($1,$2,'application/pdf',$3)`, [labId, p.name, p.data]);
      }
    }
  }
}

function labFields(body) {
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== "" ? Number(v) : d));
  return {
    title: String(body.title || "").trim().slice(0, 200),
    description: String(body.description || "").trim().slice(0, 5000),
    lecture_text: String(body.lecture_text || "").slice(0, 300000),
    question_count: Math.round(clamp(body.question_count, 3, 20, 10)),
    seconds_per_question: Math.round(clamp(body.seconds_per_question, 15, 180, 40)),
    max_violations: Math.round(clamp(body.max_violations, 1, 10, 3)),
  };
}

app.post(
  "/api/admin/labs",
  requireAdmin,
  upload.array("files", 20),
  wrap(async (req, res) => {
    const f = labFields(req.body);
    if (!f.title) throw httpError(400, "Вкажіть назву");
    const { rows } = await q(
      `INSERT INTO labs (title, description, lecture_text, question_count, seconds_per_question, max_violations)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [f.title, f.description, f.lecture_text, f.question_count, f.seconds_per_question, f.max_violations],
    );
    await saveLabFiles(rows[0].id, req.files);
    res.json({ id: rows[0].id });
  }),
);

app.put(
  "/api/admin/labs/:id",
  requireAdmin,
  upload.array("files", 20),
  wrap(async (req, res) => {
    const f = labFields(req.body);
    if (!f.title) throw httpError(400, "Вкажіть назву");
    await q(
      `UPDATE labs SET title=$2, description=$3, lecture_text=$4, question_count=$5, seconds_per_question=$6, max_violations=$7,
       active=$8 WHERE id=$1`,
      [req.params.id, f.title, f.description, f.lecture_text, f.question_count, f.seconds_per_question, f.max_violations, req.body.active !== "false"],
    );
    await saveLabFiles(req.params.id, req.files);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/admin/labs/:id",
  requireAdmin,
  wrap(async (req, res) => {
    await q(`DELETE FROM labs WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/admin/lab-files/:id",
  requireAdmin,
  wrap(async (req, res) => {
    await q(`DELETE FROM lab_files WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/admin/attempts",
  requireAdmin,
  wrap(async (req, res) => {
    const params = [];
    let where = "";
    if (req.query.lab) {
      params.push(Number(req.query.lab));
      where = "WHERE a.lab_id=$1";
    }
    const { rows } = await q(
      `SELECT a.id, a.lab_id, l.title AS lab_title, a.student_name, a.student_group, a.student_email, a.student_email_status, a.status, a.score,
        jsonb_array_length(COALESCE(a.questions,'[]'::jsonb)) AS total, a.violations, a.email_status, a.error,
        a.created_at, a.started_at, a.finished_at
       FROM attempts a JOIN labs l ON l.id=a.lab_id ${where} ORDER BY a.created_at DESC LIMIT 500`,
      params,
    );
    res.json(rows);
  }),
);

app.get(
  "/api/admin/attempts/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await q(`SELECT a.*, l.title AS lab_title, l.max_violations FROM attempts a JOIN labs l ON l.id=a.lab_id WHERE a.id=$1`, [req.params.id]);
    if (!rows[0]) throw httpError(404, "Не знайдено");
    const { rows: events } = await q(`SELECT type, detail, counted, question_index, at FROM events WHERE attempt_id=$1 ORDER BY at, id`, [req.params.id]);
    const { rows: files } = await q(`SELECT id, name, length(data) AS size FROM attempt_files WHERE attempt_id=$1 ORDER BY id`, [req.params.id]);
    delete rows[0].token;
    res.json({ ...rows[0], events, files });
  }),
);

app.get(
  "/api/admin/files/:id",
  wrap(async (req, res) => {
    // admin key passed as query param so the browser can download directly
    req.headers["x-admin-key"] = String(req.query.key || "");
    requireAdmin(req, res, async () => {
      const { rows } = await q(`SELECT name, mime, data FROM attempt_files WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).end();
      res.setHeader("Content-Type", rows[0].mime);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
      res.end(rows[0].data);
    });
  }),
);

app.post(
  "/api/admin/attempts/:id/resend",
  requireAdmin,
  wrap(async (req, res) => {
    await sendReport(Number(req.params.id));
    const { rows } = await q(`SELECT email_status FROM attempts WHERE id=$1`, [req.params.id]);
    res.json({ email_status: rows[0]?.email_status });
  }),
);

app.delete(
  "/api/admin/attempts/:id",
  requireAdmin,
  wrap(async (req, res) => {
    await q(`DELETE FROM attempts WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  }),
);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Файл завеликий (макс. 25 МБ)" : "Помилка завантаження файлів" });
  }
  next(err);
});

await migrate();
app.listen(PORT, () => console.log(`lab-check listening on ${PORT}`));
