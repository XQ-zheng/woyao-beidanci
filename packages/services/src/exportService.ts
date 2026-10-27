/**
 * 导出服务：取数 → 组装渲染器无关的 `ExportModel` → 交给 `DocumentWriterPort` 写出。
 *
 * **定位是纯编排**，不是渲染：真正的 docx/xlsx/pdf 渲染是 Task 8 的活。本轮
 * - 不碰文件系统（写出由 `writer` 端口负责）；
 * - 不碰 `node:*` / `fetch` / `window` / `new Date()`；
 * - 不联网（离线导出必须可用）——整条路径只碰 `writer`，不碰 `cloud/http/llm/network`。
 *
 * 公式注入防护**只在服务层这一处做**（单一出口）：任何单元格内容 trim 后以 `= + - @`
 * 开头的，统一前置 `'`，保证无论 Task 8 用哪个渲染器落 xlsx，都不会把用户文本当公式执行。
 */

import { parseIsoInstant, toIsoInstant, type FrequencyEntry } from '@woyao/core';

import {
  exportDeckInputSchema,
  exportHistoryInputSchema,
  exportNotebookInputSchema,
  parseOrThrow,
  toLocalDateString,
} from './dto';
import { ServiceNotFoundError, ServiceValidationError } from './errors';
import type { ExportFormat, ServiceContext } from './ports';

/** 导出种类。 */
export type ExportKind = 'HISTORY' | 'NOTEBOOK' | 'DECK';

/** 渲染器无关的导出模型（Task 8 的 writer 只认它）。 */
export interface ExportModel {
  readonly kind: ExportKind;
  readonly generatedAt: string;
  readonly title: string;
  /** 列名（程序控制，不做公式转义）。 */
  readonly columns: string[];
  /** 已字符串化；每行单元格数与 `columns` 一致；用户文本已做公式注入转义。 */
  readonly rows: string[][];
  /** 词频语料来源标注（仅 DECK/NOTEBOOK 有，HISTORY 恒 null）。 */
  readonly source: string | null;
}

/** 写出的回执。 */
export interface ExportReceipt {
  readonly kind: ExportKind;
  readonly format: ExportFormat;
  readonly destination: string;
  readonly rowCount: number;
  readonly generatedAt: string;
}

/** 历史导出区间（两端都是 UTC ISO 毫秒，闭区间）。 */
export interface DateRange {
  readonly fromIso: string;
  readonly toIso: string;
}

/** 导出服务契约。 */
export interface ExportService {
  exportHistory(input: { format: ExportFormat; range: DateRange; destination: string }): Promise<ExportReceipt>;
  exportNotebook(input: {
    format: ExportFormat;
    notebookId: string;
    destination: string;
    /** 给了 exam + corpusVersion 才附加词频列与来源标注；否则 `source=null`。 */
    exam?: string;
    corpusVersion?: string;
  }): Promise<ExportReceipt>;
  exportDeck(input: {
    format: ExportFormat;
    deckId: string;
    destination: string;
    /** 给了 exam + corpusVersion 才附加词频列与来源标注；否则 `source=null`。 */
    exam?: string;
    corpusVersion?: string;
  }): Promise<ExportReceipt>;
}

/** 构造参数。 */
export interface ExportServiceOptions {
  readonly context: ServiceContext;
  /** 历史导出的本地日折算时区（由外壳注入，与 settingsService 同款）。 */
  readonly defaultTimeZone: string;
}

/** 词/词库/单词本导出的基础列。 */
const WORD_BASE_COLUMNS = ['词条', '义项序号', '词性', '简明释义', '详细释义', '例句'] as const;

/** 历史导出的列（会话与日统计共用一张表，第一列区分类型）。 */
const HISTORY_COLUMNS = ['类型', '本地日', '开始时间', '结束时间', '总数', '正确', '错误', '时长(毫秒)'] as const;

/**
 * 公式注入防护：`trim` 后以 `= + - @` 开头的文本，前置 `'`（保留原文）。
 *
 * 这是**唯一出口**：所有行单元格都过这里，列名不过（那是程序控制的常量）。
 *
 * @param value 单元格原文。
 * @returns 转义后的文本。
 */
export function guardFormulaCell(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.startsWith('=') ||
    trimmed.startsWith('+') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('@')
  ) {
    return `'${value}`;
  }
  return value;
}

/**
 * 创建导出服务。
 *
 * @param options 上下文与历史折算时区。
 * @returns 导出服务实例。
 */
