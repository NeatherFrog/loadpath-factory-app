import { useState } from 'react';
import type { Project, ResearchFeed, ScoreBreakdown } from '../../shared/types';
import { projectScore, rankProjects, SCORE_LABELS, SCORE_WEIGHTS } from '../../shared/scoring';
import { api } from '../api';
import { StatusPill } from './Overview';

export function Research({ feed, onRefresh }: { feed: ResearchFeed | null; onRefresh: () => void }) {
  const [openId, setOpenId] = useState<string | null>('variational');
  if (!feed) return <div className="page"><p className="muted">Загрузка…</p></div>;
  const ranked = rankProjects(feed.projects);

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h1>Исследование перп-DEX</h1>
          <p className="muted">Скоринг по 8 критериям (вес в скобках). Данные обновляются из GitHub без переустановки.</p>
        </div>
        <button className="btn" onClick={onRefresh}>⟳ Обновить данные</button>
      </header>

      <div className="weights">
        {(Object.keys(SCORE_WEIGHTS) as (keyof ScoreBreakdown)[]).map((k) => (
          <span key={k} className="chip">{SCORE_LABELS[k]} ({Math.round(SCORE_WEIGHTS[k] * 100)}%)</span>
        ))}
      </div>

      {ranked.map((p) => (
        <ProjectCard key={p.id} p={p} open={openId === p.id} toggle={() => setOpenId(openId === p.id ? null : p.id)} />
      ))}

      <div className="card">
        <h3>Источники</h3>
        <ul className="sources">
          {feed.sources.map((s) => (
            <li key={s.url}><a onClick={() => void api().openExternal(s.url)}>{s.label}</a></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProjectCard({ p, open, toggle }: { p: Project; open: boolean; toggle: () => void }) {
  const score = projectScore(p.scores);
  return (
    <div className={`card project ${p.pick ?? ''}`}>
      <div className="project-head clickable" onClick={toggle}>
        <div className="score-ring small-ring">{score}</div>
        <div className="grow">
          <div className="row-inline">
            <h2>{p.name}</h2>
            <StatusPill s={p.status} />
            {p.pick && <span className="tag inline">{p.pick === 'primary' ? 'Выбор №1' : 'Выбор №2'}</span>}
          </div>
          <div className="muted small">{p.sector} · {p.chain} · TGE: {p.tgeEstimate ?? '—'}</div>
        </div>
        <span className="muted">{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div className="project-body">
          <p>{p.summary}</p>
          <div className="grid cols-2">
            <dl className="kv">
              <dt>Команда</dt><dd>{p.team}</dd>
              <dt>Инвесторы</dt><dd>{p.funding}</dd>
              <dt>Трекшн</dt><dd>{p.traction}</dd>
              <dt>Поинты</dt><dd>{p.points}</dd>
              <dt>Токен</dt><dd>{p.token}</dd>
              <dt>Комиссии</dt><dd>{p.fees}</dd>
              <dt>API</dt><dd>{p.api}</dd>
            </dl>
            <div>
              {(Object.keys(SCORE_LABELS) as (keyof ScoreBreakdown)[]).map((k) => (
                <div key={k} className="bar-row">
                  <span className="small">{SCORE_LABELS[k]}</span>
                  <div className="bar"><div style={{ width: `${p.scores[k] * 10}%` }} /></div>
                  <span className="small num">{p.scores[k]}</span>
                </div>
              ))}
              <h4>Риски</h4>
              <ul className="risks">{p.risks.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          </div>
          <div className="verdict"><b>Вывод:</b> {p.verdict}</div>
          <div className="links">
            {p.links.map((l) => (
              <button key={l.url} className="btn ghost small-btn" onClick={() => void api().openExternal(l.url)}>{l.label} ↗</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
