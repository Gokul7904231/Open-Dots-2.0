export type EmbeddingTask =
  | 'query'
  | 'document'
  | 'code_query'
  | 'qa'
  | 'fact_check'
  | 'classification'
  | 'clustering'
  | 'similarity';

export type EmbeddingVector = {
  object: 'embedding';
  index: number;
  embedding: number[];
};

export type EmbeddingResponse = {
  object: 'list';
  data: EmbeddingVector[];
  model: string;
  dimensions: number;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

export type EmbeddingStatus = {
  state: 'not_configured' | 'misconfigured' | 'unreachable' | 'ready';
  configured: boolean;
  reachable: boolean;
  model: string;
  dimensions: number;
  reason?: string;
};

const SUPPORTED_DIMENSIONS = new Set([128, 256, 512, 768]);
const MAX_BATCH_SIZE = 16;
const MAX_INPUT_CHARS = 100_000;

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

type Env = Record<string, string | undefined>;
type Fetcher = typeof fetch;

export class EmbeddingGemmaClient {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly configState: 'not_configured' | 'misconfigured' | 'configured';
  private readonly configReason?: string;

  constructor(
    env: Env = process.env,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = (env.OPENAI_EMBEDDING_BASE_URL ?? '').trim().replace(/\/+$/, '');
    this.apiKey = (env.OPENAI_EMBEDDING_API_KEY ?? '').trim();
    this.model = (env.OPENAI_EMBEDDING_MODEL ?? 'embeddinggemma-2').trim();
    const rawDimensions = (env.OPENAI_EMBEDDING_DIMENSIONS ?? '768').trim();
    const parsedDimensions = Number(rawDimensions);
    this.dimensions = Number.isInteger(parsedDimensions) ? parsedDimensions : 0;

    if (!this.baseUrl && !this.apiKey) {
      this.configState = 'not_configured';
      return;
    }

    if (!this.baseUrl || !this.apiKey) {
      this.configState = 'misconfigured';
      this.configReason = 'Set both OPENAI_EMBEDDING_BASE_URL and OPENAI_EMBEDDING_API_KEY.';
      return;
    }

    if (!this.model) {
      this.configState = 'misconfigured';
      this.configReason = 'OPENAI_EMBEDDING_MODEL must not be empty.';
      return;
    }

    if (!SUPPORTED_DIMENSIONS.has(this.dimensions)) {
      this.configState = 'misconfigured';
      this.configReason = 'OPENAI_EMBEDDING_DIMENSIONS must be 128, 256, 512, or 768.';
      return;
    }

    try {
      const url = new URL(this.baseUrl);
      const localHttp =
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !localHttp) ||
        !url.pathname.replace(/\/+$/, '').endsWith('/v1') ||
        url.search ||
        url.hash
      ) {
        this.configState = 'misconfigured';
        this.configReason = 'OPENAI_EMBEDDING_BASE_URL must be an HTTPS URL ending in /v1 (HTTP is allowed for localhost only).';
        return;
      }
    } catch {
      this.configState = 'misconfigured';
      this.configReason = 'OPENAI_EMBEDDING_BASE_URL must be a valid URL ending in /v1.';
      return;
    }
    this.configState = 'configured';
  }

  get isConfigured() {
    return this.configState === 'configured';
  }

  async status(): Promise<EmbeddingStatus> {
    if (this.configState === 'not_configured') {
      return {
        state: 'not_configured',
        configured: false,
        reachable: false,
        model: this.model,
        dimensions: this.dimensions,
      };
    }
    if (this.configState === 'misconfigured') {
      return {
        state: 'misconfigured',
        configured: false,
        reachable: false,
        model: this.model,
        dimensions: this.dimensions,
        reason: this.configReason,
      };
    }

    try {
      const healthUrl = this.baseUrl.replace(/\/v1\/?$/, '') + '/health';
      const response = await this.fetcher(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('health request failed');
      const body = (await response.json()) as { status?: unknown; model?: unknown };
      if (body.status !== 'ok') throw new Error('health response was not ready');
      return {
        state: 'ready',
        configured: true,
        reachable: true,
        model: this.model,
        dimensions: this.dimensions,
      };
    } catch {
      return {
        state: 'unreachable',
        configured: true,
        reachable: false,
        model: this.model,
        dimensions: this.dimensions,
        reason: 'EmbeddingGemma health check failed. Check the service URL and confirm the host is running.',
      };
    }
  }

  async embed(
    input: string | string[],
    task: EmbeddingTask = 'query',
    dimensions = this.dimensions,
    signal?: AbortSignal,
  ): Promise<EmbeddingResponse> {
    if (this.configState === 'not_configured') {
      throw new EmbeddingProviderError('EmbeddingGemma is not configured.', 503);
    }
    if (this.configState === 'misconfigured') {
      throw new EmbeddingProviderError(this.configReason ?? 'EmbeddingGemma configuration is invalid.', 503);
    }
    if (!SUPPORTED_DIMENSIONS.has(dimensions)) {
      throw new EmbeddingProviderError('Dimensions must be 128, 256, 512, or 768.', 400);
    }
    const inputs = typeof input === 'string' ? [input] : input;
    if (
      !inputs.length ||
      inputs.length > MAX_BATCH_SIZE ||
      inputs.some((item) => typeof item !== 'string' || !item.trim() || item.length > MAX_INPUT_CHARS)
    ) {
      throw new EmbeddingProviderError(
        `Provide between 1 and ${MAX_BATCH_SIZE} non-empty text inputs, each no longer than ${MAX_INPUT_CHARS} characters.`,
        400,
      );
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input, model: this.model, task, dimensions }),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EmbeddingProviderError('EmbeddingGemma request timed out.', 504);
      }
      throw new EmbeddingProviderError('Could not reach the EmbeddingGemma API.', 502);
    }
    if (!response.ok) {
      throw new EmbeddingProviderError(
        `EmbeddingGemma API returned HTTP ${response.status}.`,
        response.status === 400 || response.status === 422 ? 400 : 502,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmbeddingProviderError('EmbeddingGemma returned invalid JSON.', 502);
    }
    if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
      throw new EmbeddingProviderError('EmbeddingGemma returned an invalid embedding response.', 502);
    }
    const raw = body as {
      data: { index?: unknown; embedding?: unknown }[];
      model?: unknown;
      usage?: EmbeddingResponse['usage'];
    };
    if (raw.data.length !== inputs.length) {
      throw new EmbeddingProviderError('EmbeddingGemma returned an unexpected number of vectors.', 502);
    }

    const data: EmbeddingVector[] = raw.data.map((item, index) => {
      if (
        !item ||
        !Array.isArray(item.embedding) ||
        item.embedding.length !== dimensions ||
        item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw new EmbeddingProviderError('EmbeddingGemma returned a malformed vector.', 502);
      }
      return {
        object: 'embedding',
        index: typeof item.index === 'number' ? item.index : index,
        embedding: item.embedding,
      };
    });

    return {
      object: 'list',
      data,
      model: typeof raw.model === 'string' ? raw.model : this.model,
      dimensions,
      ...(raw.usage ? { usage: raw.usage } : {}),
    };
  }
}
