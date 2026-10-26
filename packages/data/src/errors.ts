/**
 * 数据层错误类型。
 *
 * 约定：所有错误都带 `code`（稳定的机器可读字符串）与 `detail`（可展示的说明），
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
 * 归属范围非法。
 *
 * 取值域只有三种（见 `wordRepository`）：`BUILTIN`、`LOCAL`、`acct:<accountId>`。
 * 卡片式的第四种写法（例如裸的 `account-1`）一律拒绝——它会让数据看起来“隔离了”，
 * 实际上和一个忘记加前缀的账号共用同一份命名空间。
 */
export class InvalidOwnerScopeError extends DataLayerError {
  /** 非法的归属范围。 */
  readonly ownerScope: string;

  /**
   * @param ownerScope 传入的归属范围。
   */
  constructor(ownerScope: unknown) {
    super(
      'INVALID_OWNER_SCOPE',
      '归属范围只能是 BUILTIN、LOCAL 或 acct:<accountId>',
      `ownerScope=${String(ownerScope)}`,
    );
    this.ownerScope = String(ownerScope);
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

/**
 * 破坏仓储不变量（**不是**入参格式问题，而是调用方与数据模型对不上）。
 *
 * 典型场景：`appendEventAndUpdateState` 收到的 `event.userWordId` 与 `state.userWordId`
 * 不是同一个词——继续写下去就会得到“事件记在 A 上、状态记在 B 上”的裂开数据。
 * 与 `InvalidRepositoryInputError` 分开，是为了让上层能区分“表单填错了”和“代码有 bug”。
 */
export class RepositoryInvariantError extends DataLayerError {
  /** 被破坏的不变量名。 */
  readonly invariant: string;

  /**
   * @param invariant 不变量名（稳定的英文标识）。
   * @param detail 说明实际值与期望关系。
   */
  constructor(invariant: string, detail: string) {
    super('REPOSITORY_INVARIANT_VIOLATION', `仓储不变量被破坏（${invariant}）：${detail}`, detail);
    this.invariant = invariant;
  }
}

/**
 * 词频语料写入校验失败。
 *
 * `kind` 用来区分**具体哪种失配**，避免上层只能拿到一句笼统的“数据不一致”：
 * - `EQUAL_COUNT_MISMATCH`：某行的 `equal_count` 与本并列组实际大小不符；
 * - `TIE_GROUP_DEFAULT`：并列组大小 > 1，但组内仍有行的 `equal_count` 是默认值 1
 *   （导入忘了写真实并列数，会让百分位偏高）；
 * - `RANK_GAP`：`rank` 不是 1 基、连续、competition rank（同频次共享组内最小名次）；
 * - `TOTAL_MISMATCH`：语料覆盖的词数与 `knownWordCount` 对不上（截断/重复计入）；
 * - `DUPLICATE_WORD`：同一个词在同一份语料里出现多次；
 * - `KNOWN_WORD_COUNT_INVALID`：传入的 `knownWordCount` 非正整数。
 */
export class FrequencyCorpusMismatchError extends DataLayerError {
  /** 失配类型。 */
  readonly kind:
    | 'EQUAL_COUNT_MISMATCH'
    | 'TIE_GROUP_DEFAULT'
    | 'RANK_GAP'
    | 'TOTAL_MISMATCH'
    | 'DUPLICATE_WORD'
    | 'KNOWN_WORD_COUNT_INVALID';

  /**
   * @param kind 失配类型。
   * @param message 面向开发者的说明（含具体数值，便于定位）。
   * @param detail 补充细节。
   */
  constructor(kind: FrequencyCorpusMismatchError['kind'], message: string, detail = '') {
    super(`FREQUENCY_${kind}`, message, detail);
    this.kind = kind;
  }
}
