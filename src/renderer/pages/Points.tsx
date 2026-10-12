import { useEffect, useState } from 'react';
import type { BotStatus, PointsEntry, ResearchFeed } from '../../shared/types';
import { valuePoints } from '../../shared/points';
import { api, compact, usd } from '../api';
import { Num } from './Bot';

function defaultsFor(feed: ResearchFeed, id: string): PointsEntry {
  const m = feed.projects.find((p) => p.id === id)?.pointsModel;
  return {
    projectId: id,
    myPoints: 0,
    totalPoints: m?.totalPointsEstimate ?? 0,
    airdropPct: m?.airdropPct ?? 0,
    fdvBear: m?.fdvBear ?? 0,
    fdvBase: m?.fdvBase ?? 0,
    fdvBull: m?.fdvBull ?? 0,
    otcOfferPerPoint: id === 'variational' ? 20 : 0,
    farmCostUsd: 0,
  };
}

export function Points({ feed, bot }: { feed: ResearchFeed | null; bot: BotStatus | null }) {
  const [entries, setEntries] = useState<PointsEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api().getPoints().then((p) => {
      setEntries(p);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!feed || !loaded) return;
    // Every project with a valuation model, plus Nado (no public model — fill your own).
    const ids = feed.projects.filter((p) => p.pointsModel || p.pick).map((p) => p.id);
    setEntries((cur) => {
      const missing = ids.filter((id) => !cur.some((e) => e.projectId === id));
      return missing.length ? [...cur, ...missing.map((id) => defaultsFor(feed, id))] : cur;
    });
  }, [feed, loaded]);

  if (!feed) return <div className="page"><p className="muted">Загрузка…</p></div>;

  const update = (id: string, patch: Partial<PointsEntry>) => {
    setEntries((es) => es.map((e) => (e.projectId === id ? { ...e, ...patch } : e)));
    setDirty(true);
  };
  const save = async () => {
    setEntries(await api().setPoints(entries));
    setDirty(false);
  };
  const botCost = bot ? -bot.stats.totalRealizedPnlUsd : 0;

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h1>Поинты & OTC</h1>
          <p className="muted">
            Цена одного поинта = FDV × доля эирдропа ÷ всего поинтов. Сравни оффер с OTC с базовым сценарием
            и посчитай, при каком FDV окупается фарм.
          </p>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={save}>Сохранить</button>
      </header>

      {entries.map((e) => {
        const p = feed.projects.find((x) => x.id === e.projectId);
        if (!p) return null;
        const v = valuePoints(e);
        return (
          <div key={e.projectId} className="card">
            <div className="row">
              <h2>{p.name}</h2>
              <span className={`verdict-pill ${v.verdict}`}>
                {v.verdict === 'sell' ? 'OTC-оффер выгоден — можно продавать' : v.verdict === 'hold' ? 'Оффер дешёвый — держать до TGE' : v.verdict === 'neutral' ? 'Оффер около справедливой цены' : 'Введи данные'}
              </span>
            </div>
            {e.totalPoints === 0 && <p className="muted small">Публичной модели нет: впиши своё число поинтов (видно в приложении проекта) и сценарии FDV.</p>}
            <div className="form cols-5">
              <Num label="Мои поинты" v={e.myPoints} on={(x) => update(e.projectId, { myPoints: x })} />
              <Num label="Всего поинтов (оценка)" v={e.totalPoints} on={(x) => update(e.projectId, { totalPoints: x })} />
              <Num label="Доля эирдропа, %" v={e.airdropPct} on={(x) => update(e.projectId, { airdropPct: x })} />
              <Num label="OTC-оффер за поинт, $" v={e.otcOfferPerPoint} on={(x) => update(e.projectId, { otcOfferPerPoint: x })} />
              <label>Затраты на фарм, $
                <div className="row-inline">
                  <input type="number" value={e.farmCostUsd} onChange={(ev) => update(e.projectId, { farmCostUsd: Number(ev.target.value) })} />
                  {p.id === 'nado' && botCost > 0 && <button className="btn small-btn ghost" title="Взять из статистики бота" onClick={() => update(e.projectId, { farmCostUsd: Math.round(botCost * 100) / 100 })}>из бота</button>}
                </div>
              </label>
              <Num label="FDV медвежий, $" v={e.fdvBear} on={(x) => update(e.projectId, { fdvBear: x })} />
              <Num label="FDV базовый, $" v={e.fdvBase} on={(x) => update(e.projectId, { fdvBase: x })} />
              <Num label="FDV бычий, $" v={e.fdvBull} on={(x) => update(e.projectId, { fdvBull: x })} />
            </div>
            <table className="table dense">
              <thead><tr><th /><th className="num">Медвежий</th><th className="num">Базовый</th><th className="num">Бычий</th></tr></thead>
              <tbody>
                <tr><td>FDV</td><td className="num">{compact(e.fdvBear)}</td><td className="num">{compact(e.fdvBase)}</td><td className="num">{compact(e.fdvBull)}</td></tr>
                <tr><td>$ за поинт</td><td className="num">{usd(v.perPoint.bear, 2)}</td><td className="num"><b>{usd(v.perPoint.base, 2)}</b></td><td className="num">{usd(v.perPoint.bull, 2)}</td></tr>
                <tr><td>Мои поинты</td><td className="num">{usd(v.myValue.bear)}</td><td className="num"><b>{usd(v.myValue.base)}</b></td><td className="num">{usd(v.myValue.bull)}</td></tr>
              </tbody>
            </table>
            <div className="estimate">
              {e.otcOfferPerPoint > 0 && <div>Продажа на OTC: {usd(v.otcTotal)} ({v.otcVsBase ? `${Math.round(v.otcVsBase * 100)}% от базового сценария` : '—'})</div>}
              {v.costPerPoint !== null && <div>Себестоимость поинта: {usd(v.costPerPoint, 2)} → фарм окупается при FDV ≥ <b>{compact(v.breakEvenFdv)}</b></div>}
            </div>
          </div>
        );
      })}

      <div className="card">
        <h3>Где продавать поинты (OTC)</h3>
        <div className="grid cols-3">
          {feed.otcVenues.map((o) => (
            <div key={o.name} className="otc">
              <div className="row"><b>{o.name}</b><button className="btn ghost small-btn" onClick={() => void api().openExternal(o.url)}>↗</button></div>
              <div className="tag inline">{o.kind}</div>
              <p className="small">{o.notes}</p>
            </div>
          ))}
        </div>
        <h4>Чек-лист безопасной OTC-сделки</h4>
        <ul className="risks">
          <li>Только через эскроу или гаранта с залогом: покупатель блокирует USDC, продавец — коллатерал, расчёт токенами после TGE.</li>
          <li>Не передавай сид-фразу и не продавай аккаунт целиком: это нарушает ToS, поинты могут обнулить, а покупатель может забрать всё.</li>
          <li>Поинты Variational начисляются на аккаунт, поэтому продаётся будущая аллокация $VAR (форвард), а не сами поинты.</li>
          <li>Поинты Nado непередаваемые, так что OTC возможен только как форвард на будущий токен.</li>
          <li>Сравнивай оффер с FDV-рынками Polymarket. Если оффер выше базового сценария, продажа фиксирует прибыль и снимает риск TGE.</li>
        </ul>
      </div>
    </div>
  );
}
