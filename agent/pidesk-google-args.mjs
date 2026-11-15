// Gemini's partialArgs are JSON-path edits, not complete function calls. Build JSON text so
// arbitrary object keys remain data (including __proto__), and never execute a partial call.
const invalid = () => new Error('Google stream contained malformed or unfinished tool arguments');
const step = /\.([^.[\]{}\s]+)|\[(0|[1-9]\d*)\]|\[("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]|(\[\]|\{\})/gy;
function pathSteps(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) throw invalid();
  const keys = []; let marker = null, pos = 1;
  while (pos < path.length) {
    step.lastIndex = pos;
    const m = step.exec(path);
    if (!m || marker) throw invalid();
    pos = step.lastIndex;
    if (m[1] !== undefined) keys.push(m[1]);
    else if (m[2] !== undefined) keys.push(Number(m[2]));
    else if (m[3] !== undefined) {
      const quoted = m[3].startsWith("'") ? '"' + m[3].slice(1, -1).replace(/\\'|"/g, c => c === "\\'" ? "'" : '\\"') + '"' : m[3];
      try { keys.push(JSON.parse(quoted)); } catch { throw invalid(); }
    } else marker = m[4];
  }
  if (!keys.length || typeof keys[0] !== 'string') throw invalid();
  return { keys, marker };
}
export class GooglePartialArgs {
  path = [];
  members = [new Set()];
  pending = null;
  fragments = [];
  feed(arg) {
    const { keys, marker } = pathSteps(arg.jsonPath);
    const fields = ['stringValue', 'boolValue', 'numberValue', 'nullValue'].filter(k => Object.hasOwn(arg, k));
    if (marker ? fields.length : fields.length !== 1) throw invalid();
    if (marker && !arg.willContinue && !this.pending && keys.length <= this.path.length && keys.every((k, i) => k === this.path[i])) {
      if ((this.members[keys.length] instanceof Set) !== (marker === '{}')) throw invalid();
      let chunk = '';
      while (this.path.length >= keys.length) { chunk += this.members.pop() instanceof Set ? '}' : ']'; this.path.pop(); }
      this.fragments.push(chunk); return chunk;
    }
    const field = fields[0];
    const value = marker ? (marker === '[]' ? [] : {}) : field === 'nullValue' ? null : arg[field];
    if ((field === 'stringValue' && typeof value !== 'string') || (field === 'boolValue' && typeof value !== 'boolean') ||
      (field === 'numberValue' && (typeof value !== 'number' || !Number.isFinite(value))) || (arg.willContinue && typeof value !== 'string')) throw invalid();
    const encoded = JSON.stringify(value);
    let chunk;
    if (this.pending) {
      if (keys.length !== this.pending.length || !keys.every((k, i) => k === this.pending[i]) || typeof value !== 'string') throw invalid();
      chunk = arg.willContinue ? encoded.slice(1, -1) : encoded.slice(1);
    } else {
      const out = this.fragments.length ? [] : ['{'];
      let common = 0;
      while (common < this.path.length && common < keys.length - 1 && this.path[common] === keys[common]) common++;
      while (this.path.length > common) { out.push(this.members.pop() instanceof Set ? '}' : ']'); this.path.pop(); }
      for (let depth = common; depth < keys.length; depth++) {
        const key = keys[depth], owner = this.members.at(-1);
        if (owner instanceof Set) {
          if (typeof key !== 'string' || owner.has(key)) throw invalid();
          out.push((owner.size ? ', ' : '') + JSON.stringify(key) + ': '); owner.add(key);
        } else {
          if (key !== owner) throw invalid();
          out.push(owner ? ', ' : ''); this.members[this.members.length - 1]++;
        }
        if (depth === keys.length - 1) out.push(arg.willContinue ? encoded.slice(0, -1) : encoded);
        else { const array = typeof keys[depth + 1] === 'number'; out.push(array ? '[' : '{'); this.path.push(key); this.members.push(array ? 0 : new Set()); }
      }
      chunk = out.join('');
    }
    this.pending = arg.willContinue ? keys : null;
    this.fragments.push(chunk);
    return chunk;
  }
  finish() {
    if (this.pending) throw invalid();
    const suffix = this.fragments.length ? [...this.members].reverse().map(m => m instanceof Set ? '}' : ']').join('') : '{}';
    const raw = this.fragments.join('') + suffix;
    let args;
    try { args = JSON.parse(raw); } catch { throw invalid(); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
    return { suffix, args };
  }
}
