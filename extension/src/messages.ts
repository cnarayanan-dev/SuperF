// Messages between the content script, the service worker and the offscreen document.
// The content script sends to 'bg'. The service worker adds the tab id and forwards to 'offscreen'.

export type Request =
  | { type: 'index'; indexId: string; ids: number[]; texts: string[] } // ids are chunk positions
  | { type: 'query'; indexId: string; query: string }
  // Scores the sentences of some chunks against the query, to pick the highlight inside a long chunk.
  | { type: 'sentences'; indexId: string; query: string; chunks: { chunk: number; texts: string[] }[] }
  | { type: 'forget'; indexId: string } // one index of the tab
  | { type: 'drop' }; // all indexes of the tab

export type Envelope = Request & { target: 'bg' | 'offscreen'; tabId?: number };

export interface IndexResponse { ok: true; ms: number; device: string }
export interface QueryResponse { scores: number[]; ms: number }
export interface SentencesResponse { scores: number[][]; ms: number } // one list per requested chunk
export interface ErrorResponse { error: string }

// The page decides which indexes of its tab are kept and tells the offscreen document to forget the
// others. The offscreen document has the same cap as a safety net.
export const INDEX_NOT_FOUND = 'index not found';
