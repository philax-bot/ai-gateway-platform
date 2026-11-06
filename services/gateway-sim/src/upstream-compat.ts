/** Adapt the public OpenAI request to the selected upstream, after trusted admission. */
export function adaptUpstreamChatRequest(target: URL, request: Record<string, unknown>): Record<string, unknown> {
  // Match the controlled route, not a client-supplied logical model name.
  // Other OpenAI-compatible upstreams may require developer and max_completion_tokens.
  if (target.hostname !== 'api.deepseek.com') return request;

  const adapted = { ...request };
  if (Array.isArray(request.messages)) {
    adapted.messages = request.messages.map((message: Record<string, unknown>) => {
      if (message.role !== 'developer' && message.role !== 'system') return message;
      // DeepSeek accepts system instructions as a string, including instructions
      // sent by OpenAI clients as an array of text parts.
      const content = Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')
        ? message.content.map((part: { text: string }) => part.text).join('\n')
        : message.content;
      return { ...message, role: 'system', content };
    });
  }
  if (request.max_completion_tokens !== undefined) {
    adapted.max_tokens = request.max_completion_tokens;
    delete adapted.max_completion_tokens;
  }
  return adapted;
}
