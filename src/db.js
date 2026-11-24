import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1|\.railway\.internal/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS labs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lecture_text TEXT NOT NULL DEFAULT '',
      question_count INT NOT NULL DEFAULT 10,
      seconds_per_question INT NOT NULL DEFAULT 40,
      max_violations INT NOT NULL DEFAULT 3,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS lab_files (
      id SERIAL PRIMARY KEY,
      lab_id INT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      lab_id INT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      student_name TEXT NOT NULL,
      student_group TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'generating',
      error TEXT,
      questions JSONB,
      answers JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_index INT NOT NULL DEFAULT 0,
      served_at TIMESTAMPTZ,
      violations INT NOT NULL DEFAULT 0,
      last_violation_at TIMESTAMPTZ,
      score INT,
      submission_note TEXT NOT NULL DEFAULT '',
      ip TEXT,
      user_agent TEXT,
      email_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS attempts_lab_idx ON attempts(lab_id);
    CREATE INDEX IF NOT EXISTS attempts_status_idx ON attempts(status);

    CREATE TABLE IF NOT EXISTS attempt_files (
      id SERIAL PRIMARY KEY,
      attempt_id INT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      attempt_id INT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      counted BOOLEAN NOT NULL DEFAULT FALSE,
      question_index INT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_attempt_idx ON events(attempt_id);
  `);
}
