import { config } from "../config";

// Semantic embeddings for map positioning. Provider-agnostic: default is a LOCAL model
// (transformers.js `bge-small-en-v1.5`, mean-pooled + L2-normalized) so there's no API key,
// no per-run cost, and book data never leaves the server; Voyage/OpenAI are drop-in via config.
// Callers must tolerate failure (the map falls back to a deterministic layout).

export class EmbeddingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
  }
}

const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

// Dynamically import so onnxruntime is only pulled in when the provider is "local".
const loadLocal = () => import("@huggingface/transformers").then((m) => m.pipeline("feature-extraction", LOCAL_MODEL));

// Lazily loaded once, then cached — keeps startup fast.
let localPipe: ReturnType<typeof loadLocal> | null = null;

async function embedLocal(texts: string[]): Promise<number[][]> {
  localPipe ??= loadLocal();
  const extractor = await localPipe;
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

async function embedApi(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const key = config.EMBEDDINGS_API_KEY;
  if (!key) throw new EmbeddingError("no_key", `EMBEDDINGS_API_KEY is required for provider "${config.EMBEDDINGS_PROVIDER}"`);

  const [url, model] =
    config.EMBEDDINGS_PROVIDER === "voyage"
      ? ["https://api.voyageai.com/v1/embeddings", "voyage-3-lite"]
      : ["https://api.openai.com/v1/embeddings", "text-embedding-3-small"];

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new EmbeddingError("api_error", `${config.EMBEDDINGS_PROVIDER} embeddings HTTP ${res.status}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** True when embeddings are configured (i.e. not "none"). */
export const embeddingsEnabled = (): boolean => config.EMBEDDINGS_PROVIDER !== "none";

/** Embed texts → L2-normalized vectors. Throws `EmbeddingError` on failure (callers fall back). */
export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (!embeddingsEnabled() || texts.length === 0) return [];
  if (config.EMBEDDINGS_PROVIDER === "local") return embedLocal(texts);
  return embedApi(texts, signal);
}
