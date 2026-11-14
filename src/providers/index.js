import { ChatProvider } from './chat.js';
import { ResponsesProvider } from './responses.js';

export function createProvider(conn, options = {}) {
  if (conn.providerType === 'responses') return new ResponsesProvider(conn, options);
  return new ChatProvider(conn, options);
}

export { ChatProvider, ResponsesProvider };
export { ProviderError, listModels, pingProvider, normalizeUsage } from './common.js';
