/**
 * 本地自建内容来源的引导（`local-user`）。
 *
 * 为什么单独成文件：`libraryService.createWord` 与 `associationService.addAssociation`
 * 都要在写库前确保这个来源存在（`word_senses.source_id` / `associations.source_id` 有外键）。
 * 两份参数（id/name/type/redistributionAllowed）一旦漂移，就会出现两个“本地来源”，
 * 同步侧会看到两份来源、归属也会乱。所以这里只留一份。
 *
 * 幂等：`upsertSource` 对内容一致的行**不写、不推 revision**，重复调用无副作用。
 */

import { LOCAL_USER_SOURCE_ID, USER_SOURCE_NAME } from './dto';
import type { ServiceContext } from './ports';

/**
 * 确保本地自建内容来源存在（`type: 'USER'`、`redistributionAllowed: false`）。
 *
 * @param context 服务上下文。
 * @param ownerScope 归属范围（与要写的内容一致，登录用户挂在 `acct:<id>` 名下）。
 * @param sourceId 来源 id，缺省 `local-user`。
 */
export async function ensureUserSource(
  context: ServiceContext,
  ownerScope: string,
  sourceId: string = LOCAL_USER_SOURCE_ID,
): Promise<void> {
  await context.repos.words.upsertSource({
    id: sourceId,
    ownerScope,
    type: 'USER',
    name: USER_SOURCE_NAME,
    // 用户自建内容不允许随应用再分发（需求要求逐项核验许可，默认必须是最保守的那个）。
    redistributionAllowed: false,
    deviceId: context.device.deviceId(),
    now: context.clock.now(),
  });
}
