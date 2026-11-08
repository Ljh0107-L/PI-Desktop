// Measure a separate textarea: collapsing the focused editor to 'auto' on every
// keystroke changes its scroll geometry and can move the caret and surrounding UI.
export function createComposerSizer(editor) {
  const document = editor.ownerDocument;
  const mirror = document.createElement('textarea');
  mirror.tabIndex = -1;
  mirror.setAttribute('aria-hidden', 'true');
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', height: '0', minHeight: '0', maxHeight: 'none', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' });
  document.body.append(mirror);
  let previous = '';
  return {
    update() {
      if (!editor.clientWidth) return;
      const style = document.defaultView.getComputedStyle(editor);
      const key = JSON.stringify([editor.value, editor.clientWidth, style.font, style.letterSpacing]);
      if (key === previous) return;
      previous = key;
      for (const property of ['font', 'letterSpacing', 'padding', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'textIndent', 'textTransform']) mirror.style[property] = style[property];
      mirror.style.boxSizing = 'border-box';
      mirror.style.border = '0';
      mirror.style.width = `${editor.clientWidth}px`;
      mirror.value = editor.value || ' ';
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const height = Math.min(parseFloat(style.maxHeight) || 240, Math.max(parseFloat(style.minHeight) || 32, Math.ceil(mirror.scrollHeight + border)));
      const value = `${height}px`;
      if (editor.style.height !== value) editor.style.height = value;
    },
    destroy() { mirror.remove(); },
  };
}