export function createExportService(options: ExportServiceOptions): ExportService {
  const { context, defaultTimeZone } = options;

  /**
   * 组装 DECK/NOTEBOOK 的词表格（词序 = 词库加入顺序，义项按 senseNo 升序）。
   */
  async function buildWordModel(input: {
    readonly deckId: string;
    readonly exam?: string;
    readonly corpusVersion?: string;
  }): Promise<{ title: string; columns: string[]; rows: string[][]; source: string | null }> {
    const deck = await context.repos.words.getDeckById(input.deckId);
    if (deck === null) {
      throw new ServiceNotFoundError('deck', input.deckId);
    }

    // `listWordsByIds` 保持入参顺序（Task 4 保证），所以词序就是加入顺序。
    const wordIds = await context.repos.words.listDeckWordIds(deck.id);
    const words = await context.repos.words.listWordsByIds(wordIds);

    const columns: string[] = [...WORD_BASE_COLUMNS];
    let source: string | null = null;
    const frequencyByWord = new Map<string, FrequencyEntry>();
    if (input.exam !== undefined && input.corpusVersion !== undefined) {
      const [entries, meta] = await Promise.all([
        context.repos.words.listFrequencyEntries(input.exam, input.corpusVersion),
        context.repos.words.getFrequencyCorpusMeta(input.exam, input.corpusVersion),
      ]);
      for (const entry of entries) {
        frequencyByWord.set(entry.wordId, entry);
      }
      // 有语料元信息才标来源并加词频列；给了 exam/version 但库里没有语料 → 不编来源。
      if (meta !== null) {
        source = `${meta.sourceId}（${input.corpusVersion}）`;
        columns.push('词频', '名次');
      }
    }

    const rows: string[][] = [];
    for (const word of words) {
      const senses = (await context.repos.words.listSenses(word.id)).slice().sort(
        (left, right) => left.senseNo - right.senseNo,
      );
      const frequency = frequencyByWord.get(word.id);
      for (const sense of senses) {
        const row: string[] = [
          word.lemma,
          String(sense.senseNo),
          sense.pos,
          sense.simpleZh,
          sense.detailedZh ?? '',
          sense.contextText ?? '',
        ];
        if (source !== null) {
          row.push(
            frequency === undefined ? '' : String(frequency.frequency),
            frequency === undefined || frequency.rank === undefined ? '' : String(frequency.rank),
          );
        }
        rows.push(row.map(guardFormulaCell));
      }
    }

    return { title: deck.name, columns, rows, source };
  }

  return {
    async exportDeck(input: {
      format: ExportFormat;
      deckId: string;
      destination: string;
      exam?: string;
      corpusVersion?: string;
    }): Promise<ExportReceipt> {
      const validated = parseOrThrow(exportDeckInputSchema, input, '导出词库');
      const { title, columns, rows, source } = await buildWordModel({
        deckId: validated.deckId,
        exam: validated.exam,
        corpusVersion: validated.corpusVersion,
      });
      const model: ExportModel = {
        kind: 'DECK',
        generatedAt: toIsoInstant(context.clock.now()),
        title,
        columns,
        rows,
        source,
      };
      return context.writer.write(model, validated.format, validated.destination);
    },

    async exportNotebook(input: {
      format: ExportFormat;
      notebookId: string;
      destination: string;
      exam?: string;
      corpusVersion?: string;
    }): Promise<ExportReceipt> {
      const validated = parseOrThrow(exportNotebookInputSchema, input, '导出单词本');
      const { title, columns, rows, source } = await buildWordModel({
        deckId: validated.notebookId,
        exam: validated.exam,
        corpusVersion: validated.corpusVersion,
      });
      const model: ExportModel = {
        kind: 'NOTEBOOK',
        generatedAt: toIsoInstant(context.clock.now()),
        title,
        columns,
        rows,
        source,
      };
      return context.writer.write(model, validated.format, validated.destination);
    },

    async exportHistory(input: {
      format: ExportFormat;
      range: DateRange;
      destination: string;
    }): Promise<ExportReceipt> {
      const validated = parseOrThrow(exportHistoryInputSchema, input, '导出历史');
      // ISO 毫秒串的字典序即时间序，反向区间在进数据层之前就拒掉。
      if (validated.range.fromIso > validated.range.toIso) {
        throw new ServiceValidationError(
          [
            {
              path: 'range.fromIso',
              message: `起始时间 ${validated.range.fromIso} 晚于结束时间 ${validated.range.toIso}`,
            },
          ],
          '导出历史校验未通过',
        );
      }

      // 本地日由 DateRange 经 defaultTimeZone 折算（日统计按用户日历日分组）。
      const fromLocalDate = toLocalDateString(
        parseIsoInstant(validated.range.fromIso, 'range.fromIso'),
        defaultTimeZone,
      );
      const toLocalDate = toLocalDateString(
        parseIsoInstant(validated.range.toIso, 'range.toIso'),
        defaultTimeZone,
      );

      // 两端都是闭区间：数据层的 listSessions / listDailyStats 用 >= / <= 过滤，
      // 出区间的行天然被排除。
      const [sessions, dailyStats] = await Promise.all([
        context.repos.learning.listSessions(validated.range.fromIso, validated.range.toIso),
        context.repos.learning.listDailyStats(fromLocalDate, toLocalDate),
      ]);

      const columns: string[] = [...HISTORY_COLUMNS];
      const rows: string[][] = [];
      for (const session of sessions) {
        rows.push(
          [
            '会话',
            session.localDate,
            session.startedAt,
            session.endedAt ?? '',
            '',
            '',
            '',
            String(session.activeDurationMs),
          ].map(guardFormulaCell),
        );
      }
      for (const stat of dailyStats) {
        rows.push(
          [
            '日统计',
            stat.localDate,
            '',
            '',
            String(stat.total),
            String(stat.correct),
            String(stat.wrong),
            String(stat.activeMs),
          ].map(guardFormulaCell),
        );
      }

      const model: ExportModel = {
        kind: 'HISTORY',
        generatedAt: toIsoInstant(context.clock.now()),
        title: '学习历史',
        columns,
        rows,
        source: null,
      };
      return context.writer.write(model, validated.format, validated.destination);
    },
  };
}
