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
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  checkbox: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.2l2.5 2.5 4.6-5"/>',
  indent: '<path d="M10 6h10M10 12h10M10 18h10M3.5 8.5 7 12l-3.5 3.5"/>',
  outdent: '<path d="M10 6h10M10 12h10M10 18h10M7 8.5 3.5 12 7 15.5"/>',
  bold: '<path d="M7 4.5h6.5a3.75 3.75 0 0 1 0 7.5H7zM7 12h7.5a3.75 3.75 0 0 1 0 7.5H7z"/>',
  italic: '<path d="M14 4.5h5M5 19.5h5M15.5 4.5l-7 15"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  redo: '<path d="M15 14l4.5-4.5L15 5"/><path d="M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5h6V7"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  send: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}
