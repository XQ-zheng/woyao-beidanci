# 「我要背单词」V1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a local-first, cross-platform English vocabulary trainer named “我要背单词”, with spaced repetition, mistake tracking, multi-format export, cloud sync, and a Windows installer.

**Architecture:** React + TypeScript shared UI and core; Electron desktop shell; Capacitor mobile shell; SQLite as local source of truth; WorkBuddy Cloud Service for auth, sync, and LLM when verified. The app is modular-monolith, local-first, and uses ports/adapters so UI and core stay platform-neutral.

**Tech Stack:** Vite, React, TypeScript, MUI, Tailwind CSS, Zustand, zod, Electron, Capacitor, better-sqlite3, docx, exceljs, pdfkit, Vitest, React Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-woyaobeidanci-design.md`

## Global Constraints

- Use npm workspaces; package names are `@woyao/web`, `@woyao/core`, `@woyao/data`, `@woyao/services`, `@woyao/cloud`, `@woyao/exporters`, `@woyao/assets`, `@woyao/electron`, `@woyao/mobile`.
- Keep all data local-first; SQLite is the source of truth, UI state is not.
- Do not use proprietary content from Youdao or “图样单词”; only use verified open or licensed resources.
- Main UI is white background with black text; correct answers use green, wrong answers use red, with text or icon labels.
- Windows is the required delivery platform; other platforms only claim what is actually built and verified.
- Use WorkBuddy Cloud Service only after activation; if Origin/CORS or token tests fail, stop and report, do not fake success.
- All tests must pass before commit; each task ends with a commit.

## Review Focus

- Same word wrong twice across sessions must show a cumulative mistake prompt.
- Duplicate sync events must not double-count learning progress.
- Changing the daily plan mid-day must not rewrite completed history.
- Export must still work when the app is offline.
- Mobile safe-area must not cover answer options or submit buttons.

---

### Task 1: Workspace scaffold and base web shell

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `eslint.config.js`, `.gitignore`, `index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/router.tsx`, `apps/web/src/theme.ts`, `apps/web/src/styles.css`, `apps/web/src/bootstrap.ts`

**Interfaces:**
- Produces: a runnable `@woyao/web` package with routes and theme only; no data logic yet.
- Consumes: none.

- [ ] **Step 1: Create npm workspace and base configs**

Initialize `package.json` with workspaces for `apps/*` and `packages/*`, add scripts `dev`, `build`, `typecheck`, `lint`, and `test`. Create `tsconfig.base.json` with strict mode and path aliases for each workspace.

- [ ] **Step 2: Create web shell with theme and router**

Create `apps/web` package with React entry, router, and a MUI theme using white background and black text. Add placeholder routes for Today, Library, Notebook, Mistakes, History, Assessment, Settings, Account.

- [ ] **Step 3: Install dependencies and verify build**

Run: `npm install && npm run typecheck && npm run build --workspace @woyao/web`
Expected: typecheck passes and web build succeeds.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vite.config.ts tailwind.config.ts postcss.config.js eslint.config.js .gitignore index.html apps/web
git commit -m "chore: scaffold web workspace and theme"
```

---

### Task 2: Core learning models and scheduler

**Files:**
- Create: `packages/core/src/models.ts`, `packages/core/src/scheduler.ts`, `packages/core/src/queue.ts`, `packages/core/src/clock.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/scheduler.test.ts`, `packages/core/src/queue.test.ts`

**Interfaces:**
- Produces:
  - `export type Recognition = 'KNOWN' | 'UNKNOWN'`
  - `export type TrainingMode = 'EN_TO_ZH' | 'ZH_TO_EN' | 'MIXED'`
  - `export interface LearningState { userWordId: string; deckId: string; wordId: string; stage: number; dueAt: string; lastReviewedAt: string | null; correctCount: number; wrongCount: number; streakCorrect: number; weight: number; suppressedAt: string | null }`
  - `export interface ReviewPlan { intervalsDays: number[]; dailyNewLimit: number; dailyReviewLimit: number; timeZone: string }`
  - `export interface AnswerInput { isCorrect: boolean; recognition: Recognition; mode: TrainingMode; answeredAt: string }`
  - `export function nextLearningState(state: LearningState, answer: AnswerInput, plan: ReviewPlan, now: Date): LearningState`
  - `export function buildDailyQueue(states: LearningState[], unseenWordIds: string[], plan: ReviewPlan, now: Date, seed: string): { reviewWordIds: string[]; newWordIds: string[]; interleavedWordIds: string[] }`
- Consumes: none.

- [ ] **Step 1: Write failing scheduler tests**

Tests must cover: new word initial `stage=-1`; first correct+known answer moves to `stage=0` and schedules +1 day; wrong answer schedules +10 minutes; stage increments only on correct+known; wrong decrements stage; weight multipliers 1.75/0.8 with bounds 0.25–4.0; custom intervals 1–365 days, 1–12 nodes.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/core`
Expected: FAIL because scheduler functions are missing.

- [ ] **Step 3: Implement scheduler and queue**

Implement `nextLearningState` and `buildDailyQueue` using the exact rules from the spec. Use injected `now` and `seed`; do not read system time inside the core.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/core`
Expected: PASS all scheduler and queue tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add learning state scheduler and daily queue"
```

---

### Task 3: Distractors, assessment, and frequency classification

**Files:**
- Create: `packages/core/src/distractors.ts`, `packages/core/src/assessment.ts`, `packages/core/src/frequency.ts`
- Test: `packages/core/src/distractors.test.ts`, `packages/core/src/assessment.test.ts`, `packages/core/src/frequency.test.ts`

**Interfaces:**
- Produces:
  - `export interface WordWithSenses { wordId: string; lemma: string; pos: string; senses: string[] }`
  - `export function generateDistractors(target: WordWithSenses, candidates: WordWithSenses[], mode: TrainingMode, seed: string): string[]`
  - `export interface AssessmentEvent { wordId: string; isCorrect: boolean; recognition: Recognition; answeredAt: string; dueAt?: string }`
  - `export interface AssessmentResult { score: number; level: 'STABLE' | 'SOLID' | 'BUILDING' | 'NEEDS_WORK' | 'INSUFFICIENT_SAMPLE'; coverage: number; confidence: number; distinctWords: number; validAnswers: number; suggestions: string[]; algorithmVersion: string; generatedAt: string; windowStart: string; windowEnd: string }`
  - `export function evaluateAssessment(events: AssessmentEvent[], deckSize: number, now: Date): AssessmentResult`
  - `export interface FrequencyEntry { wordId: string; frequency: number; rank?: number; equalCount?: number; corpusVersion: string; sourceId: string }`
  - `export function classifyFrequencyImportance(entry: FrequencyEntry | null, knownWordCount: number): 'HIGH' | 'MEDIUM' | 'BASIC' | 'UNKNOWN'`
- Consumes: `LearningState`, `TrainingMode`, `Recognition` from Task 2.

- [ ] **Step 1: Write failing tests for each function**

Cover: distractor uniqueness, no duplicate answer, similar Part-of-speech and spelling preference, stable seed; assessment sample thresholds and score boundaries; frequency importance percentiles and unknown fallback.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/core`
Expected: FAIL for missing functions.

- [ ] **Step 3: Implement distractors, assessment, and frequency**

Use the exact formulas from the spec: distractor similarity, weighted assessment score, and P90/P60/P0 frequency classification.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add distractors, assessment, and frequency rules"
```

---

### Task 4: SQLite data layer and repositories

**Files:**
- Create: `packages/data/src/migrations/001_init.sql`, `packages/data/src/migrations/002_sync.sql`
- Create: `packages/data/src/connection.ts`, `packages/data/src/transaction.ts`, `packages/data/src/wordRepository.ts`, `packages/data/src/learningRepository.ts`, `packages/data/src/syncRepository.ts`, `packages/data/src/settingsRepository.ts`
- Test: `packages/data/src/repositories.test.ts`, `packages/data/src/syncRepository.test.ts`

**Interfaces:**
- Produces:
  - `export function openDatabase(path: string): Database`
  - `export function migrate(db: Database): void`
  - `export interface WordRepository { createWord(input: WordInput): WordRecord; getWordByLemma(lemma: string): WordRecord | null; listSenses(wordId: string): WordSenseRecord[] }`
  - `export interface LearningRepository { appendEventAndUpdateState(event: LearningEventRecord, state: LearningState): void; getState(userWordId: string): LearningState | null; listDue(deckId: string, now: Date): LearningState[] }`
  - `export interface SyncRepository { enqueueOutbox(change: EntityChange): void; listOutbox(): EntityChange[]; markSynced(entityId: string): void }`
  - `export interface SettingsRepository { get(key: string): string | null; set(key: string, value: string): void }`
- Consumes: `LearningState` from Task 2.

- [ ] **Step 1: Write failing repository tests**

Tests must cover: migration creates all tables; `appendEventAndUpdateState` is transactional and idempotent by `eventId`; duplicate event does not increment counts; outbox write and event write are in the same transaction; account-scoped data does not leak across namespaces.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/data`
Expected: FAIL because migrations and repositories are missing.

- [ ] **Step 3: Implement migrations and repositories**

Use `better-sqlite3` and the schema from the architecture doc. Keep `event_id` as primary key for learning events. Wrap every mutation in a transaction.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/data`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/data
git commit -m "feat(data): add sqlite migrations and repositories"
```

---

### Task 5: Application services and provider ports

**Files:**
- Create: `packages/services/src/studyService.ts`, `packages/services/src/contentService.ts`, `packages/services/src/authService.ts`, `packages/services/src/syncService.ts`, `packages/services/src/exportService.ts`, `packages/services/src/associationService.ts`, `packages/services/src/onlineService.ts`, `packages/services/src/ports.ts`, `packages/services/src/dto.ts`
- Test: `packages/services/src/studyService.test.ts`, `packages/services/src/syncService.test.ts`, `packages/services/src/exportService.test.ts`

**Interfaces:**
- Produces:
  - `export interface StudyService { startSession(deckId: string, now: Date): Promise<SessionView>; submitAnswer(command: SubmitAnswerCommand): Promise<AnswerResult>; finishSession(sessionId: string): Promise<SessionSummary> }`
  - `export interface ContentService { getWordContent(wordId: string): Promise<WordContentResult>; getPronunciation(wordId: string, accent: 'uk'|'us'): Promise<AudioResult> }`
  - `export interface AuthService { signIn(input: SignInInput): Promise<AuthSession>; refresh(session: AuthSession): Promise<AuthSession>; signOut(session: AuthSession): Promise<void> }`
  - `export interface SyncService { synchronize(): Promise<SyncReport>; resolveConflict(id: string, resolution: ConflictResolution): Promise<void> }`
  - `export interface ExportService { exportHistory(format: ExportFormat, range: DateRange, destination: string): Promise<ExportReceipt>; exportNotebook(format: ExportFormat, notebookId: string, destination: string): Promise<ExportReceipt>; exportDeck(format: ExportFormat, deckId: string, destination: string): Promise<ExportReceipt> }`
- Consumes: repositories from Task 4, core functions from Tasks 2–3.

- [ ] **Step 1: Write failing service tests**

Cover: session creation and answer submission persist event and state; same word wrong twice returns cumulative wrong count; plan change with `effective_local_date` does not rewrite completed sessions; sync duplicate event is ignored; export receives correct DTO.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/services`
Expected: FAIL because services are missing.

- [ ] **Step 3: Implement services with ports**

Implement services as pure orchestration over repository and provider ports. Use zod DTOs. Keep business rules in core, not in services.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/services`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/services
git commit -m "feat(services): add study, content, sync, auth, and export services"
```

---

### Task 6: Shared web UI and interactions

**Files:**
- Create: `apps/web/src/pages/TodayPage.tsx`, `StudyPage.tsx`, `ReviewPage.tsx`, `LibraryPage.tsx`, `NotebookPage.tsx`, `MistakesPage.tsx`, `HistoryPage.tsx`, `AssessmentPage.tsx`, `SettingsPage.tsx`, `AccountPage.tsx`
- Create: `apps/web/src/components/WordCard.tsx`, `AnswerFeedback.tsx`, `AssociationPanel.tsx`, `SourceBadge.tsx`, `ConflictDialog.tsx`, `AppNavigation.tsx`
- Test: `apps/web/src/pages/StudyPage.test.tsx`, `apps/web/src/pages/SettingsPage.test.tsx`, `apps/web/src/components/AnswerFeedback.test.tsx`

**Interfaces:**
- Consumes: services from Task 5.
- Produces: UI routes and components that call services through a provider context.

- [ ] **Step 1: Write failing UI tests**

Cover: study page shows word, phonetics, answer options, UK/US pronunciation, favorite, detail, and volume controls; wrong answer shows red feedback and cumulative wrong count when ≥2; settings page exposes font size, volume, daily new/review limits, training mode, and desktop-specific autostart/tray toggles; no key controls overlap at 1280×800 and 390×844.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/web`
Expected: FAIL because pages/components are missing.

- [ ] **Step 3: Implement pages and components**

Use MUI + Tailwind. Keep the black/white theme. Use accessible labels and keyboard support. Mobile uses bottom navigation; desktop uses sidebar.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): add study, review, library, mistakes, history, assessment, and settings UI"
```

---

### Task 7: Electron desktop shell and secure IPC

**Files:**
- Create: `apps/electron/src/main/index.ts`, `window.ts`, `ipc.ts`, `database.ts`, `secureStore.ts`, `files.ts`, `tray.ts`, `autoLaunch.ts`
- Create: `apps/electron/src/preload/index.ts`, `apps/electron/electron-builder.yml`
- Test: `apps/electron/src/ipc.test.ts`, `tests/e2e/study.spec.ts`

**Interfaces:**
- Consumes: services from Task 5, repositories from Task 4.
- Produces: desktop app window with secure preload API and tray/autostart settings.

- [ ] **Step 1: Write failing IPC and E2E smoke tests**

Cover: preload exposes only whitelisted methods; submitAnswer persists and returns result; tray menu open/exit works; autostart and tray default to false; window title is “我要背单词”.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/electron && npx playwright test tests/e2e/study.spec.ts`
Expected: FAIL because Electron shell is missing.

- [ ] **Step 3: Implement Electron main, preload, tray, and autolaunch**

Use context isolation, no `nodeIntegration`, fixed IPC channels, zod-validated payloads, and system keychain via keytar or OS-equivalent. Keep SQLite in the main process.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/electron && npx playwright test tests/e2e/study.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/electron tests/e2e/study.spec.ts
git commit -m "feat(electron): add desktop shell, secure IPC, tray, and autostart"
```

---

### Task 8: Local exporters for Word, PDF, and Excel

**Files:**
- Create: `packages/exporters/src/exportModel.ts`, `docxExporter.ts`, `pdfExporter.ts`, `xlsxExporter.ts`, `fonts/LICENSE.md`
- Test: `packages/exporters/src/exporters.test.ts`

**Interfaces:**
- Produces:
  - `export function exportToDocx(model: ExportModel, destination: string): Promise<void>`
  - `export function exportToPdf(model: ExportModel, destination: string): Promise<void>`
  - `export function exportToXlsx(model: ExportModel, destination: string): Promise<void>`
- Consumes: `ExportModel` from services.

- [ ] **Step 1: Write failing exporter tests**

Cover: Chinese characters render; multi-sense long text wraps; docx and xlsx contain expected headers and rows; xlsx enables filter and freezes header; PDF has page numbers and repeated header; cells starting with `=`, `+`, `-`, `@` are escaped; export works with network disabled.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/exporters`
Expected: FAIL because exporters are missing.

- [ ] **Step 3: Implement exporters**

Use `docx`, `exceljs`, and `pdfkit`. Embed a redistributable Chinese font. Use A4 layout and repeated table headers.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/exporters`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/exporters
git commit -m "feat(exporters): add docx, pdf, and xlsx export"
```

---

### Task 9: Asset manifests and import scripts

**Files:**
- Create: `packages/assets/dictionaries/manifest.json`, `packages/assets/frequency/manifest.json`, `packages/assets/audio/manifest.json`, `packages/assets/associations/manifest.json`, `packages/assets/licenses/THIRD_PARTY.md`
- Create: `scripts/validate-assets.ts`, `scripts/import-dictionary.ts`, `scripts/import-frequency.ts`
- Test: `scripts/validate-assets.test.ts`, `scripts/import-dictionary.test.ts`, `scripts/import-frequency.test.ts`

**Interfaces:**
- Produces: manifests and import functions for verified open data.
- Consumes: `FrequencyEntry` from Task 3.

- [ ] **Step 1: Write failing manifest and import tests**

Cover: manifest entries require source, license, version, checksum; ECDICT import maps lemma, phonetics, and CET/NETEM tags; NETEM import preserves frequency and corpus version; unknown frequency maps to `UNKNOWN`; license mismatch blocks import.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/assets`
Expected: FAIL because scripts are missing.

- [ ] **Step 3: Implement asset validation and import scripts**

Use ECDICT and `exam-data/NETEMVocabulary` fixtures. Store source metadata separately from code license. Do not commit unverified proprietary content.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/assets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/assets scripts
git commit -m "feat(assets): add resource manifests and import scripts"
```

---

### Task 10: WorkBuddy Cloud Service activation and gateway spike

**Files:**
- Create: `packages/cloud/src/workbuddyGateway.ts`, `cloudContracts.ts`, `originPolicy.ts`, `config.ts`, `docs/cloud-spike.md`
- Test: `packages/cloud/src/workbuddyGateway.test.ts`

**Interfaces:**
- Produces: `CloudGateway` implementation and compatibility report.
- Consumes: `AuthSession`, `LearningEventDTO`, `EntityChange` from services.

- [ ] **Step 1: Activate cloud service and capture publicConfig**

Use the trusted WorkBuddy UI to activate Auth, Database, and LLM. Save the real publicConfig only in runtime config, not in source control.

- [ ] **Step 2: Write failing gateway tests**

Cover: signIn, refresh, signOut, pull, appendEvents, upsertEntities, translate. Tests must fail if Origin/CORS or token refresh is unsupported.

- [ ] **Step 3: Run tests and verify failure or compatibility**

Run: `npm test --workspace @woyao/cloud`
Expected: either PASS with verified compatibility, or FAIL with a clear origin/CORS report. Do not fake success if incompatible.

- [ ] **Step 4: Implement gateway or block release**

If tests pass, implement `CloudGateway` with the real SDK. If tests fail, document the exact blocker in `docs/cloud-spike.md` and stop before release; do not silently switch to localStorage or fake sync.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud docs/cloud-spike.md
git commit -m "feat(cloud): add WorkBuddy Cloud gateway and compatibility spike"
```

---

### Task 11: Capacitor mobile project and platform adaptation

**Files:**
- Create: `apps/mobile/capacitor.config.ts`, `apps/mobile/package.json`, `apps/mobile/src/native/database.ts`, `secureStore.ts`, `files.ts`, `cloudBridge.ts`
- Create: `apps/mobile/android/`, `apps/mobile/ios/` configuration and source scaffolding only
- Test: `apps/mobile/src/native/database.test.ts`

**Interfaces:**
- Produces: mobile project that can build against the shared web UI.
- Consumes: services and cloud gateway.

- [ ] **Step 1: Write failing mobile adapter tests**

Cover: SQLite open/migrate on mobile adapter; secure store does not use localStorage; file export path is app cache and uses system share; cloud bridge respects origin policy.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @woyao/mobile`
Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement Capacitor config and native adapters**

Use `@capacitor-community/sqlite`, secure storage plugin, filesystem, and share. Keep desktop-only settings hidden on mobile.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test --workspace @woyao/mobile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add Capacitor project and native adapters"
```

---

### Task 12: Release packaging, icon, README, and V1.0 assets

**Files:**
- Create: `README.md`, `LICENSE`, `THIRD_PARTY.md`, `docs/build-windows.md`, `docs/build-mobile.md`, `docs/privacy-security.md`, `apps/electron/resources/icon.png`, `.github/workflows/release.yml`
- Modify: `apps/electron/electron-builder.yml`
- Test: `tests/e2e/release.spec.ts`

**Interfaces:**
- Produces: Windows installer and release metadata.
- Consumes: all previous tasks.

- [ ] **Step 1: Create app icon and release metadata**

Use a black/white book or letter-based icon matching the app theme. Write README covering install, login, sync, data sources, privacy, export, platform limits, and source build. Add MIT `LICENSE` and `THIRD_PARTY.md`.

- [ ] **Step 2: Write failing release smoke test**

Cover: package builds, installer metadata is correct, app launches with correct title, tray/autostart default off, and export files are present after a sample run.

- [ ] **Step 3: Run release test and verify failure**

Run: `npm run build && npx playwright test tests/e2e/release.spec.ts`
Expected: FAIL until packaging is complete.

- [ ] **Step 4: Build Windows installer and verify**

Run: `npm run build && npm run dist --workspace @woyao/electron`
Expected: a real Windows installer is produced and launch-tested. Only claim platforms that are actually built.

- [ ] **Step 5: Commit**

```bash
git add README.md LICENSE THIRD_PARTY.md docs apps/electron/resources/icon.png .github/workflows/release.yml
git commit -m "chore(release): add V1.0 packaging, icon, README, and release workflow"
```

---

## Contract Updates

- D-01 (approved during Task 3): `ReviewPlan` requires an IANA `timeZone`; `AssessmentResult` includes required `algorithmVersion`, `generatedAt`, `windowStart`, `windowEnd`; `FrequencyEntry` supports `equalCount` for tied frequency ranks. Task 4/5/6 must use this shape, not the earlier 7-field assessment or 3-field ReviewPlan. **Authoritative source of truth is what `packages/core/src` actually exports** (`AssessmentResult` 11 fields, `ReviewPlan` 4 fields, `FrequencyEntry` 5 fields with optional `rank`/`equalCount`); the Interface blocks below are a summary and drift must be resolved in favor of the code. Historical task briefs under `.superpowers/sdd/` are snapshots and carry no authority once code exists.
- D-02 (approved before Task 4): `frequency_entries` gains an `equal_count` column because §8 defines `percentile=(less+0.5*equal)/knownWordCount`; `rank` is the first index of a tie group (1-based competition rank) and `equal_count` is that group's size. A corpus import must satisfy three conditions: `COUNT(*) == knownWordCount` (one row per word), each row's `equal_count` equals the size of its own tie group (rows sharing that `rank`), and equal `rank` implies equal `frequency`. **Do not phrase this as `SUM(equal_count) == knownWordCount`** — a tie group of size s contributes s² when summed over rows, so that form only holds when there are no ties at all and would forbid the very case the column exists for (corrected in the Task 4 fix round after the implementer caught the arithmetic error). The column is `equal_count INTEGER NOT NULL DEFAULT 1 CHECK (equal_count >= 1)` — NULL is not allowed because a nullable column makes the group-size comparison silently skip rows. Task 4 owns the column and the import-time assertion; Task 9 owns producing real data; Task 5/6 read `FrequencyEntry` with `rank` and `equalCount` populated.
- D-05 (approved during Task 5B): `learning_events` gains a nullable `due_at` column and `LearningEventRecord` gains `dueAt: string | null`, because the assessment M component (`AssessmentEvent.dueAt`) has no value to read otherwise and M permanently degrades to the neutral 0.5. Semantics: a review answer records the due time it was fulfilling (`learning_state.dueAt` before answering); a first answer on a brand-new word (`stageBefore === -1`) has no "due" concept and writes `null`, so new-word answers are excluded from M. Task 5B owns the column, the event write, and the assessment projection; Task 6 must surface M only when the sample is non-neutral (core already emits the "复习样本不足" note).

## Execution Notes

- Tasks 2–5 build the shared domain and services; Task 6 consumes them in UI.
- Tasks 7, 8, 9, 10, 11, and 12 can partially parallelize after Task 5, but cloud and release depend on earlier results.
- Each task must pass its own tests before commit. Do not proceed with failing tests.
- If WorkBuddy Cloud is incompatible with Electron/Capacitor, report the blocker and pause release rather than using a fake gateway.
- Do not claim macOS/iOS/Android installers unless actually built and verified in this environment.
