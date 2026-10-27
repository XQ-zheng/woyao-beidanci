import { createHash } from 'node:crypto';

import {
  LOCAL_OWNER_SCOPE,
  normalizeLemma,
  type DeckRecord,
  type SourceRecord,
  type WordRecord,
  type WordRepository,
} from '@woyao/data';

import { parseCsv } from './csv';
import { assertChecksum, assertEntryUsable, type AssetEntry } from './manifest';

/** ECDICT 一行的必需字段。 */
export interface EcdictRow {
  readonly word: string;
  readonly phonetic: string;
  readonly translation: string;
  readonly definition: string;
  readonly tag: string;
}

/** 解析结果：只要列齐，缺内容按空串处理。 */
export function parseEcdictCsv(csv: string): EcdictRow[] {
  const table = parseCsv(csv);
  if (table.length === 0) {
    return [];
  }
  const header = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const index = new Map(header.map((name, position) => [name, position]));
  for (const required of ['word', 'phonetic', 'translation', 'tag']) {
    if (!index.has(required)) {
      throw new Error(`ECDICT CSV 缺少必需列：${required}`);
    }
  }

  const value = (row: readonly string[], key: string): string => {
    const position = index.get(key);
    return position === undefined ? '' : (row[position] ?? '').trim();
  };

  const rows: EcdictRow[] = [];
  for (const row of table.slice(1)) {
    const word = value(row, 'word');
    if (word.length === 0) {
      continue;
    }
    rows.push({
      word,
      phonetic: value(row, 'phonetic'),
      translation: value(row, 'translation'),
      definition: value(row, 'definition'),
      tag: value(row, 'tag'),
    });
  }
  return rows;
}

/** 词性前缀（`v.` / `n.` / `adj.` …）。 */
const POS_PATTERN = /^([a-z]+\.)\s*/iu;

/** 从一个释义文本拆出义项。 */
export function sensesOf(translation: string): { pos: string; simpleZh: string }[] {
  const senses: { pos: string; simpleZh: string }[] = [];
  for (const rawLine of translation.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const matched = POS_PATTERN.exec(line);
    const pos = matched?.[1] ?? '';
    const simpleZh = (matched === null ? line : line.slice(matched[0].length)).trim();
    if (simpleZh.length > 0) {
      senses.push({ pos, simpleZh });
    }
  }
  return senses.slice(0, 8);
}

/** 导入选项。 */
export interface ImportDictionaryOptions {
  readonly repo: WordRepository;
  readonly rows: readonly EcdictRow[];
  readonly entry: AssetEntry;
  readonly deviceId: string;
  readonly now: Date;
  /** 只导入带这些标签的词；默认四六级 + 考研。 */
  readonly tags?: readonly string[];
  /** 导入前校验文件校验和（推荐传实际 CSV 路径）。 */
  readonly sourceFilePath?: string;
  /** 许可白名单；不传则不限制（本地导入）。 */
  readonly allowedLicenses?: readonly string[];
}

/** 导入结果。 */
export interface ImportDictionaryResult {
  readonly sourceId: string;
  readonly importedWords: number;
  readonly skippedRows: number;
  readonly decks: readonly { readonly deckId: string; readonly name: string; readonly added: number }[];
}

/** 标签 → 词库。 */
const EXAM_DECKS: Readonly<Record<string, { id: string; name: string }>> = {
  cet4: { id: 'deck-builtin-cet4', name: '四级核心词' },
  cet6: { id: 'deck-builtin-cet6', name: '六级核心词' },
  ky: { id: 'deck-builtin-netem', name: '考研词汇' },
  netem: { id: 'deck-builtin-netem', name: '考研词汇' },
};

/**
 * 把 ECDICT 行导入本地词库。
 *
 * 只保留考试标签命中的词（默认四六级/考研），按标签放进对应内置词库；
 * 音标写英式（ECDICT 只提供一套音标，**不复制成美式**冒充双音标）。
 *
 * @param options 导入参数。
 * @returns 导入统计。
 */
