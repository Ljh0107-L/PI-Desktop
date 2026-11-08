// Display-only projection; provider replay metadata remains in Pi's original messages.
export function stripMessageSignatures(message) {
  if (!message || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(block => {
    if (!block || typeof block !== 'object') return block;
    const { thinkingSignature, textSignature, thoughtSignature, ...visible } = block;
    return visible;
  }) };
}

export function historyEvent(event) {
  if (event.type === 'message_update') {
    const { partial, message, ...delta } = event.assistantMessageEvent ?? {};
    if (delta.toolCall) {
      const { thoughtSignature, ...call } = delta.toolCall;
      delta.toolCall = call;
    }
    return { type: event.type, assistantMessageEvent: delta };
  }
  if (event.type === 'message_start' || event.type === 'message_end') {
    if (event.message?.role === 'system') return null;
    return { ...event, message: stripMessageSignatures(event.message) };
  }
  if (event.type === 'agent_end') return { type: event.type };
  return event;
}
