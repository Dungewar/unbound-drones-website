// Scroll progress + nav active-state + smooth scroll-to-section.
//
// Scroll progress runs 0 → 1 from the top of the page to the start of
// #features, so the drone finishes landing as the Vision section comes in.

let scrollProgress = 0;
const navLinks = document.querySelectorAll('.nav-link');
const sectionIds = Array.from(navLinks).map(l => l.dataset.section);
let cleanupUI = null;

export function getScrollProgress() {
  return scrollProgress;
}

export function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function updateScrollProgress() {
  const contact = document.getElementById('contact');
  const endY = contact
    ? contact.offsetTop
    : (document.documentElement.scrollHeight - window.innerHeight);
  scrollProgress = endY > 0
    ? Math.max(0, Math.min(1, window.scrollY / endY))
    : 0;
}

function updateNavActive() {
  let active = sectionIds[0];
  for (const id of sectionIds) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top < window.innerHeight * 0.6) active = id;
  }
  for (const link of navLinks) {
    link.classList.toggle('active', link.dataset.section === active);
  }
}

export function initUI() {
  cleanupUI?.();
  history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  updateScrollProgress();
  updateNavActive();

  const handleScroll = () => {
    updateScrollProgress();
    updateNavActive();
  };
  window.addEventListener('scroll', handleScroll, { passive: true });

  // Wire nav buttons (replaces inline onclick handlers)
  const buttonHandlers = [];
  for (const btn of navLinks) {
    const handler = () => scrollToSection(btn.dataset.section);
    buttonHandlers.push([btn, handler]);
    btn.addEventListener('click', handler);
  }

  cleanupUI = () => {
    window.removeEventListener('scroll', handleScroll);
    for (const [btn, handler] of buttonHandlers) {
      btn.removeEventListener('click', handler);
    }
  };

  return cleanupUI;
}
