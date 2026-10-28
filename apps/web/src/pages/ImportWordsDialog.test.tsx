import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices } from '../test/fakeServices';
import { appTheme } from '../theme';
import ImportWordsDialog from './ImportWordsDialog';

/** 用真实主题渲染导入弹窗。 */
function renderDialog(overrides: Parameters<typeof createFakeServices>[0] = {}): void {
  render(
    <ThemeProvider theme={appTheme}>
      <ServiceProvider services={createFakeServices(overrides)}>
        <ImportWordsDialog
          open
          deckId="deck-1"
          deckName="测试词库"
          onClose={() => undefined}
          onImported={() => undefined}
        />
      </ServiceProvider>
    </ThemeProvider>,
  );
}

describe('ImportWordsDialog：手动输入导入', () => {
  it('解析每行一个单词/短语并预览', async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('每行一个单词或短语'), {
      target: { value: 'abandon\ngive up\napple\napple' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并预览' }));

    // 去重后 3 条（apple 重复）
    expect(await screen.findByText('待导入（3 条）')).toBeInTheDocument();
    expect(screen.getByText('abandon')).toBeInTheDocument();
    expect(screen.getByText('give up')).toBeInTheDocument();
  });

  it('无有效内容时提示错误', async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('每行一个单词或短语'), {
      target: { value: '12345\n@#$' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并预览' }));

    expect(await screen.findByText(/没有识别到有效的英文单词或短语/)).toBeInTheDocument();
  });

  it('确认导入调用 importWords 并显示报告', async () => {
    const importWords = vi.fn(async () => ({
      imported: 2,
      duplicates: 0,
      backfilled: 0,
      skipped: [],
      rows: [],
    }));
    renderDialog({ import: { importWords } });

    fireEvent.change(screen.getByLabelText('每行一个单词或短语'), {
      target: { value: 'abandon\nknowledge' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并预览' }));
    await screen.findByText('待导入（2 条）');

    fireEvent.click(screen.getByRole('button', { name: /导入 2 个词/ }));

    await waitFor(() =>
      expect(importWords).toHaveBeenCalledWith({
        deckId: 'deck-1',
        terms: [
          { lemma: 'abandon', phrase: false },
          { lemma: 'knowledge', phrase: false },
        ],
      }),
    );
    expect(await screen.findByText(/新增 2 个，已存在 0 个，补全释义 0 个/)).toBeInTheDocument();
  });

  it('AI 释义失败的词条在报告里列出跳过原因', async () => {
    const importWords = vi.fn(async () => ({
      imported: 1,
      duplicates: 0,
      backfilled: 0,
      skipped: [{ lemma: 'mystery', reason: '额度用尽' }],
      rows: [],
    }));
    renderDialog({ import: { importWords } });

    fireEvent.change(screen.getByLabelText('每行一个单词或短语'), {
      target: { value: 'apple\nmystery' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并预览' }));
    await screen.findByText('待导入（2 条）');
    fireEvent.click(screen.getByRole('button', { name: /导入 2 个词/ }));

    expect(await screen.findByText(/1 个词条因 AI 释义生成失败被跳过/)).toBeInTheDocument();
    expect(screen.getByText(/mystery/)).toBeInTheDocument();
  });
});

describe('ImportWordsDialog：文件导入', () => {
  it('无桌面桥时提示需在桌面端使用', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('tab', { name: '图片 / 文档' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    expect(await screen.findByText(/当前环境不支持文件导入/)).toBeInTheDocument();
  });
});
