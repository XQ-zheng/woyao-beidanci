/**
 * 云端登录凭据的本地安全存储。
 *
 * SDK 的 `storage` 是同步接口，所以这里用同步文件读写；内容用 Electron `safeStorage`
 * （Windows DPAPI / macOS Keychain）加密后落盘。**没有可用的系统加密时不退回明文**，
 * 宁可让云登录不可用，也不把 refresh token 平文写在磁盘上。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safeStorage } from 'electron';
import type { CloudAuthStorage } from '@tencent-ai/workbuddy-cloud-sdk';

/** 加密凭据文件。 */
export class EncryptedAuthStorage implements CloudAuthStorage {
  private readonly filePath: string;
  private cache: Record<string, string> | null = null;

  /**
   * @param filePath 加密文件绝对路径。
   */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 读取并解密；文件不存在时返回空表。 */
  private load(): Record<string, string> {
    if (this.cache !== null) {
      return this.cache;
    }
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，拒绝以明文保存登录凭据');
    }
    const decrypted = safeStorage.decryptString(readFileSync(this.filePath));
    const parsed: unknown = JSON.parse(decrypted);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('登录凭据文件格式损坏');
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        values[key] = value;
      }
    }
    this.cache = values;
    return values;
  }

  /** 加密并原子写盘。 */
  private persist(values: Record<string, string>): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，拒绝以明文保存登录凭据');
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(values)));
    renameSync(temporary, this.filePath);
    this.cache = values;
  }

  getItem(key: string): string | null {
    return this.load()[key] ?? null;
  }

  setItem(key: string, value: string): void {
    const values = { ...this.load(), [key]: value };
    this.persist(values);
  }

  removeItem(key: string): void {
    const values = { ...this.load() };
    delete values[key];
    this.persist(values);
  }
}
