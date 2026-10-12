import { useEffect, useMemo, useState } from 'react';
import type { BotStatus, MarketSnapshot, ResearchFeed } from '../../shared/types';
import { compareStrategies, omniHoldPlan, type EconomicsInputs } from '../../shared/economics';
import { api, pct, usd } from '../api';
import { Num } from './Bot';

const FALLBACK: EconomicsInputs = {
  nado: { pointsPer1MVolume: 160, cashBackBps: 0.4, pointValue: 0.6 },
  variational: { pointsPer1MVolume: 9.6, pointsPer1MOiWeek: 86, pointValue: 20, roundTripSpreadBps: 1 },
  fees: { nadoMaker: 1, nadoTaker: 3.5, hlTaker: 4.5, lighterTaker: 0 },
  hedgeSlippageBps: 0.3,
};

export function Economics({ feed, bot }: { feed: ResearchFeed | null; bot: BotStatus | null }) {
  const base = feed?.economics ?? FALLBACK;
  const [varValue, setVarValue] = useState(base.variational.pointValue);
  const [nadoValue, setNadoValue] = useState(base.nado.pointValue);
  const [notional, setNotional] = useState(5000);
  const [days, setDays] = useState(7);
  const [coin, setCoin] = useState('BTC');
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);

  useEffect(() => {
    setVarValue(base.variational.pointValue);
    setNadoValue(base.nado.pointValue);
  }, [feed]);
  useEffect(() => {
    void api().getMarkets().then(setSnap).catch(() => {});
  }, []);

  const e: EconomicsInputs = useMemo(
    () => ({ ...base, nado: { ...base.nado, pointValue: nadoValue }, variational: { ...base.variational, pointValue: varValue } }),
    [base, nadoValue, varValue],
  );
  const rows = compareStrategies(e);

  // Funding edge for a delta-neutral Omni position hedged on Nado: we take the side that gets paid.
  const row = snap?.rows.find((r) => r.coin === coin);
  const fOmni = row?.quotes.variational?.fundingApr ?? null;
  const fNado = row?.quotes.nado?.fundingApr ?? null;
  const edge = fOmni !== null && fNado !== null ? Math.abs(fOmni - fNado) : 0;
  const omniSide = fOmni !== null && fNado !== null ? (fOmni < fNado ? 'LONG' : 'SHORT') : 'LONG';
  const spreadRt = row?.quotes.variational?.spreadBps ?? e.variational.roundTripSpreadBps;
  const plan = omniHoldPlan({ ...e, variational: { ...e.variational, roundTripSpreadBps: spreadRt } }, notional, days, edge);

  // Best coins to hold delta-neutral (Omni vs Nado): funding paid to us on both legs + VAR points for OI.
  const holdRanking = useMemo(() => {
    if (!snap) return [];
    return snap.rows
      .map((r) => {
        const o = r.quotes.variational;
        const n = r.quotes.nado;
        if (!o || !n || o.fundingApr === null || n.fundingApr === null) return null;
        // Omni TradFi swaps (stocks, indices, metals) use a different financing model and report 0 here.
        if (o.fundingApr === 0) return null;
        // Liquidity guard: thin books make entry/exit and hedging unreliable.
        if ((n.volume24h ?? 0) < 150_000 || o.spreadBps > 10 || n.spreadBps > 5) return null;
        const fEdge = Math.abs(o.fundingApr - n.fundingApr);
        const p = omniHoldPlan({ ...e, variational: { ...e.variational, roundTripSpreadBps: o.spreadBps + n.spreadBps / 2 } }, notional, days, fEdge);
        return { coin: r.coin, side: o.fundingApr < n.fundingApr ? 'LONG' : 'SHORT', fOmni: o.fundingApr, fNado: n.fundingApr, edge: fEdge, net: p.net, funding: p.funding, points: p.pointsValue, cost: p.entryExit };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.net - a.net)
      .slice(0, 10);
  }, [snap, e, notional, days]);

  // Actual bot numbers: cost per $1M of Nado volume and the implied cost of one Nado point.
  const s = bot?.stats;
  const nadoVol = s?.perVenue.nado?.volumeUsd ?? 0;
  const actualCostPer1M = nadoVol > 0 ? (-(s?.totalRealizedPnlUsd ?? 0) / nadoVol) * 1e6 : null;
  const actualCostPerPoint =
    actualCostPer1M !== null ? (actualCostPer1M - e.nado.cashBackBps * 100) / e.nado.pointsPer1MVolume : null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Экономика фарма</h1>
        <p className="muted">
          Сколько стоит поинт и где фарм уходит в плюс. Ставки поинтов — оценки (Variational свою формулу не публикует), они
          обновляются вместе с данными исследования.
        </p>
      </header>

      <div className="grid cols-4">
        <div className="card">
          <div className="muted small">Цена поинта Variational, $</div>
          <input type="number" value={varValue} onChange={(ev) => setVarValue(Number(ev.target.value))} />
          <div className="muted small">OTC ~$20 · Polymarket ~$45 · весной $5–7</div>
        </div>
        <div className="card">
          <div className="muted small">Цена поинта Nado, $ (оценка)</div>
          <input type="number" value={nadoValue} onChange={(ev) => setNadoValue(Number(ev.target.value))} />
          <div className="muted small">OTC нет — поинты непередаваемые</div>
        </div>
        <div className="card stat">
          <div className="muted small">Твой бот: цена $1M объёма Nado</div>
          <div className="stat-value">{actualCostPer1M === null ? '—' : usd(actualCostPer1M)}</div>
          <div className="muted small">по фактической статистике бота</div>
        </div>
        <div className="card stat">
          <div className="muted small">Твой бот: цена 1 поинта Nado</div>
          <div className={`stat-value ${actualCostPerPoint !== null && actualCostPerPoint > nadoValue ? 'bad' : 'good'}`}>
            {actualCostPerPoint === null ? '—' : usd(actualCostPerPoint, 2)}
          </div>
          <div className="muted small">с учётом кэшбэка {e.nado.cashBackBps} bps</div>
        </div>
      </div>

      <div className="card">
        <h3>Сравнение стратегий (на $1M объёма)</h3>
        <table className="table">
          <thead>
            <tr><th>Стратегия</th><th className="num">Затраты</th><th className="num">Поинты Nado</th><th className="num">Поинты VAR</th><th className="num">Стоимость поинтов + кэшбэк</th><th className="num">Итог</th><th className="num">Цена поинта</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b>{r.manual && <span className="tag inline">вручную</span>}<div className="muted small">{r.note}</div></td>
                <td className="num">{usd(r.costPer1M)}</td>
                <td className="num">{r.pointsNado.toFixed(0)}</td>
                <td className="num">{r.pointsVar ? r.pointsVar.toFixed(1) : '—'}</td>
                <td className="num">{usd(r.valuePer1M)}</td>
                <td className={`num ${r.netPer1M >= 0 ? 'good' : 'bad'}`}><b>{usd(r.netPer1M)}</b></td>
                <td className="num">{r.costPerPoint === null ? '—' : usd(r.costPerPoint, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Лучшее по расчёту: держать дельта-нейтральную позицию на Omni</h3>
        <p className="small">
          Variational начисляет за открытую позицию (OI) примерно в 9 раз больше поинтов, чем за тот же объём оборота
          ({e.variational.pointsPer1MOiWeek} против {e.variational.pointsPer1MVolume} на $1M в неделю). Поэтому выгоднее не крутить
          объём, а держать позицию: открыть на Omni, захеджировать мейкером на Nado и держать неделю. Сторону выбирай так, чтобы
          фандинг платили тебе.
        </p>
        <div className="form inline">
          <label>Монета<input value={coin} onChange={(ev) => setCoin(ev.target.value.toUpperCase())} /></label>
          <Num label="Размер позиции, $" v={notional} on={setNotional} />
          <Num label="Дней держать" v={days} on={setDays} />
        </div>
        <table className="table dense">
          <tbody>
            <tr><td>Сторона на Omni (фандинг в твою пользу)</td><td className="num"><b>{omniSide}</b> на Omni, {omniSide === 'LONG' ? 'SHORT' : 'LONG'} на Nado</td></tr>
            <tr><td>Фандинг: Omni / Nado → разница</td><td className="num">{pct(fOmni)} / {pct(fNado)} → <b className="good">+{pct(edge)}</b> годовых</td></tr>
            <tr><td>Поинты VAR за период</td><td className="num">{plan.points.toFixed(2)} ≈ {usd(plan.pointsValue)}</td></tr>
            <tr><td>Вход и выход (спред Omni {spreadRt.toFixed(1)} bps + мейкер Nado − кэшбэк)</td><td className="num bad">−{usd(plan.entryExit, 2)}</td></tr>
            <tr><td>Фандинг за период</td><td className="num good">+{usd(plan.funding, 2)}</td></tr>
            <tr><td><b>Итог</b></td><td className={`num ${plan.net >= 0 ? 'good' : 'bad'}`}><b>{usd(plan.net, 2)}</b></td></tr>
            <tr><td>Цена одного поинта VAR</td><td className="num">{plan.costPerPoint === null ? '—' : plan.costPerPoint <= 0 ? 'бесплатно (фандинг покрывает расходы)' : usd(plan.costPerPoint, 2)}</td></tr>
          </tbody>
        </table>
        <h4>Лучшие монеты прямо сейчас (на {usd(notional)} за {days} дн.)</h4>
        <table className="table dense">
          <thead><tr><th>Монета</th><th>Omni</th><th className="num">Фандинг Omni / Nado</th><th className="num">Разница</th><th className="num">Фандинг</th><th className="num">Поинты VAR</th><th className="num">Вход+выход</th><th className="num">Итог</th><th /></tr></thead>
          <tbody>
            {holdRanking.map((h) => (
              <tr key={h.coin}>
                <td><b>{h.coin}</b></td>
                <td>{h.side}</td>
                <td className="num">{pct(h.fOmni)} / {pct(h.fNado)}</td>
                <td className="num good">+{pct(h.edge)}</td>
                <td className="num">{usd(h.funding, 2)}</td>
                <td className="num">{usd(h.points, 2)}</td>
                <td className="num bad">−{usd(h.cost, 2)}</td>
                <td className={`num ${h.net >= 0 ? 'good' : 'bad'}`}><b>{usd(h.net, 2)}</b></td>
                <td><button className="btn ghost small-btn" onClick={() => setCoin(h.coin)}>выбрать</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Фандинг меняется каждый час. Проверяй таблицу перед входом и раз в пару дней, пока держишь позицию: если разница ушла в
          минус, закрывай или переворачивай. Отбор: объём на Nado от $150k за сутки, спред Omni до 10 bps, спред Nado до 5 bps; TradFi-свопы Omni (акции, индексы) исключены — у них другой механизм финансирования.
        </p>
        <p className="muted small">
          Нужно держать маржу на обеих биржах: при плече 3x это ~{usd(notional / 3)} на Omni и ~{usd(notional / 3)} на Nado. Раз в
          несколько дней проверяй запас до ликвидации: одна нога будет в плюсе, другая в минусе.
        </p>
      </div>

      {feed?.economics && (
        <div className="card">
          <h3>Откуда цифры</h3>
          <ul className="risks">{feed.economics.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          <div className="links">
            {feed.economics.sources.map((l) => <button key={l.url} className="btn ghost small-btn" onClick={() => void api().openExternal(l.url)}>{l.label} ↗</button>)}
          </div>
        </div>
      )}
    </div>
  );
}
