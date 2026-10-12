import { useEffect, useState } from 'react';
import type { NadoPointsSummary, PointsEntry, ResearchFeed } from '../../shared/types';
import { api, usd } from '../api';

const VAR_PRICES = { otc: 20, market: 45 };

export function MyPoints({ feed }: { feed: ResearchFeed | null }) {
  const [entries, setEntries] = useState<PointsEntry[]>([]);
  const [varPoints, setVarPoints] = useState(0);
  const [nado, setNado] = useState<NadoPointsSummary | null>(null);
  const [nadoErr, setNadoErr] = useState('');

  useEffect(() => {
    void api().getPoints().then((p) => {
      setEntries(p);
      setVarPoints(p.find((e) => e.projectId === 'variational')?.myPoints ?? 0);
    });
    void api().nadoPoints().then(setNado).catch((e) => setNadoErr(String(e)));
  }, []);

  const saveVar = async (v: number) => {
    setVarPoints(v);
    const m = feed?.projects.find((p) => p.id === 'variational')?.pointsModel;
    const rest = entries.filter((e) => e.projectId !== 'variational');
    const cur = entries.find((e) => e.projectId === 'variational');
    const next: PointsEntry = cur
      ? { ...cur, myPoints: v }
      : {
          projectId: 'variational',
          myPoints: v,
          totalPoints: m?.totalPointsEstimate ?? 0,
          airdropPct: m?.airdropPct ?? 0,
          fdvBear: m?.fdvBear ?? 0,
          fdvBase: m?.fdvBase ?? 0,
          fdvBull: m?.fdvBull ?? 0,
          otcOfferPerPoint: VAR_PRICES.otc,
          farmCostUsd: 0,
        };
    setEntries(await api().setPoints([...rest, next]));
  };

  const nadoValue = feed?.economics?.nado.pointValue ?? 0.6;

  return (
    <div className="page home">
      <header className="page-head">
        <h1>Мои поинты</h1>
        <p className="muted">Поинты — это «бонусы», которые потом обменяют на токены проекта. Здесь видно, сколько их у тебя и сколько это примерно в долларах.</p>
      </header>

      <div className="grid cols-2 align-start">
        <div className="card hero">
          <h2 className="hero-title">Variational</h2>
          <div className="muted small">Сколько у тебя поинтов (смотри на omni.variational.io → Points)</div>
          <input type="number" value={varPoints || ''} placeholder="0" onChange={(e) => void saveVar(Number(e.target.value))} />
          <div className="earn">
            <div className="earn-big">≈ {usd(varPoints * VAR_PRICES.otc)}</div>
            <div className="small muted">если продать сейчас по ${VAR_PRICES.otc} за поинт (как продал твой друг)</div>
            <div className="small">≈ {usd(varPoints * VAR_PRICES.market)}, если токен выйдет по цене, которую ждёт рынок (~${VAR_PRICES.market} за поинт)</div>
          </div>
          <p className="small muted">Токен обещают в конце 2026 года. Продавать сейчас — надёжно, ждать токен — возможно дороже, но рискованнее.</p>
          <button className="btn ghost small-btn" onClick={() => void api().openExternal('https://omni.variational.io/points')}>Мои поинты на Variational ↗</button>
        </div>

        <div className="card hero">
          <h2 className="hero-title">Nado</h2>
          {nadoErr && <p className="bad small">{nadoErr}</p>}
          {!nado && !nadoErr && <p className="muted">Загружаю…</p>}
          {nado && nado.myPoints === null && (
            <p className="small">Добавь адрес кошелька Nado в Настройках, и здесь появятся твои поинты.</p>
          )}
          {nado && nado.myPoints !== null && (
            <div className="earn">
              <div className="earn-big">{Math.round(nado.myPoints).toLocaleString('ru')} поинтов</div>
              <div className="small muted">≈ {usd(nado.myPoints * nadoValue)} по осторожной оценке (${nadoValue} за поинт)</div>
            </div>
          )}
          <p className="small muted">Поинты Nado нельзя продать заранее: только ждать токен. Каждую неделю их раздают ~{nado ? Math.round(nado.lastWeekPool / 1000) : 340} тыс. на всех.</p>
        </div>
      </div>

      <div className="card">
        <h3>Как продать поинты Variational безопасно</h3>
        <ol className="how-list">
          <li>Только через <a onClick={() => void api().openExternal('https://whales.market')}>Whales Market</a> или гаранта: деньги замораживаются, пока обе стороны не выполнят сделку.</li>
          <li>Не отдавай сид-фразу и не продавай аккаунт целиком: так обманывают чаще всего.</li>
          <li>Нормальная цена сейчас — около $20 за поинт. Если предлагают сильно меньше, лучше подождать.</li>
        </ol>
      </div>
    </div>
  );
}
