// Line icons (24×24, stroke = currentColor), drawn for NoteDown.
const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sort: '<path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  toc: '<path d="M9 6h11M9 12h11M13 18h7"/><circle cx="4.5" cy="6" r="0.6"/><circle cx="4.5" cy="12" r="0.6"/><circle cx="8.5" cy="18" r="0.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  more: '<circle cx="12" cy="5" r="0.8"/><circle cx="12" cy="12" r="0.8"/><circle cx="12" cy="19" r="0.8"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M16 3v4M8 3v4M3.5 10h17"/>',
};

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}
