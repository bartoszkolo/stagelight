const REPO = "bartoszkolo/stagelight";
const $ = (s, el = document) => el.querySelector(s);

// Nav gets a hairline once you scroll.
const nav = $(".nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

// Sections fade in as they come into view.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll("section .wrap > *, .steps li, .grid article, .platform").forEach((el) => {
  el.classList.add("reveal");
  io.observe(el);
});

// Point the main button straight at the right installer for this visitor.
function detectOS() {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return { os: "mobile" };
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return { os: "windows", label: "Windows" };
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return { os: "mac", label: "macOS" };
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return { os: "linux", label: "Linux" };
  return { os: "unknown" };
}

async function pickInstaller() {
  const { os, label } = detectOS();
  const card = $(`.platform[data-os="${os}"]`);
  const hero = $("#heroDownload");
  if (os === "mobile") {
    $("#heroPlatform").textContent = "A desktop app for Windows, macOS and Linux. Try the demo on your phone!";
    return;
  }
  if (!card) return;
  card.classList.add("mine");
  let link = card.querySelector(".btn.primary").href;
  // Apple Silicon vs Intel: high-entropy hints are available in Chromium browsers; Safari can't tell,
  // so it keeps the Apple Silicon default (every Mac sold since 2023) and shows both buttons.
  if (os === "mac" && navigator.userAgentData?.getHighEntropyValues) {
    try {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(["architecture"]);
      if (architecture === "x86") link = card.querySelectorAll(".btn")[1].href;
    } catch {}
  }
  hero.href = link;
  hero.textContent = `Download for ${label}`;
  $("#heroPlatform").innerHTML = `Free · also for <a href="#download">other systems</a>`;
}
pickInstaller();

// Live star count and latest version from GitHub (best effort: the page works without it).
fetch(`https://api.github.com/repos/${REPO}`).then((r) => r.ok && r.json()).then((repo) => {
  if (repo && repo.stargazers_count >= 10) $("#stars").textContent = `${repo.stargazers_count.toLocaleString("en")} stars`;
}).catch(() => {});
fetch(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => r.ok && r.json()).then((rel) => {
  if (rel && rel.tag_name) $("#version").textContent = rel.tag_name.replace(/^v/, "");
}).catch(() => {});

// Until the Buy Me a Coffee page exists, don't show a dead link.
const bmc = $("#bmc");
if (bmc.href.includes("BMC_USERNAME")) bmc.hidden = true;
