(function initI18n(root) {
  const messages = typeof module === "object" && module.exports
    ? require("./locales/en.js") : root.CodexEnglish;
  const normalizeLanguage = (value) => value === "en" ? "en" : "zh-CN";
  let language = "zh-CN";
  const format = (text, values) => text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);

  // Only application-owned strings use this function. Account names, paths and
  // other user data are passed as values and never translated.
  function translate(locale, source, ...values) {
    if (typeof source !== "string") return source ?? "";
    const text = normalizeLanguage(locale) === "en" ? messages[source] ?? source : source;
    return format(text, values);
  }
  const t = (source, ...values) => translate(language, source, ...values);

  function apply(rootNode = root.document) {
    if (!rootNode) return;
    rootNode.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      rootNode.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      });
    }
  }

  function setLanguage(value) {
    const next = normalizeLanguage(value);
    const changed = language !== next;
    language = next;
    if (root.document) {
      root.document.documentElement.lang = language;
      try { root.localStorage.setItem("codexauth.language", language); } catch {}
      if (changed) {
        apply();
        root.document.dispatchEvent(new CustomEvent("languagechange"));
      }
    }
    return changed;
  }

  const api = { t, translate, normalizeLanguage, setLanguage, apply, getLanguage: () => language, locale: () => language === "en" ? "en-US" : "zh-CN" };
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.CodexI18n = api;
    try { language = normalizeLanguage(root.localStorage.getItem("codexauth.language")); } catch {}
    root.document.documentElement.lang = language;
    apply();
  }
})(typeof window === "object" ? window : globalThis);
