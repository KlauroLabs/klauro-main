const menuButton = document.querySelector("[data-menu-button]");
const nav = document.querySelector("[data-nav]");
const header = document.querySelector(".site-header");
const hero = document.querySelector(".hero");
const parallaxSections = [
  { element: document.querySelector(".benefits"), property: "--benefits-y", strength: 0.06 },
  { element: document.querySelector(".cta"), property: "--cta-y", strength: -0.05 },
].filter((item) => item.element);
const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let parallaxFrame = 0;

menuButton?.addEventListener("click", () => {
  const isOpen = nav?.getAttribute("data-open") === "true";
  nav?.setAttribute("data-open", String(!isOpen));
  menuButton.setAttribute("aria-expanded", String(!isOpen));
});

document.querySelectorAll("a[href^='#']").forEach((link) => {
  link.addEventListener("click", () => {
    nav?.setAttribute("data-open", "false");
    menuButton?.setAttribute("aria-expanded", "false");
  });
});

function updateHeaderState() {
  header?.classList.toggle("is-scrolled", window.scrollY > 8);
}

updateHeaderState();
window.addEventListener("scroll", updateHeaderState, { passive: true });

function updateHeroParallax() {
  parallaxFrame = 0;
  if (motionQuery.matches) return;

  if (hero) {
    const rect = hero.getBoundingClientRect();
    if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
      const offset = Math.max(0, window.scrollY) * 0.12;
      hero.style.setProperty("--hero-y", `${Math.min(offset, 90).toFixed(1)}px`);
    }
  }

  parallaxSections.forEach(({ element, property, strength }) => {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const midpoint = rect.top + rect.height / 2 - window.innerHeight / 2;
    const offset = Math.max(-46, Math.min(46, midpoint * strength));
    element.style.setProperty(property, `${offset.toFixed(1)}px`);
  });
}

function requestHeroParallax() {
  if (parallaxFrame) return;
  parallaxFrame = window.requestAnimationFrame(updateHeroParallax);
}

updateHeroParallax();
window.addEventListener("scroll", requestHeroParallax, { passive: true });
window.addEventListener("resize", requestHeroParallax);
window.addEventListener("load", updateHeroParallax);
