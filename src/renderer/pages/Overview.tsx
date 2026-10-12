import type { BotStatus, ResearchFeed } from '../../shared/types';
import { projectScore, rankProjects } from '../../shared/scoring';
import { compact, usd } from '../api';
import type { Page } from '../App';

export function Overview({ feed, bot, go }: { feed: ResearchFeed | null; bot: BotStatus | null; go: (p: Page) => void }) {
  const picks = feed?.projects.filter((p) => p.pick) ?? [];
  const s = bot?.stats;
  const farmVolume = s?.perVenue.nado?.volumeUsd ?? 0;
  const costPerM = s && s.totalVolumeUsd > 0 ? (-s.totalRealizedPnlUsd / s.totalVolumeUsd) * 1e6 : null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Обзор</h1>
        <p className="muted">Сектор: перп-DEX. Фокус — {picks.map((p) => p.name).join(' + ') || '…'}</p>
      </header>

      {feed && <div className="note">{feed.marketNote}</div>}

      <div className="grid cols-2">
        {picks.map((p) => (
          <div key={p.id} className={`card pick ${p.pick}`}>
            <div className="card-head">
              <div>
                <div className="tag">{p.pick === 'primary' ? 'Цель №1 · главный дроп' : 'Цель №2 · фарм ботом'}</div>
                <h2>{p.name}</h2>
                <div className="muted small">{p.sector} · {p.chain}</div>
              </div>
              <div className="score-ring">{projectScore(p.scores)}</div>
            </div>
            <dl className="kv">
              <dt>Токен</dt><dd>{p.tgeEstimate ?? '—'}{p.airdropPct ? ` · airdrop ${p.airdropPct}%` : ''}</dd>
              <dt>Поинты</dt><dd>{p.weeklyPoints ?? '—'}</dd>
              <dt>Комиссии</dt><dd>{p.fees}</dd>
            </dl>
            <p className="small">{p.verdict}</p>
          </div>
        ))}
      </div>

      <div className="grid cols-4">
        <Stat label="Статус бота" value={bot ? stateLabel(bot.state) : '—'} sub={bot?.message} onClick={() => go('bot')} />
        <Stat label="Объём сегодня" value={usd(s?.volumeTodayUsd)} sub={`всего ${compact(s?.totalVolumeUsd)}`} />
        <Stat label="Объём на Nado (поинты)" value={compact(farmVolume)} sub={`${s?.cycles ?? 0} циклов`} />
        <Stat label="Цена фарма" value={costPerM === null ? '—' : `${usd(costPerM)} / $1M`} sub={`итог ${usd(s?.totalRealizedPnlUsd, 2)}`} />
      </div>

      <div className="card">
        <h3>Рейтинг проектов</h3>
        <p className="muted small">Скор считается по 8 критериям, включая API. Variational выбран №1 за размер и близость дропа, хотя без торгового API его скор ниже.</p>
        <table className="table">
          <thead>
            <tr><th>Проект</th><th>Статус</th><th>TGE</th><th>API</th><th className="num">Скор</th></tr>
          </thead>
          <tbody>
            {feed && rankProjects(feed.projects).map((p) => (
              <tr key={p.id} onClick={() => go('research')} className="clickable">
                <td><b>{p.name}</b> {p.pick && <span className="tag inline">{p.pick === 'primary' ? '№1' : '№2'}</span>}</td>
                <td><StatusPill s={p.status} /></td>
                <td>{p.tgeEstimate ?? '—'}</td>
                <td className="muted small">{p.scores.automation >= 8 ? 'бот ✓' : p.scores.automation >= 5 ? 'частично' : 'ручной'}</td>
                <td className="num"><b>{projectScore(p.scores)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  return (
    <div className={`card stat ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small ellipsis">{sub}</div>}
    </div>
  );
}

export function StatusPill({ s }: { s: string }) {
  const map: Record<string, string> = {
    farming: 'Фармится',
    'tge-announced': 'TGE объявлен',
    'token-live': 'Токен вышел',
    watch: 'Наблюдаем',
    avoid: 'Избегать',
  };
  return <span className={`pill ${s}`}>{map[s] ?? s}</span>;
}

export function stateLabel(s: string) {
  return ({ stopped: 'Остановлен', starting: 'Запуск…', running: 'Работает', stopping: 'Останавливается', error: 'Ошибка' } as Record<string, string>)[s] ?? s;
}
