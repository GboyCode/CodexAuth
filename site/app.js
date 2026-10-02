import { messages } from "./content.mjs";
const accounts = [
  {
    email: "studio@example.com",
    initials: "S",
    plan: "PLUS",
    session: 82,
    week: 64,
  },
  {
    email: "work@example.com",
    initials: "W",
    plan: "BUSINESS",
    session: 95,
    week: 88,
  },
  {
    email: "personal@example.com",
    initials: "P",
    plan: "PLUS",
    session: 38,
    week: 52,
  },
  {
    email: "research@example.com",
    initials: "R",
    plan: "PRO",
    session: 91,
    week: 76,
  },
  {
    email: "sideproject@example.com",
    initials: "L",
    plan: "PLUS",
    session: 67,
    week: 43,
  },
];
const language = document.documentElement.lang.startsWith("en") ? "en" : "zh";
let activeAccount = 0;
let privateEmails = false;
let switching = false;
let currentPlatform = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "mac"
  : "windows";
let toastTimeout;
const $ = (selector) => document.querySelector(selector);
const message = (key) => messages[language][key];
const emailFor = (account) =>
  privateEmails ? "••••••@example.com" : account.email;

function renderAccounts() {
  $("#saved-account-count").textContent = accounts.length;
  $("#demo-accounts").innerHTML = accounts
    .map(
      (account, index) => `
    <article class="account-row ${index === activeAccount ? "selected" : ""}">
      <span class="account-avatar" aria-hidden="true">${account.initials}</span>
      <div class="account-detail"><div class="account-heading"><strong>${message("names")[index]}</strong><span class="plan-tag">${account.plan}</span></div><span class="account-email">${emailFor(account)}</span></div>
      <div class="account-right"><button class="switch-button" type="button" data-account="${index}" ${index === activeAccount || switching ? "disabled" : ""} aria-label="${message("switch")} ${message("names")[index]}">${index === activeAccount ? message("active") : message("switch")}</button><div class="row-quotas"><span>${message("hours")} ${account.session}%</span><span class="mini-meter" aria-hidden="true"><span style="width:${account.session}%"></span></span><span>${message("week")} ${account.week}%</span></div></div>
    </article>`,
    )
    .join("");
  const account = accounts[activeAccount];
  $("#widget-accounts").innerHTML = accounts
    .map(
      (item, index) => `
    <div class="widget-account-row">
      <div class="widget-account-label"><strong>${message("names")[index]}</strong><small>${index === activeAccount ? message("current") : emailFor(item)} · ${item.plan}</small></div>
      <div class="widget-account-actions"><button type="button" data-account="${index}" class="${index === activeAccount ? "" : "primary"}" ${index === activeAccount || switching ? "disabled" : ""} aria-label="${message("switch")} ${message("names")[index]}">${index === activeAccount ? message("widgetEnabled") : message("switch")}</button><button type="button" data-reauth="${index}" aria-label="${message("reauth")} ${message("names")[index]}">${message("reauth")}</button></div>
    </div>`,
    )
    .join("");
  $("#current-name").textContent = message("names")[activeAccount];
  $("#current-email").textContent = emailFor(account);
  $(".status-bottom .plan-tag").textContent = account.plan;
  $("#widget-name").textContent = emailFor(account);
  $("#widget-quota").textContent = `${message("remaining")}${account.session}%`;
  $("#widget-meter").style.width = `${account.session}%`;
  $("#widget-week-quota").textContent =
    `${message("remaining")}${account.week}%`;
  $("#widget-week-meter").style.width = `${account.week}%`;
  $("#session-value").textContent = `${account.session}%`;
  $("#session-meter").style.width = `${account.session}%`;
  $("#week-value").textContent = `${account.week}%`;
  $("#week-meter").style.width = `${account.week}%`;
  $("#privacy-toggle").setAttribute(
    "aria-label",
    message(privateEmails ? "show" : "hide"),
  );
  $("#privacy-toggle").setAttribute("aria-pressed", String(privateEmails));
}

