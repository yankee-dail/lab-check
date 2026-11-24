import AdmZip from "adm-zip";
import mammoth from "mammoth";
import path from "node:path";

const MAX_TEXT_CHARS = 250_000;

const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.idea|\.vscode|__pycache__|\.venv|venv|bin|obj|build|dist|target|out|\.gradle|\.next|__MACOSX)(\/|$)/i;

const TEXT_EXT = new Set([
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java", ".kt", ".kts", ".py", ".ipynb", ".js", ".jsx", ".ts", ".tsx",
  ".go", ".rs", ".rb", ".php", ".swift", ".m", ".scala", ".pas", ".dpr", ".lpr", ".vb", ".lua", ".r", ".jl",
  ".sql", ".html", ".htm", ".css", ".scss", ".vue", ".svelte", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini",
  ".md", ".txt", ".csv", ".sh", ".bat", ".ps1", ".asm", ".s", ".hs", ".ml", ".fs", ".dart", ".pl", ".tex",
  ".gradle", ".cmake", ".makefile", ".mk", ".dockerfile", ".csproj", ".sln", ".pro", ".qml", ".ui",
]);

function isProbablyText(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4000));
  let bad = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / Math.max(sample.length, 1) < 0.05;
}

function stripXml(xml) {
  return xml
    .replace(/<a:br\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pptxText(buf) {
  const zip = new AdmZip(buf);
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/\d+/)[0]) - Number(b.entryName.match(/\d+/)[0]));
  return slides.map((s, i) => `--- Слайд ${i + 1} ---\n${stripXml(s.getData().toString("utf8"))}`).join("\n\n");
}

function ipynbText(buf) {
  try {
    const nb = JSON.parse(buf.toString("utf8"));
    return (nb.cells || [])
      .map((c) => `# [${c.cell_type}]\n${Array.isArray(c.source) ? c.source.join("") : c.source || ""}`)
      .join("\n\n");
  } catch {
    return buf.toString("utf8");
  }
}

/**
 * Converts one uploaded file into parts the question generator can use.
 * Returns { texts: [{name, text}], pdfs: [{name, data}], skipped: [name] }.
 */
export async function extractFile(name, buf, depth = 0) {
  const out = { texts: [], pdfs: [], skipped: [] };
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name).toLowerCase();

  try {
    if (ext === ".pdf") {
      out.pdfs.push({ name, data: buf });
    } else if (ext === ".zip" && depth < 2) {
      const zip = new AdmZip(buf);
      for (const e of zip.getEntries()) {
        if (e.isDirectory || SKIP_DIRS.test(e.entryName)) continue;
        if (e.header.size > 5 * 1024 * 1024) {
          out.skipped.push(`${name}/${e.entryName}`);
          continue;
        }
        const inner = await extractFile(`${name}/${e.entryName}`, e.getData(), depth + 1);
        out.texts.push(...inner.texts);
        out.pdfs.push(...inner.pdfs);
        out.skipped.push(...inner.skipped);
      }
    } else if (ext === ".docx") {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      out.texts.push({ name, text: value });
    } else if (ext === ".pptx") {
      out.texts.push({ name, text: pptxText(buf) });
    } else if (ext === ".ipynb") {
      out.texts.push({ name, text: ipynbText(buf) });
    } else if (TEXT_EXT.has(ext) || base === "makefile" || base === "dockerfile" || isProbablyText(buf)) {
      out.texts.push({ name, text: buf.toString("utf8") });
    } else {
      out.skipped.push(name);
    }
  } catch (err) {
    console.warn("extract failed", name, err.message);
    out.skipped.push(name);
  }
  return out;
}

/** Joins extracted text parts into one string, marking (not hiding) any cut. */
export function joinTexts(texts) {
  let total = "";
  let truncated = false;
  for (const t of texts) {
    const block = `===== Файл: ${t.name} =====\n${t.text.trim()}\n\n`;
    if (total.length + block.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - total.length;
      if (room > 500) total += block.slice(0, room) + "\n[... файл обрізано через розмір ...]\n";
      truncated = true;
      break;
    }
    total += block;
  }
  return { text: total, truncated };
}
