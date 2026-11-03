// Cursor model settings as the desktop shows them. Only what Cursor advertises for the model is
// offered; the mode is never shown (conversations always run in Agent mode).
export const cursorThought = options => (options ?? []).find(option => option.category === 'thought_level' && option.type === 'select');
export const cursorValues = option => option?.type === 'boolean'
  ? [{ value: true, name: 'On' }, { value: false, name: 'Off' }]
  : (option?.options ?? []).flatMap(value => value.options ?? [value]);
// Settings besides reasoning effort (e.g. Fast), shown next to it.
export const cursorOtherSettings = options => (options ?? []).filter(option => ['select', 'boolean'].includes(option.type)
  && option.category !== 'thought_level' && option.category !== 'model' && option.id !== 'model' && option.category !== 'mode' && option.id !== 'mode');
export const effortLevels = option => cursorValues(option).map(value => ({ value: value.value, label: value.name || String(value.value) }));

// The settings Cursor listed for a model before any conversation used it (Settings → Cursor SDK).
export const cursorModelOptions = (cursorSettings, modelId) => cursorSettings?.models?.find(model => model.id === modelId)?.configOptions ?? null;
// A new conversation's effort: the draft's choice when the model offers it, else Cursor's default.
export function draftCursorEffort(cursorSettings, modelId, chosen) {
  const thought = cursorThought(cursorModelOptions(cursorSettings, modelId));
  if (!thought) return null;
  const values = cursorValues(thought);
  return values.some(value => value.value === chosen) ? chosen : thought.currentValue ?? values[0]?.value ?? null;
}
