// Messages between the content script, the service worker and the offscreen document.
// The content script sends to 'bg'. The service worker adds the tab id and forwards to 'offscreen'.

export type Request =
  | { type: 'index'; indexId: string; ids: number[]; texts: string[] } // ids are chunk positions
  | { type: 'query'; indexId: string; query: string }
  | { type: 'drop' };

export type Envelope = Request & { target: 'bg' | 'offscreen'; tabId?: number };

export interface IndexResponse { ok: true; ms: number; device: string }
export interface QueryResponse { scores: number[]; ms: number }
export interface ErrorResponse { error: string }
