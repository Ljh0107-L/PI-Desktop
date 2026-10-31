// Strict JSONL framing for the Pi RPC protocol: records split on LF only.
// Node's readline also splits on U+2028/U+2029, which may appear inside JSON strings.
import { StringDecoder } from 'node:string_decoder';

export function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const onData = chunk => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  };
  stream.on('data', onData);
  return () => stream.off('data', onData);
}

export const serializeJsonLine = value => JSON.stringify(value) + '\n';
