// Loading screen — multi-item status lines + single progress bar.

const el = document.getElementById('loading-screen');
const bar = document.getElementById('loading-progress-bar');
const itemsEl = document.getElementById('loading-items');

let totalItems = 0;
let doneCount = 0;

export function loadingInit(items) {
  totalItems = items.length;
  doneCount = 0;
  document.body.style.overflow = 'hidden';
  if (bar) bar.style.width = '0%';
  if (itemsEl) {
    itemsEl.innerHTML = items.map(item =>
      `<div class="loading-item" data-id="${item.id}">
        <span class="loading-item-label">${item.label}</span>
        <span class="loading-item-status">Waiting…</span>
      </div>`
    ).join('');
  }
}

export function loadingSetItemStatus(id, status) {
  const item = itemsEl?.querySelector(`.loading-item[data-id="${id}"]`);
  if (!item) return;
  const el = item.querySelector('.loading-item-status');
  if (!el) return;

  el.textContent = status;

  item.classList.remove('loading-item-waiting', 'loading-item-loading', 'loading-item-done');
  if (status === 'Waiting…') {
    item.classList.add('loading-item-waiting');
  } else if (status === 'Done') {
    item.classList.add('loading-item-done');
    doneCount++;
    const pct = totalItems > 0 ? Math.round((doneCount / totalItems) * 100) : 0;
    if (bar) bar.style.width = `${pct}%`;
  } else {
    item.classList.add('loading-item-loading');
  }
}

export function loadingItemDone(id) {
  loadingSetItemStatus(id, 'Done');
}

export function loadingSetProgress(pct) {
  if (bar) bar.style.width = `${Math.round(pct)}%`;
}

export function loadingDone() {
  document.body.style.overflow = '';
  if (el) {
    el.classList.add('loading-hidden');
    setTimeout(() => el.remove(), 800);
  }
}