function showToast(text) {
  clearTimeout(toastTimeout);
  const toast = $("#toast");
  toast.hidden = false;
  toast.querySelector("span").textContent = text;
  toastTimeout = setTimeout(() => {
    toast.hidden = true;
  }, 3800);
}

function setMenu(open, restoreFocus = false) {
  $("#site-nav").classList.toggle("is-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  $("#menu-toggle").setAttribute(
    "aria-label",
    message(open ? "closeMenu" : "menu"),
  );
  if (restoreFocus) $("#menu-toggle").focus();
}

function setPlatform(platform) {
  currentPlatform = platform;
  document
    .querySelectorAll("[data-platform]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.platform === platform),
      ),
    );
  $("#platform-help").textContent = message(platform);
}

function setTab(name, focus = false) {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#panel-${tab.dataset.tab}`).hidden = !selected;
    if (selected && focus) tab.focus();
  });
}

function setWidget(open, focus = false) {
  $("#demo-widget").hidden = !open;
  $("#widget-placeholder").hidden = open;
  $("#widget-toggle").setAttribute("aria-expanded", String(open));
  if (!open) setWidgetSettings(false);
  if (focus) $(open ? "#demo-widget" : "#widget-toggle").focus();
}
function setWidgetSettings(open) {
  $("#widget-settings").hidden = !open;
  $("#widget-settings-toggle").setAttribute("aria-expanded", String(open));
}

