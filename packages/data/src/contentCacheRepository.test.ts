import { afterEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from './connection';
import { closeDatabase, migrate, openDatabase } from './connection';
import { InvalidRepositoryInputError } from './errors';
import { createContentCacheRepository, type ContentCacheRepository } from './index';

/** 本文件创建的连接。 */
const openDatabases: SqliteDatabase[] = [];

function createDatabase(): SqliteDatabase {
  const db = openDatabase(':memory:');
  migrate(db);
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    closeDatabase(openDatabases.pop() as SqliteDatabase);
  }
});

describe('contentCacheRepository', () => {
  it('get/set 往返保留 payload 结构（JSON 值而非字符串）', () => {
    const db = createDatabase();
    const repo: ContentCacheRepository = createContentCacheRepository(db);

    repo.set({
      cacheKey: 'content:word:abandon',
      provider: 'dictionaryapi',
      payload: { senses: [{ pos: 'v.', definitionZh: '放弃' }] },
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-02T00:00:00.000Z',
      sourceId: 'src-1',
    });

    const entry = repo.get('content:word:abandon');
    expect(entry).toMatchObject({
      cacheKey: 'content:word:abandon',
      provider: 'dictionaryapi',
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-02T00:00:00.000Z',
      sourceId: 'src-1',
    });
    expect(entry?.payload).toEqual({ senses: [{ pos: 'v.', definitionZh: '放弃' }] });
  });

  it('过期条目仍返回（TTL 只决定刷新，不决定可用）', () => {
    const db = createDatabase();
    const repo = createContentCacheRepository(db);

    repo.set({
      cacheKey: 'audio:abandon:uk',
      provider: 'dictionaryapi',
      payload: { url: 'https://example.com/abandon-uk.mp3' },
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T00:01:00.000Z', // 早已过期
      sourceId: null,
    });

    // 关键语义：`get` 不看 expiresAt，过期也要拿得到（离线时过期缓存仍可用）。
    const entry = repo.get('audio:abandon:uk');
    expect(entry).not.toBeNull();
    expect(entry?.payload).toEqual({ url: 'https://example.com/abandon-uk.mp3' });
  });

  it('同 key 二次 set 覆盖；evict 只清该 provider', () => {
    const db = createDatabase();
    const repo = createContentCacheRepository(db);

    repo.set({
      cacheKey: 'k-1',
      provider: 'dictionaryapi',
      payload: 1,
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: null,
      sourceId: null,
    });
    repo.set({
      cacheKey: 'k-2',
      provider: 'llm',
      payload: 2,
      fetchedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: null,
      sourceId: null,
    });
    repo.set({
      cacheKey: 'k-1',
      provider: 'dictionaryapi',
      payload: 3,
      fetchedAt: '2025-01-02T00:00:00.000Z',
      expiresAt: null,
      sourceId: null,
    });

    expect(repo.get('k-1')?.payload).toBe(3);

    repo.evict('dictionaryapi');
    expect(repo.get('k-1')).toBeNull();
    expect(repo.get('k-2')?.payload).toBe(2);
  });

  it('payload_json 脏数据时 get 返回 null（不当成功、不抛错）', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO content_cache (cache_key, provider, payload_json, fetched_at)
       VALUES ('bad', 'dictionaryapi', '{not-json', '2025-01-01T00:00:00.000Z')`,
    ).run();
    const repo = createContentCacheRepository(db);

    expect(repo.get('bad')).toBeNull();
  });

  it('非法 fetchedAt/expiresAt/空 provider 在 set 时被拒', () => {
    const db = createDatabase();
    const repo = createContentCacheRepository(db);

    expect(() =>
      repo.set({
        cacheKey: 'k',
        provider: '',
        payload: 1,
        fetchedAt: '2025-01-01T00:00:00.000Z',
        expiresAt: null,
        sourceId: null,
      }),
    ).toThrow(InvalidRepositoryInputError);

    expect(() =>
      repo.set({
        cacheKey: 'k',
        provider: 'dictionaryapi',
        payload: 1,
        fetchedAt: '2025-01-01T00:00:00Z', // 无毫秒
        expiresAt: null,
        sourceId: null,
      }),
    ).toThrow(InvalidRepositoryInputError);
  });
});
