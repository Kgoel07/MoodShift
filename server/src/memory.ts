import { createHash } from 'node:crypto';
import { Supermemory, SupermemoryError } from 'supermemory';
import { z } from 'zod';
import { installationIdPattern, preferenceLimit } from '../../extension/src/shared/preferences';

export const installationId = z.string().regex(installationIdPattern).transform(id => id.toLowerCase());
const preference = z.string().trim().min(1).max(preferenceLimit).regex(/^[^\u0000-\u001f\u007f]+$/);
export const memoryRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('view'), installationId }),
  z.strictObject({ action: z.literal('clear'), installationId }),
  z.strictObject({ action: z.literal('remember'), installationId, enabled: z.literal(true), preference }),
]);

type MemoryRequest = z.output<typeof memoryRequest>;
type MemoryClient = Pick<Supermemory, 'add' | 'profile' | 'list'> & { namespaces: Pick<Supermemory['namespaces'], 'delete'> };
const scope = (id: string) => `moodshift_${id}`;
const isMissing = (error: unknown) => error instanceof SupermemoryError && error.statusCode === 404;

export class MemoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function bounded<T>(signal: AbortSignal | undefined, ms: number, work: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), ms);
  let abort: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(new MemoryError(504, 'Supermemory did not respond in time.'));
    if (requestSignal.aborted) return abort();
    requestSignal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => work(requestSignal)).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', abort);
  });
}

function preferenceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, preferenceLimit) || undefined;
}

export class Memory {
  private editing = new Set<string>();

  constructor(private readonly client: MemoryClient, private readonly contextMs = 1100, private readonly actionMs = 5000) {}

  async context(id: string, cancelled?: AbortSignal): Promise<string[]> {
    const namespace = scope(id);
    if (this.editing.has(namespace)) return [];
    try {
      const { profile } = await bounded(cancelled, this.contextMs, abortSignal =>
        this.client.profile(namespace, undefined, { abortSignal }));
      const entries = [...profile.static.slice(0, 6), ...profile.dynamic.slice(0, 6)];
      return this.editing.has(namespace) ? [] : [...new Set(entries.map(item => preferenceText(item.memory))
        .filter((value): value is string => value !== undefined))].slice(0, 4);
    } catch {
      return [];
    }
  }

  async manage(request: MemoryRequest, cancelled?: AbortSignal) {
    const namespace = scope(request.installationId);
    if (this.editing.has(namespace)) throw new MemoryError(409, 'Wait for the current preference change to finish.');
    const editing = request.action !== 'view';
    if (editing) this.editing.add(namespace);
    try {
      return await bounded(cancelled, this.actionMs, async abortSignal => {
        const options = { abortSignal };
        if (request.action === 'view') {
          const { documents, pagination } = await this.client.list(namespace, 'documents', {
            limit: 30, include: { content: true },
          }, options);
          return {
            preferences: documents.slice(0, 30).map(doc => preferenceText(doc.content))
              .filter((value): value is string => value !== undefined),
            hasMore: pagination.hasMore,
          };
        }
        if (request.action === 'clear') {
          const result = await this.client.namespaces.delete(namespace, undefined, options);
          if (result.status !== 'deleted' || result.namespace !== namespace) {
            throw new MemoryError(502, 'Supermemory did not confirm deletion.');
          }
          return { cleared: true };
        }
        const id = 'preference_' + createHash('sha256').update(request.preference).digest('hex').slice(0, 24);
        const result = await this.client.add(namespace, { content: request.preference, id, dreaming: 'instant' }, options);
        if (!result.id || !['queued', 'extracting', 'chunking', 'embedding', 'indexing', 'done'].includes(result.status)) {
          throw new MemoryError(502, 'Supermemory did not accept this preference.');
        }
        return { remembered: true, processing: result.status !== 'done' };
      });
    } catch (error) {
      if (isMissing(error) && request.action === 'view') return { preferences: [], hasMore: false };
      if (isMissing(error) && request.action === 'clear') return { cleared: true };
      if (error instanceof MemoryError) throw error;
      if (error instanceof SupermemoryError && error.statusCode === 403 && request.action === 'clear') {
        throw new MemoryError(403, 'Supermemory requires an organization admin or owner key with namespace write access to clear preferences.');
      }
      throw new MemoryError(502, 'Supermemory is unavailable. Check the proxy key and try again.');
    } finally {
      if (editing) this.editing.delete(namespace);
    }
  }
}

export function createMemory(key?: string, fetcher?: typeof fetch): Memory | undefined {
  if (!key?.trim()) return;
  return new Memory(new Supermemory({
    apiKey: key.trim(), fetch: fetcher, maxRetries: 0, logging: { silent: true },
  }));
}
