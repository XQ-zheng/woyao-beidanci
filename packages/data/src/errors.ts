/**
 * 数据层错误类型。
 *
 * 约定：所有错误都带 `code`（稳定的机器可读字符串）与 `detail`（可展示的中文说明），
 * 上层（服务层 / IPC）据此决定提示文案，禁止靠 `message` 字符串匹配来分支。
 */

/** 数据层错误基类。 */
export class DataLayerError extends Error {
  /** 稳定的错误码。 */
  readonly code: string;

  /** 补充细节（字段名、期望值、实际值等）。 */
  readonly detail: string;

  /**
   * @param code 稳定错误码。
   * @param message 面向开发者的说明。
   * @param detail 补充细节。
   */
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** 数据库路径或连接参数非法。 */
export class InvalidDatabasePathError extends DataLayerError {
  /**
   * @param path 传入的路径。
   */
  constructor(path: unknown) {
    super('INVALID_DATABASE_PATH', '数据库路径必须是非空字符串', `path=${String(path)}`);
  }
}

/** 迁移执行失败（SQL 报错、版本表损坏等）。 */
export class MigrationError extends DataLayerError {
  /**
   * @param version 出错的迁移版本。
   * @param detail 失败原因。
   */
  constructor(version: string, detail: string) {
    super('MIGRATION_FAILED', `迁移 ${version} 执行失败：${detail}`, detail);
  }
}

/**
 * 词频语料写入校验失败。
 *
 * `kind` 用来区分**具体哪种失配**，避免上层只能拿到一句笼统的“数据不一致”：
 * - `TOTAL_MISMATCH`：语料覆盖的词数与 `knownWordCount` 对不上（截断/重复计入）；
 * - `TIE_GROUP_DEFAULT`：某个并列组大小 > 1，但组内仍有行的 `equal_count` 是默认值 1
 *   （说明导入漏写了真实并列数，会让百分位虚高）；
 * - `RANK_INCONSISTENT`：同一并列组的 `rank` 不统一，或 `rank` 与排序结果矛盾；
 * - `DUPLICATE_WORD`：同一个词在同一份语料里出现多次；
 * - `KNOWN_WORD_COUNT_INVALID`：传入的 `knownWordCount` 非正整数。
 */
export class FrequencyCorpusMismatchError extends DataLayerError {
  /** 失配类型。 */
  readonly kind:
    | 'TOTAL_MISMATCH'
    | 'TIE_GROUP_DEFAULT'
    | 'RANK_INCONSISTENT'
    | 'DUPLICATE_WORD'
    | 'KNOWN_WORD_COUNT_INVALID';

  /**
   * @param kind 失配类型。
   * @param message 面向开发者的说明。
   * @param detail 补充细节（含具体数值，便于定位）。
   */
  constructor(kind: FrequencyCorpusMismatchError['kind'], message: string, detail = '') {
    super(`FREQUENCY_${kind}`, message, detail);
    this.kind = kind;
  }
}

/** 仓储入参非法（缺字段、类型不符、越界）。 */
export class InvalidRepositoryInputError extends DataLayerError {
  /** 出错的字段。 */
  readonly field: string;

  /**
   * @param field 出错的字段名。
   * @param detail 失败原因。
   */
  constructor(field: string, detail: string) {
    super('INVALID_REPOSITORY_INPUT', `仓储入参非法（${field}）：${detail}`, detail);
    this.field = field;
  }
}
