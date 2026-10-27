import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeckWordView } from '@woyao/services';

import { ServiceProvider } from '../services/ServiceProvider';
import { createFakeServices, makeDeck } from '../test/fakeServices';
import { appTheme } from '../theme';
import LibraryPage from './LibraryPage';

/** 造一个词表行。 */
function makeDeckWord(overrides: Partial<DeckWordView> = {}): DeckWordView {
  return {
    wordId: 'w-abandon',
    lemma: 'abandon',
    phoneticUk: 'əˈbændən',
    phoneticUs: 'əˈbændən',
    senses: [
      { senseNo: 1, pos: 'v.', simpleZh: '放弃', detailedZh: '丢开、舍弃', contextText: null },
    ],
    frequency: {
      importance: 'HIGH',
      frequency: 1200,
      rank: 800,
      totalTokens: 1000000,
      corpusVersion: '2026-10',
      sourceId: 'cet4',
    },
    ...overrides,
  };
}

/** 用真实主题渲染词库页。 */
function renderLibrary(services = createFakeServices()): void {
  render(
    <ThemeProvider theme={appTheme}>
      <ServiceProvider services={services}>
        <LibraryPage />
      </ServiceProvider>
    </ThemeProvider>,
  );
}

describe('LibraryPage：词库与词表', () => {
  it('列出词库，并展示词表的词形、音标与义项', async () => {
    const services = createFakeServices({
      library: {
        listDecks: vi.fn(async () => [makeDeck()]),
        listDeckWords: vi.fn(async () => [makeDeckWord()]),
      },
    });
    renderLibrary(services);

    // 词库名在“列表项”和“当前词库标题”各出现一次，所以按标题角色定位。
    expect(await screen.findByRole('heading', { level: 3, name: '四级核心词' })).toBeInTheDocument();
    expect(await screen.findByText('abandon')).toBeInTheDocument();
    expect(screen.getByText('/əˈbændən/')).toBeInTheDocument();
    expect(screen.getByText('放弃')).toBeInTheDocument();
  });

  it('词库为空时给出空态，不显示假的词表', async () => {
    const services = createFakeServices({ library: { listDecks: vi.fn(async () => []) } });
    renderLibrary(services);

    expect(await screen.findByText(/还没有词库/)).toBeInTheDocument();
  });

  it('词表为空时说明“还没有单词”', async () => {
    const services = createFakeServices({ library: { listDeckWords: vi.fn(async () => []) } });
    renderLibrary(services);

    expect(await screen.findByText(/这个词库还没有单词/)).toBeInTheDocument();
  });

  it('生词本不在词库页重复展示', async () => {
    const services = createFakeServices({
      library: {
        listDecks: vi.fn(async () => [
          makeDeck(),
          makeDeck({ deckId: 'deck-notebook', name: '生词本', kind: 'NOTEBOOK', wordCount: 3 }),
        ]),
      },
    });
    renderLibrary(services);

    expect((await screen.findAllByText('四级核心词')).length).toBeGreaterThan(0);
    expect(screen.queryByText('生词本')).toBeNull();
  });
});

describe('LibraryPage：新建与删除', () => {
  it('新建自建词库会调用 createDeck 并选中新词库', async () => {
    const createDeck = vi.fn(async ({ name }: { name: string }) =>
      makeDeck({ deckId: 'deck-new', name, kind: 'CUSTOM', wordCount: 0 }),
    );
    const services = createFakeServices({ library: { createDeck } });
    renderLibrary(services);

    fireEvent.change(await screen.findByLabelText('新词库名称'), { target: { value: '我的词库' } });
    fireEvent.click(screen.getByRole('button', { name: '新建自建词库' }));

    await waitFor(() => expect(createDeck).toHaveBeenCalledWith({ name: '我的词库' }));
    expect(await screen.findByText(/已创建词库「我的词库」/)).toBeInTheDocument();
  });

  it('名称为空时不发请求并给出提示', async () => {
    const createDeck = vi.fn(async () => makeDeck());
    const services = createFakeServices({ library: { createDeck } });
    renderLibrary(services);

    await screen.findByLabelText('新词库名称');
    fireEvent.click(screen.getByRole('button', { name: '新建自建词库' }));

    expect(await screen.findByText('请先填写词库名称。')).toBeInTheDocument();
    expect(createDeck).not.toHaveBeenCalled();
  });

  it('删除需要二次确认，确认后才调用 deleteDeck', async () => {
    const deleteDeck = vi.fn(async () => undefined);
    const services = createFakeServices({ library: { deleteDeck } });
    renderLibrary(services);

    fireEvent.click(await screen.findByRole('button', { name: '删除词库' }));
    expect(deleteDeck).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteDeck).toHaveBeenCalledWith('deck-cet4'));
    expect(await screen.findByText(/词库已删除/)).toBeInTheDocument();
  });
});