export async function importEcdict(options: ImportDictionaryOptions): Promise<ImportDictionaryResult> {
  if (options.sourceFilePath !== undefined) {
    await assertChecksum(options.entry, options.sourceFilePath);
  }
  assertEntryUsable(options.entry, {
    allowedLicenses: options.allowedLicenses,
    requireRedistribution: false,
  });
  if (options.entry.kind !== 'DICTIONARY') {
    throw new Error(`资源 ${options.entry.id} 不是词典`);
  }

  const wanted = new Set((options.tags ?? ['cet4', 'cet6', 'ky']).map((tag) => tag.toLowerCase()));
  const source: SourceRecord = options.repo.upsertSource({
    id: 'builtin-ecdict',
    ownerScope: LOCAL_OWNER_SCOPE,
    type: 'BUILTIN',
    name: options.entry.source.name,
    version: options.entry.source.version,
    url: options.entry.source.url,
    licenseCode: options.entry.source.license.code,
    licenseUrl: options.entry.source.license.url,
    attribution: options.entry.source.license.attribution,
    redistributionAllowed: options.entry.source.license.redistributionAllowed,
    deviceId: options.deviceId,
    now: options.now,
  });

  const deckRecords = new Map<string, DeckRecord>();
  for (const tag of wanted) {
    const definition = EXAM_DECKS[tag];
    if (definition === undefined || deckRecords.has(definition.id)) {
      continue;
    }
    deckRecords.set(
      definition.id,
      options.repo.upsertDeck({
        id: definition.id,
        ownerScope: LOCAL_OWNER_SCOPE,
        name: definition.name,
        kind: 'BUILTIN',
        sourceId: source.id,
        deviceId: options.deviceId,
        now: options.now,
      }),
    );
  }

  const added = new Map<string, number>();
  let importedWords = 0;
  let skippedRows = 0;

  for (const row of options.rows) {
    const tags = row.tag
      .toLowerCase()
      .split(/\s+/u)
      .filter((tag) => tag.length > 0);
    const matchedDecks = [
      ...new Set(
        tags
          .map((tag) => EXAM_DECKS[tag]?.id)
          .filter((deckId): deckId is string => deckId !== undefined),
      ),
    ];
    if (matchedDecks.length === 0) {
      skippedRows += 1;
      continue;
    }
    const senses = sensesOf(row.translation);
    if (senses.length === 0) {
      skippedRows += 1;
      continue;
    }

    const normalized = normalizeLemma(row.word);
    const wordId = `ecdict-${createHash('sha1').update(normalized).digest('hex').slice(0, 16)}`;
    const word: WordRecord = options.repo.createWord({
      id: wordId,
      ownerScope: LOCAL_OWNER_SCOPE,
      lemma: row.word,
      phoneticUk: row.phonetic.length === 0 ? null : row.phonetic,
      phoneticUs: null,
      senses: senses.map((sense, index) => ({
        senseNo: index + 1,
        pos: sense.pos,
        simpleZh: sense.simpleZh,
        detailedZh: null,
        contextText: null,
        sourceId: source.id,
      })),
      deviceId: options.deviceId,
      now: options.now,
    });

    for (const deckId of matchedDecks) {
      const deck = deckRecords.get(deckId);
      if (deck === undefined) {
        continue;
      }
      options.repo.addDeckWord(deck.id, word.id, options.deviceId, options.now);
      added.set(deckId, (added.get(deckId) ?? 0) + 1);
    }
    importedWords += 1;
  }

  return {
    sourceId: source.id,
    importedWords,
    skippedRows,
    decks: [...deckRecords.values()].map((deck) => ({
      deckId: deck.id,
      name: deck.name,
      added: added.get(deck.id) ?? 0,
    })),
  };
}
