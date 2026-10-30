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

describe('LibraryPage：义项增删（R1）', () => {
  it('展开后每个义项有「删除义项」按钮，义项列表末尾有「+ 添加义项」', async () => {
    renderLibrary(
      createFakeServices({
        library: { listDeckWords: vi.fn(async () => [makeDeckWord()]) },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));

    expect(await screen.findByRole('button', { name: '删除义项 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加义项' })).toBeInTheDocument();
  });

  it('点「删除义项」移除对应表单（不再有义项输入框），保存时也不传它', async () => {
    const replaceWordSenses = vi.fn(async () => []);
    const word = makeDeckWord({
      senses: [
        { senseNo: 1, pos: 'v.', simpleZh: '放弃', detailedZh: null, contextText: null },
        { senseNo: 2, pos: 'n.', simpleZh: '放纵', detailedZh: null, contextText: null },
      ],
    });
    renderLibrary(
      createFakeServices({
        library: { listDeckWords: vi.fn(async () => [word]), replaceWordSenses },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));
    expect((await screen.findAllByLabelText('简明释义')).length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: '删除义项 1' }));
    // 只剩第 2 条义项（序号重排由服务层负责，界面按数组序展示）。
    expect(screen.getAllByLabelText('简明释义')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('简明释义'), { target: { value: '新的释义' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(replaceWordSenses).toHaveBeenCalledWith({
        wordId: 'w-abandon',
        senses: [{ pos: 'n.', simpleZh: '新的释义', detailedZh: null }],
      }),
    );
  });

  it('点「+ 添加义项」追加空白表单；空简明释义在保存时跳过并提示', async () => {
    const replaceWordSenses = vi.fn(async () => []);
    renderLibrary(
      createFakeServices({
        library: { listDeckWords: vi.fn(async () => [makeDeckWord()]), replaceWordSenses },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));
    expect(await screen.findByLabelText('简明释义')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加义项' }));
    const fields = screen.getAllByLabelText('简明释义');
    expect(fields).toHaveLength(2);

    // 第二条留空：保存时跳过，只传有内容的第一条。
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(replaceWordSenses).toHaveBeenCalledWith({
        wordId: 'w-abandon',
        senses: [{ pos: 'v.', simpleZh: '放弃', detailedZh: '丢开、舍弃' }],
      }),
    );
    expect(await screen.findByText(/跳过了 1 条/)).toBeInTheDocument();
  });

  it('全部义项都删光/为空时不允许保存并提示', async () => {
    const replaceWordSenses = vi.fn(async () => []);
    renderLibrary(
      createFakeServices({
        library: { listDeckWords: vi.fn(async () => [makeDeckWord()]), replaceWordSenses },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));
    await screen.findByLabelText('简明释义');

    fireEvent.click(screen.getByRole('button', { name: '删除义项 1' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText(/至少保留一条/)).toBeInTheDocument();
    expect(replaceWordSenses).not.toHaveBeenCalled();
  });
});

describe('LibraryPage：干扰词设置（R5）', () => {
  it('保存干扰词：输入框逗号分隔解析，调 setWordDistractors 并回显', async () => {
    const setWordDistractors = vi.fn(async (input: { lemmas: readonly string[] }) => [
      ...input.lemmas,
    ]);
    renderLibrary(
      createFakeServices({
        library: {
          listDeckWords: vi.fn(async () => [makeDeckWord()]),
          listWordDistractors: vi.fn(async () => []),
          setWordDistractors,
        },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));
    await screen.findByLabelText('自定义干扰词');

    fireEvent.change(screen.getByLabelText('自定义干扰词'), {
      target: { value: 'absorb, maintain admire' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存干扰词' }));

    await waitFor(() =>
      expect(setWordDistractors).toHaveBeenCalledWith({
        wordId: 'w-abandon',
        lemmas: ['absorb', 'maintain', 'admire'],
      }),
    );
    expect(await screen.findByText(/已保存干扰词/)).toBeInTheDocument();
  });

  it('展开时回显已保存的干扰词', async () => {
    renderLibrary(
      createFakeServices({
        library: {
          listDeckWords: vi.fn(async () => [makeDeckWord()]),
          listWordDistractors: vi.fn(async () => ['absorb', 'maintain']),
        },
      }),
    );
    fireEvent.click(await screen.findByText('abandon'));

    expect(await screen.findByLabelText('自定义干扰词')).toHaveValue('absorb, maintain');
  });
});
