const KEY = 'pidesk.appearance';

export function readAppearance() {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export function applyAppearance(value) {
  const theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* Appearance still works without storage. */ }
  return theme;
}
