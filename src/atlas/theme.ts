export const THEME_KEY = 'atlas:theme'

export const THEME_BUTTON_ID = 'atlas-theme'

export const THEME_SCRIPT = `
'use strict';
(function () {
  const root = document.documentElement;
  const button = document.getElementById('${THEME_BUTTON_ID}');
  const THEMES = ['light', 'dark'];
  let stored = null;
  try { stored = localStorage.getItem('${THEME_KEY}'); } catch (error) { stored = null; }
  if (THEMES.includes(stored)) root.setAttribute('data-theme', stored);
  button.addEventListener('click', () => {
    const current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('${THEME_KEY}', next); } catch (error) { root.setAttribute('data-theme-unsaved', ''); }
  });
})();
`
