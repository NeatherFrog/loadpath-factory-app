import type { Project, ScoreBreakdown } from './types';

// Weights reflect the goal: farm points cheaply and with a bot, on a project
// that is likely to pay out. They sum to 1.
export const SCORE_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  team: 0.12,
  funding: 0.1,
  traction: 0.12,
  tokenUpside: 0.18,
  pointsAccess: 0.14,
  automation: 0.14,
  farmCost: 0.1,
  risk: 0.1,
};

export const SCORE_LABELS: Record<keyof ScoreBreakdown, string> = {
  team: 'Команда',
  funding: 'Инвесторы',
  traction: 'Объёмы / OI',
  tokenUpside: 'Апсайд дропа',
  pointsAccess: 'Доступность поинтов',
  automation: 'API / бот',
  farmCost: 'Цена фарма',
  risk: 'Риски (10 = низкие)',
};

/** Weighted score on a 0-100 scale. */
export function projectScore(scores: ScoreBreakdown): number {
  let total = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof ScoreBreakdown)[]) {
    const value = Math.min(10, Math.max(0, scores[key] ?? 0));
    total += value * SCORE_WEIGHTS[key];
  }
  return Math.round(total * 10);
}

export function rankProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => projectScore(b.scores) - projectScore(a.scores));
}
