/**
 * 服务层错误类型。
 *
 * 与数据层同一套思路：每个错误都带**稳定的 `code`**，上层（IPC / UI）按 `code` 分支，
 * 不看 `message`。区别在语义层次：
 * - 数据层的错误说明“存储层发生了什么”（`INVALID_REPOSITORY_INPUT` 等）；
 * - 服务层的错误说明“这个操作对用户意味着什么”（参数没填对 / 找不到 / 冲突 / 没配置）。
 *
 * 因此服务层**不改写**数据层抛出的错误：能原样抛出的就原样抛出（`asyncifyRepositories`
 * 也保证异常实例不被替换），只有需要补充上下文时才包装成下面这些类型。
 */

/** 服务层稳定错误码。 */
export type ServiceErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_CONFIGURED';

/** 一条校验问题（与 zod 的 `issues` 同构，但只保留上层需要展示的字段）。 */
export interface ServiceValidationIssue {
  /** 出问题的字段路径，例如 `senses.0.simpleZh`；整体问题时为 `(root)`。 */
  readonly path: string;
  /** 面向用户/开发者的说明。 */
  readonly message: string;
}

/** 服务层错误基类。 */
export class ServiceError extends Error {
  /** 稳定的错误码。 */
  readonly code: ServiceErrorCode;

  /**
   * @param code 稳定错误码。
   * @param message 面向开发者的说明。
   */
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * 入参校验失败（表单没填对、越界、非法 JSON 等）。
 *
 * 一定带 `issues`：只给一句“校验失败”会让 UI 无法定位到具体输入框。
 */
export class ServiceValidationError extends ServiceError {
  /** 逐条问题。 */
  readonly issues: readonly ServiceValidationIssue[];

  /**
   * @param issues 逐条问题。
   * @param message 面向开发者的说明（缺省时由 `issues` 拼出）。
   */
  constructor(issues: readonly ServiceValidationIssue[], message?: string) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super('VALIDATION_FAILED', message === undefined ? `入参校验未通过：${detail}` : `${message}：${detail}`);
    this.issues = issues.map((issue) => ({ path: issue.path, message: issue.message }));
  }
}

/** 目标实体不存在（或已被删除）。 */
export class ServiceNotFoundError extends ServiceError {
  /** 实体种类，例如 `deck`。 */
  readonly entity: string;

  /** 被查询的 id。 */
  readonly id: string;

  /**
   * @param entity 实体种类。
   * @param id 被查询的 id。
   */
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} 不存在：${id}`);
    this.entity = entity;
    this.id = id;
  }
}

/**
 * 操作与当前状态冲突（例如引用了不存在的内容来源）。
 *
 * 与 `ServiceValidationError` 的区别：参数本身格式没问题，是**环境**不满足条件，
 * UI 应该提示“缺少某项资源”，而不是把输入框标红。
 */
export class ServiceConflictError extends ServiceError {
  /** 相关的实体/资源名。 */
  readonly subject: string;

  /**
   * @param subject 相关的实体/资源名。
   * @param message 面向开发者的说明。
   */
  constructor(subject: string, message: string) {
    super('CONFLICT', message);
    this.subject = subject;
  }
}

/**
 * 能力尚未配置（没有登录账号、没有选择内容来源、未开通云服务等）。
 *
 * 5A 只定义不使用；5C（云服务/内容源）会大量用到：它让 UI 能区分
 * “功能坏了”和“还没配置”，从而给出引导而不是错误提示。
 */
export class NotConfiguredError extends ServiceError {
  /** 未配置的能力名，例如 `cloudSync`。 */
  readonly feature: string;

  /**
   * @param feature 未配置的能力名。
   * @param message 面向开发者的说明。
   */
  constructor(feature: string, message: string) {
    super('NOT_CONFIGURED', message);
    this.feature = feature;
  }
}
