












export interface RetrievalRequest {

  repoPath: string;

  query: string;

  k: number;
}

export interface RetrievalCandidate {

  file: string;

  score: number;

  hint?: string;
}

export interface RetrievalResult {
  backend: string;
  candidates: RetrievalCandidate[];

  index_ms: number;

  note?: string;
}

export interface RetrievalBackend {

  id: string;



  retrieve(req: RetrievalRequest): Promise<RetrievalResult>;
}


export const DEFAULT_K = 12;