$("#language-toggle").addEventListener("click", () => {
  const next = language === "zh" ? "en" : "zh";
  try { localStorage.setItem("codexauth-site-language", next); } catch { /* Optional preference. */ }
  $("#language-toggle").href = `/${next}/${location.search}${location.hash}`;
});
$("#menu-toggle").addEventListener("click", () =>
  setMenu($("#menu-toggle").getAttribute("aria-expanded") !== "true"),
);
$("#site-nav").addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("click", (event) => {
  if (
    !event.target.closest(".site-header") &&
    $("#site-nav").classList.contains("is-open")
  )
    setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if ($("#site-nav").classList.contains("is-open")) setMenu(false, true);
  else if (!$("#widget-settings").hidden) {
    setWidgetSettings(false);
    $("#widget-settings-toggle").focus();
  } else if (document.activeElement.closest("#demo-widget"))
    setWidget(false, true);
});
document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "accounts"
        : event.key === "End"
          ? "usage"
          : tab.dataset.tab === "accounts"
            ? "usage"
            : "accounts";
    setTab(next, true);
  });
});
$("#widget-toggle").addEventListener("click", () =>
  setWidget($("#demo-widget").hidden, true),
);
$("#widget-close").addEventListener("click", () => setWidget(false, true));
$("#widget-reopen").addEventListener("click", () => setWidget(true, true));
$("#widget-settings-toggle").addEventListener("click", () =>
  setWidgetSettings($("#widget-settings").hidden),
);
$("#widget-opacity").addEventListener("input", (event) => {
  $("#demo-widget").style.setProperty(
    "--widget-opacity",
    event.target.value / 100,
  );
  $("#widget-opacity-value").value = `${event.target.value}%`;
});
$("#widget-pin").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const pinned = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(pinned));
  button.setAttribute(
    "aria-label",
    message(pinned ? "widgetUnpin" : "widgetPin"),
  );
  showToast(message(pinned ? "widgetPinOn" : "widgetPinOff"));
});
$("#widget-main").addEventListener("click", () => {
  setTab("accounts", true);
  $(".app-window").scrollIntoView({
    block: "center",
    behavior: reducedMotion.matches ? "instant" : "smooth",
  });
});
$("#widget-restart").addEventListener("click", () =>
  showToast(message("restartHint")),
);
$("#privacy-toggle").addEventListener("click", () => {
  privateEmails = !privateEmails;
  renderAccounts();
});
function switchDemoAccount(event) {
  const button = event.target.closest("[data-account]");
  if (!button || switching || button.disabled) return;
  const next = Number(button.dataset.account);
  const fromWidget = Boolean(button.closest("#widget-accounts"));
  switching = true;
  const row = button.closest(".account-row, .widget-account-row");
  row.setAttribute("aria-busy", "true");
  button.textContent = message("switching");
  button.classList.add("pending");
  document.querySelectorAll("[data-account]").forEach((item) => {
    item.disabled = true;
  });
  setTimeout(() => {
    const restoreFocus =
      document.activeElement === button ||
      document.activeElement === document.body;
    activeAccount = next;
    switching = false;
    renderAccounts();
    if (restoreFocus)
      $(fromWidget ? "#demo-widget" : "#panel-accounts").focus({
        preventScroll: true,
      });
    showToast(message("switched").replace("{name}", message("names")[next]));
  }, 550);
}
$("#demo-accounts").addEventListener("click", switchDemoAccount);
$("#widget-accounts").addEventListener("click", (event) => {
  if (event.target.closest("[data-reauth]")) showToast(message("reauthHint"));
  else switchDemoAccount(event);
});
$("#widget-refresh").addEventListener("click", () =>
  $("#demo-refresh").click(),
);
$("#demo-refresh").addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.classList.add("is-refreshing");
  button.setAttribute("aria-busy", "true");
  setTimeout(() => {
    button.disabled = false;
    button.classList.remove("is-refreshing");
    button.removeAttribute("aria-busy");
    showToast(message("refreshed"));
  }, 650);
});
document
  .querySelectorAll("[data-platform]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      setPlatform(button.dataset.platform),
    ),
  );

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const ambientBackground = $(".ambient-background");
const ambientGlow = $(".ambient-glow");
let ambientFrame = 0;
let pointerX = 0;
let pointerY = 0;
function clearAmbientGlow() {
  cancelAnimationFrame(ambientFrame);
  ambientFrame = 0;
  ambientBackground.classList.remove("is-active");
}
addEventListener("pointermove", (event) => {
  if (reducedMotion.matches || !finePointer.matches || event.pointerType === "touch" || document.hidden) return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (ambientFrame) return;
  ambientFrame = requestAnimationFrame(() => {
    ambientGlow.style.transform = `translate3d(${pointerX - 360}px, ${pointerY - 360}px, 0)`;
    ambientBackground.classList.add("is-active");
    ambientFrame = 0;
  });
}, { passive: true });
document.documentElement.addEventListener("pointerleave", clearAmbientGlow);
addEventListener("blur", clearAmbientGlow);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearAmbientGlow();
});
reducedMotion.addEventListener("change", clearAmbientGlow);
finePointer.addEventListener("change", clearAmbientGlow);
if ("IntersectionObserver" in window) {
  if (!reducedMotion.matches)
    document.documentElement.classList.add("js-motion");
  const reveal = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          reveal.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08 },
  );
  document
    .querySelectorAll("[data-reveal]")
    .forEach((element) => reveal.observe(element));
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        document.querySelectorAll("#site-nav a").forEach((link) => {
          const active = link.hash === `#${entry.target.id}`;
          link.classList.toggle("active", active);
          if (active) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        });
      });
    },
    { rootMargin: "-15% 0px -55% 0px" },
  );
  ["preview", "features", "how-it-works", "faq", "download"].forEach((id) =>
    sectionObserver.observe(document.getElementById(id)),
  );
}
let scrollScheduled = false;
function updateScroll() {
  const range = document.documentElement.scrollHeight - innerHeight;
  $(".reading-progress").style.transform =
    `scaleX(${range > 0 ? scrollY / range : 0})`;
  $(".site-header").classList.toggle("scrolled", scrollY > 20);
  scrollScheduled = false;
}
addEventListener(
  "scroll",
  () => {
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(updateScroll);
    }
  },
  { passive: true },
);
addEventListener(
  "resize",
  () => {
    updateScroll();
    if (innerWidth > 760) setMenu(false);
  },
  { passive: true },
);
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) document.documentElement.classList.remove("js-motion");
});
setMenu(false);
setPlatform(currentPlatform);
renderAccounts();
updateScroll();
