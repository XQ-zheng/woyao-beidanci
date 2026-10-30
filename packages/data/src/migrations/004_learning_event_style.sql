-- 004：学习事件记录「作答时的题型」（CHOICE / REVEAL）。
-- 用途：混合题型（MIXED）下，掌握判定要求选择题与自评各自答对达标，
-- 因此必须能按题型分组统计答对次数；历史行默认按 REVEAL（自评）归类。
ALTER TABLE learning_events ADD COLUMN question_style TEXT NOT NULL DEFAULT 'REVEAL';
