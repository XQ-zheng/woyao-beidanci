/**
 * 图词联想服务：本地 CRUD + 在线补联想。
 *
 * 隐私红线（与 `onlineService` 一致）：
 * - 在线补联想只发用户主动查的那一个词；
 * - `asset_uri` 只存本机路径，**同步 payload 里绝不带它**（见 `associationRepository` 头注释）；
 * - `origin_url` 才是可核验来源，同步只发它。
 *
 * 降级：离线/无 provider → `enrichOnline` 只返回本地，**不报错**。
 */

import type { AssociationKind, AssociationRecord, AssociationRepository } from '@woyao/data';

import {
  LOCAL_USER_SOURCE_ID,
  addAssociationInputSchema,
  enrichAssociationInputSchema,
  listAssociationsInputSchema,
  parseOrThrow,
  removeAssociationInputSchema,
} from './dto';
import { ServiceNotFoundError } from './errors';
import type { OnlineService } from './onlineService';
import type { Asyncify, ServiceContext } from './ports';
import { ensureUserSource } from './sourceBootstrap';

/** 联想服务契约。 */
export interface AssociationService {
  listAssociations(input: { wordId: string }): Promise<AssociationRecord[]>;
  addAssociation(input: {
    wordId: string;
    kind: AssociationKind;
    text: string;
    originUrl?: string | null;
  }): Promise<AssociationRecord>;
  removeAssociation(input: { id: string }): Promise<void>;
  enrichOnline(input: { wordId: string; kind: AssociationKind }): Promise<AssociationRecord[]>;
}

/** 构造参数。 */
export interface AssociationServiceOptions {
  readonly context: ServiceContext;
  /** 联想仓储（异步视图）。 */
  readonly associations: Asyncify<AssociationRepository>;
  /** 在线服务（在线补联想）。 */
  readonly online: OnlineService;
  /** 归属范围；缺省 `LOCAL`（与 `LibraryService` 同一套语义）。 */
  readonly ownerScope?: string;
}

/** 默认归属范围。 */
const DEFAULT_OWNER_SCOPE = 'LOCAL';

/**
 * 创建联想服务。
 *
 * @param options 上下文、联想仓储与在线服务。
 * @returns 联想服务实例。
 */
export function createAssociationService(options: AssociationServiceOptions): AssociationService {
  const { context, associations, online } = options;
  const ownerScope = options.ownerScope ?? DEFAULT_OWNER_SCOPE;

  /** 词条必须存在（写联想的外键会失败，这里先给出可读的 NOT_FOUND）。 */
  async function requireWord(wordId: string): Promise<{ id: string; lemma: string }> {
    const word = await context.repos.words.getWordById(wordId);
    if (word === null) {
      throw new ServiceNotFoundError('word', wordId);
    }
    return { id: word.id, lemma: word.lemma };
  }

  return {
    async listAssociations(input: { wordId: string }): Promise<AssociationRecord[]> {
      const { wordId } = parseOrThrow(listAssociationsInputSchema, input, '列出联想');
      return associations.listAssociations(wordId);
    },

    async addAssociation(input: {
      wordId: string;
      kind: AssociationKind;
      text: string;
      originUrl?: string | null;
    }): Promise<AssociationRecord> {
      const validated = parseOrThrow(addAssociationInputSchema, input, '新增联想');
      await requireWord(validated.wordId);
      // 复用 libraryService 的来源引导（同一份 local-user 来源，不另建一份）。
      await ensureUserSource(context, ownerScope);
      return associations.upsertAssociation({
        wordId: validated.wordId,
        kind: validated.kind,
        text: validated.text,
        originUrl: validated.originUrl ?? null,
        assetUri: null,
        sourceId: LOCAL_USER_SOURCE_ID,
        generatedBy: 'USER',
        deviceId: context.device.deviceId(),
        now: context.clock.now(),
      });
    },

    async removeAssociation(input: { id: string }): Promise<void> {
      const { id } = parseOrThrow(removeAssociationInputSchema, input, '删除联想');
      // 软删对不存在/已删的 id 是空操作（幂等），符合“取消一个联想不该报错”的语义。
      await associations.deleteAssociation(id, context.device.deviceId(), context.clock.now());
    },

    async enrichOnline(input: {
      wordId: string;
      kind: AssociationKind;
    }): Promise<AssociationRecord[]> {
      const { wordId, kind } = parseOrThrow(enrichAssociationInputSchema, input, '在线补联想');
      const word = await requireWord(wordId);

      const local = await associations.listAssociations(wordId);
      // 离线/无 provider → 只返回本地，不报错。
      const hints = await online.lookupAssociations({ lemma: word.lemma, kind });

      // 去重口径：同 kind + text 已在本地就不落库（避免每次 enrich 都插一批重复行）。
      const existingKeys = new Set(local.map((item) => `${item.kind}:${item.text}`));
      for (const hint of hints) {
        if (existingKeys.has(`${hint.kind}:${hint.text}`)) {
          continue;
        }
        await associations.upsertAssociation({
          wordId,
          kind: hint.kind,
          text: hint.text,
          originUrl: hint.originUrl,
          assetUri: null,
          // 在线补的联想也挂在 local-user 来源下（V1.0 没有在线来源表），
          // generatedBy='ONLINE' 记录真实出处，originUrl 保留可核验来源。
          sourceId: LOCAL_USER_SOURCE_ID,
          generatedBy: 'ONLINE',
          deviceId: context.device.deviceId(),
          now: context.clock.now(),
        });
        existingKeys.add(`${hint.kind}:${hint.text}`);
      }

      // 重新读一遍：保证返回的排序与 `listAssociations` 一致（kind, createdAt）。
      return associations.listAssociations(wordId);
    },
  };
}
