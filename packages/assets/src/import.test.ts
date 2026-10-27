import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  createWordRepository,
  LOCAL_OWNER_SCOPE,
  migrate,
  openDatabase,
  type SqliteDatabase,
  type WordRepository,
} from '@woyao/data';
import { afterEach, describe, expect, it } from 'vitest';

import { importEcdict, parseEcdictCsv, sensesOf } from './ecdict';
import { sha256File, type AssetEntry } from './manifest';
import { importFrequency, parseNetemJson } from './netem';

/** 固定时间，避免测试依赖当前时钟。 */
const now = new Date('2026-10-27T10:00:00.000Z');
const deviceId = 'test-device';

const ECDICT_CSV = [
  'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq',
  "abandon,ə'bændən,to leave,\"v. 放弃；抛弃\nn. 放任\",v:70/n:30,3,1,\"cet4 cet6 ky\",100,80",
  'brief,briːf,short,"adj. 简短的\nn. 摘要",adj:80/n:20,4,1,cet4,200,160',
  'the,ðə,the,"art. 这个",art:100,5,1,,1,1',
].join('\n');

let db: SqliteDatabase | null = null;
let repo: WordRepository | null = null;

/** 开一份内存库。 */
function openRepo(): WordRepository {
  db = openDatabase(':memory:');
  migrate(db);
  repo = createWordRepository(db);
  return repo;
}

afterEach(() => {
  if (db !== null) {
    closeDatabase(db);
    db = null;
    repo = null;
  }
});

/** 生成条目；校验和指向真实文件。 */
async function entryFor(options: {
  id: string;
  kind: 'DICTIONARY' | 'FREQUENCY';
  filePath: string;
  license: string;
  redistributionAllowed: boolean;
}): Promise<AssetEntry> {
  return {
    id: options.id,
    kind: options.kind,
    path: path.basename(options.filePath),
    format: options.kind === 'DICTIONARY' ? 'csv' : 'json',
    source: {
      name: options.kind === 'DICTIONARY' ? 'ECDICT' : 'exam-data/NETEMVocabulary',
      url: 'https://example.com/source',
      version: '2026-10-24',
      license: {
        code: options.license,
        url: 'https://example.com/license',
        attribution: 'fixture authors',
        redistributionAllowed: options.redistributionAllowed,
      },
    },
    checksum: { algorithm: 'sha256', value: await sha256File(options.filePath) },
  };
}

/** 写一份临时 fixture 并返回路径。 */
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'woyao-import-'));
  const file = path.join(dir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('ECDICT 解析', () => {
  it('解析引号内的中文逗号与换行', () => {
    const rows = parseEcdictCsv(ECDICT_CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.word).toBe('abandon');
    expect(rows[0]?.translation).toBe('v. 放弃；抛弃\nn. 放任');
    expect(sensesOf(rows[0]?.translation ?? '')).toStrictEqual([
      { pos: 'v.', simpleZh: '放弃；抛弃' },
      { pos: 'n.', simpleZh: '放任' },
    ]);
  });
});

describe('ECDICT 导入', () => {
  it('按考试标签建词库，保留音标与多义项', async () => {
    const repository = openRepo();
    const file = tempFile('ecdict.csv', ECDICT_CSV);
    const entry = await entryFor({
      id: 'ecdict',
      kind: 'DICTIONARY',
      filePath: file,
      license: 'MIT',
      redistributionAllowed: false,
    });

    const result = await importEcdict({
      repo: repository,
      rows: parseEcdictCsv(ECDICT_CSV),
      entry,
      deviceId,
      now,
      tags: ['cet4', 'cet6', 'ky'],
      sourceFilePath: file,
    });

    expect(result.importedWords).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.decks.map((deck) => deck.name).sort()).toStrictEqual(['六级核心词', '四级核心词', '考研词汇']);

    const abandon = repository.getWordByLemma('abandon', LOCAL_OWNER_SCOPE);
    expect(abandon?.phoneticUk).toBe("ə'bændən");
    expect(abandon?.phoneticUs).toBeNull();
    expect(repository.listSenses(abandon?.id ?? '').map((sense) => sense.simpleZh)).toStrictEqual([
      '放弃；抛弃',
      '放任',
    ]);
    expect(repository.listDeckWordIds('deck-builtin-cet4')).toHaveLength(2);
    expect(repository.listDeckWordIds('deck-builtin-cet6')).toHaveLength(1);
  });

  it('许可不在白名单时拒绝导入', async () => {
    const repository = openRepo();
    const file = tempFile('ecdict.csv', ECDICT_CSV);
    const entry = await entryFor({
      id: 'ecdict',
      kind: 'DICTIONARY',
      filePath: file,
      license: 'CC-BY-NC-SA-4.0',
      redistributionAllowed: false,
    });

    await expect(
      importEcdict({
        repo: repository,
        rows: parseEcdictCsv(ECDICT_CSV),
        entry,
        deviceId,
        now,
        allowedLicenses: ['MIT'],
      }),
    ).rejects.toThrow(/不在允许列表/);
    expect(repository.listDecks(LOCAL_OWNER_SCOPE)).toHaveLength(0);
  });

  it('文件被替换后校验和不匹配，拒绝导入', async () => {
    const repository = openRepo();
    const file = tempFile('ecdict.csv', ECDICT_CSV);
    const entry = await entryFor({
      id: 'ecdict',
      kind: 'DICTIONARY',
      filePath: file,
      license: 'MIT',
      redistributionAllowed: false,
    });
    writeFileSync(file, ECDICT_CSV.replace('abandon', 'abandoned'), 'utf8');

    await expect(
      importEcdict({
        repo: repository,
        rows: parseEcdictCsv(ECDICT_CSV),
        entry,
        deviceId,
        now,
        sourceFilePath: file,
      }),
    ).rejects.toThrow(/不一致/);
  });
});

