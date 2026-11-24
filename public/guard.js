// Blocks copying, selection, saving and printing of the page.
// The test page sets window.guardReport(type, detail) to log attempts.
(function () {
  const report = (type, detail) => {
    try {
      if (typeof window.guardReport === "function") window.guardReport(type, detail || "");
    } catch (_) {}
  };
  const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    report("context_menu");
  });
  ["copy", "cut"].forEach((t) =>
    document.addEventListener(t, (e) => {
      if (isField(e.target) && !document.body.classList.contains("strict")) return;
      e.preventDefault();
      try {
        e.clipboardData && e.clipboardData.setData("text/plain", "");
      } catch (_) {}
      report("copy_attempt", t);
    }),
  );
  document.addEventListener("paste", (e) => {
    if (isField(e.target) && !document.body.classList.contains("strict")) return;
    e.preventDefault();
    report("paste_attempt");
  });
  document.addEventListener("selectstart", (e) => {
    if (!isField(e.target)) e.preventDefault();
  });
  document.addEventListener("dragstart", (e) => e.preventDefault());

  document.addEventListener(
    "keydown",
    (e) => {
      const k = (e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "F12" || (mod && e.shiftKey && ["i", "j", "c", "k"].includes(k)) || (mod && e.altKey && ["i", "j", "c", "u"].includes(k))) {
        e.preventDefault();
        report("devtools_key", e.key);
        return;
      }
      if (mod && ["s", "p", "u"].includes(k)) {
        e.preventDefault();
        report("print_attempt", "Ctrl+" + k.toUpperCase());
        return;
      }
      if (mod && ["c", "x"].includes(k) && !(isField(e.target) && !document.body.classList.contains("strict"))) {
        e.preventDefault();
        report("copy_attempt", "Ctrl+" + k.toUpperCase());
        return;
      }
      if (mod && k === "a" && !isField(e.target)) {
        e.preventDefault();
        report("select_all");
      }
    },
    true,
  );

  document.addEventListener("keyup", (e) => {
    if (e.key === "PrintScreen") {
      report("printscreen_key");
      try {
        navigator.clipboard && navigator.clipboard.writeText("");
      } catch (_) {}
    }
  });

  window.addEventListener("beforeprint", () => report("print_attempt", "print"));
})();
