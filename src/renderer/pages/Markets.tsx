import { useEffect, useMemo, useState } from 'react';
import type { MarketRow, MarketSnapshot, VenueId } from '../../shared/types';
import { api, compact, pct } from '../api';

const VENUES: { id: VenueId; label: string }[] = [
  { id: 'variational', label: 'Variational' },
  { id: 'nado', label: 'Nado' },
  { id: 'hyperliquid', label: 'Hyperliquid' },
];

type Sort = 'volume' | 'omniSpread' | 'fundingEdge';

export function Markets() {
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('volume');
  const [botOnly, setBotOnly] = useState(false);

  const load = async () => {
    try {
      setSnap(await api().getMarkets());
      setErr('');
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    if (!snap) return [];
    let r = snap.rows.filter((x) => x.coin.includes(q.toUpperCase()));
    if (botOnly) r = r.filter((x) => x.quotes.nado && x.quotes.hyperliquid);
    if (sort === 'omniSpread') r = r.filter((x) => x.quotes.variational).sort((a, b) => a.quotes.variational!.spreadBps - b.quotes.variational!.spreadBps);
    if (sort === 'fundingEdge') r = [...r].sort((a, b) => (b.bestFundingPair?.aprEdge ?? 0) - (a.bestFundingPair?.aprEdge ?? 0));
    return r.slice(0, 120);
  }, [snap, q, sort, botOnly]);

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h1>Рынки</h1>
          <p className="muted">
            Спред (bps) и фандинг (годовых) на Variational, Nado и Hyperliquid в одной таблице. У Variational показана котировка на $1k.
            Положительный фандинг — лонги платят шортам.
          </p>
        </div>
        <button className="btn" onClick={load}>⟳</button>
      </header>
      {err && <div className="banner error">{err}</div>}
      {snap?.errors.map((e) => <div key={e} className="banner warn">{e}</div>)}

      <div className="grid cols-3">
        {VENUES.map((v) => {
          const st = snap?.venueStats[v.id];
          return (
            <div key={v.id} className="card stat">
              <div className="muted small">{v.label}</div>
              <div className="stat-value">{compact(st?.volume24h)} <span className="muted small">/ 24ч</span></div>
              <div className="muted small">OI {compact(st?.openInterest)}{st?.tvl ? ` · TVL ${compact(st.tvl)}` : ''} · {st?.markets ?? '—'} рынков</div>
            </div>
          );
        })}
      </div>

      <div className="toolbar">
        <input placeholder="Поиск монеты…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button className={sort === 'volume' ? 'on' : ''} onClick={() => setSort('volume')}>По объёму</button>
          <button className={sort === 'omniSpread' ? 'on' : ''} onClick={() => setSort('omniSpread')}>Дешевле всего на Omni</button>
          <button className={sort === 'fundingEdge' ? 'on' : ''} onClick={() => setSort('fundingEdge')}>Фандинг-арб</button>
        </div>
        <label className="check"><input type="checkbox" checked={botOnly} onChange={(e) => setBotOnly(e.target.checked)} /> только доступные боту (Nado + HL)</label>
      </div>

      <div className="card table-wrap">
        <table className="table dense">
          <thead>
            <tr>
              <th>Монета</th>
              {VENUES.map((v) => <th key={v.id} className="num" colSpan={2}>{v.label}</th>)}
              <th>Лучшая пара по фандингу</th>
            </tr>
            <tr className="sub">
              <th />
              {VENUES.map((v) => [<th key={v.id + 's'} className="num">спред</th>, <th key={v.id + 'f'} className="num">фандинг</th>])}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <Row key={r.coin} r={r} />)}
          </tbody>
        </table>
        {!snap && <p className="muted">Загрузка котировок…</p>}
      </div>
      <p className="muted small">
        Как читать: для дельта-нейтрального фарма выбирай монеты с маленьким суммарным спредом. Если фандинг на двух биржах сильно
        расходится, ставь лонг туда, где фандинг ниже, а шорт туда, где выше: тогда позиция ещё и зарабатывает на фандинге.
      </p>
    </div>
  );
}

function Row({ r }: { r: MarketRow }) {
  return (
    <tr>
      <td><b>{r.coin}</b></td>
      {VENUES.map((v) => {
        const qv = r.quotes[v.id];
        if (!qv) return [<td key={v.id + 's'} className="num muted">—</td>, <td key={v.id + 'f'} className="num muted">—</td>];
        return [
          <td key={v.id + 's'} className={`num ${qv.spreadBps < 2 ? 'good' : qv.spreadBps > 10 ? 'bad' : ''}`}>{qv.spreadBps.toFixed(1)}</td>,
          <td key={v.id + 'f'} className={`num ${(qv.fundingApr ?? 0) < 0 ? 'good' : ''}`}>{pct(qv.fundingApr)}</td>,
        ];
      })}
      <td className="small">
        {r.bestFundingPair && r.bestFundingPair.aprEdge > 0.02
          ? `long ${r.bestFundingPair.longVenue} / short ${r.bestFundingPair.shortVenue} · +${pct(r.bestFundingPair.aprEdge)}`
          : <span className="muted">—</span>}
      </td>
    </tr>
  );
}