describe('NETEM 词频导入', () => {
  /** 先建三个词，模拟已导入词库。 */
  function seedWords(repository: WordRepository): void {
    const source = repository.upsertSource({
      id: 'src-test',
      ownerScope: LOCAL_OWNER_SCOPE,
      type: 'USER',
      name: '测试来源',
      deviceId,
      now,
      redistributionAllowed: true,
    });
    for (const lemma of ['abandon', 'brief', 'zebra']) {
      repository.createWord({
        ownerScope: LOCAL_OWNER_SCOPE,
        lemma,
        senses: [{ pos: 'v.', simpleZh: '释义', sourceId: source.id }],
        deviceId,
        now,
      });
    }
  }

  it('保留词频、语料版本与并列名次；缺词保持未知', async () => {
    const repository = openRepo();
    seedWords(repository);
    const raw = [
      { 单词: 'abandon', 词频: 100 },
      { 单词: 'brief', 词频: 100 },
      { 单词: 'zebra', 词频: 40 },
      { 单词: 'ghost', 词频: 25 },
    ];
    const file = tempFile('netem.json', JSON.stringify(raw));
    const entry = await entryFor({
      id: 'netem',
      kind: 'FREQUENCY',
      filePath: file,
      license: 'CC-BY-NC-SA-4.0',
      redistributionAllowed: false,
    });

    const result = await importFrequency({
      repo: repository,
      rows: parseNetemJson(raw),
      entry,
      exam: 'NETEM',
      corpusVersion: 'netem-2026-10',
      deviceId,
      now,
      sourceFilePath: file,
      allowedLicenses: ['CC-BY-NC-SA-4.0'],
    });

    expect(result.importedEntries).toBe(3);
    expect(result.missingWords).toBe(1);

    const entries = repository.listFrequencyEntries('NETEM', 'netem-2026-10');
    const byWord = new Map(entries.map((entry) => [entry.wordId, entry]));
    const abandon = repository.getWordByLemma('abandon', LOCAL_OWNER_SCOPE);
    const brief = repository.getWordByLemma('brief', LOCAL_OWNER_SCOPE);
    const zebra = repository.getWordByLemma('zebra', LOCAL_OWNER_SCOPE);
    const ghost = repository.getWordByLemma('ghost', LOCAL_OWNER_SCOPE);

    expect(byWord.get(abandon?.id ?? '')?.rank).toBe(1);
    expect(byWord.get(abandon?.id ?? '')?.equalCount).toBe(2);
    expect(byWord.get(brief?.id ?? '')?.rank).toBe(1);
    expect(byWord.get(zebra?.id ?? '')?.rank).toBe(3);
    // 词库里没有的词不写 0 频占位：保持“未知”，而不是被当成低频。
    expect(ghost).toBeNull();
    expect(byWord.has('missing')).toBe(false);
    expect(repository.getFrequencyCorpusMeta('NETEM', 'netem-2026-10')?.totalTokens).toBeNull();
  });

  it('词频缺失或为 0 的行不进入语料', () => {
    const rows = parseNetemJson([
      { 单词: 'abandon', 词频: 3 },
      { 单词: 'brief', 词频: 0 },
      { 单词: 'zebra' },
      { 单词: '', 词频: 9 },
    ]);
    expect(rows).toStrictEqual([{ word: 'abandon', frequency: 3 }]);
  });

  it('许可不匹配时拒绝导入', async () => {
    const repository = openRepo();
    seedWords(repository);
    const raw = [{ 单词: 'abandon', 词频: 3 }];
    const file = tempFile('netem.json', JSON.stringify(raw));
    const entry = await entryFor({
      id: 'netem',
      kind: 'FREQUENCY',
      filePath: file,
      license: 'PROPRIETARY',
      redistributionAllowed: false,
    });

    await expect(
      importFrequency({
        repo: repository,
        rows: parseNetemJson(raw),
        entry,
        exam: 'NETEM',
        corpusVersion: 'v1',
        deviceId,
        now,
        allowedLicenses: ['CC-BY-NC-SA-4.0'],
      }),
    ).rejects.toThrow(/不在允许列表/);
  });
});
