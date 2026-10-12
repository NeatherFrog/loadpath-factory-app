import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BOT_CONFIG, type BotConfig, type BotLogEntry, type BotStatus, type BotVenueId } from '../../shared/types';
import { api, usd } from '../api';
import { Stat, stateLabel } from '../components';

const VENUE_LABEL: Record<BotVenueId, string> = { nado: 'Nado', hyperliquid: 'Hyperliquid', lighter: 'Lighter' };
// Entry-tier fees, used for the cost estimate only.
const TAKER_BPS: Record<BotVenueId, number> = { nado: 3.5, hyperliquid: 4.5, lighter: 0 };
const MAKER_BPS: Record<BotVenueId, number> = { nado: 1, hyperliquid: 1.5, lighter: 0 };

export function Bot({ status }: { status: BotStatus | null }) {
  const [cfg, setCfg] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const [saved, setSaved] = useState(true);
  const [logs, setLogs] = useState<BotLogEntry[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api().getBotConfig().then(setCfg);
    void api().botLogs().then(setLogs);
    return api().onBotLog((e) => setLogs((l) => [...l.slice(-499), e]));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const running = !!status && ['running', 'starting', 'stopping'].includes(status.state);
  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => {
    setCfg((c) => ({ ...c, [k]: v }));
    setSaved(false);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => act(async () => {
    setCfg(await api().setBotConfig(cfg));
    setSaved(true);
  });

  const start = () => act(async () => {
    if (cfg.mode === 'live' && !window.confirm(
      `LIVE-режим: бот будет торговать реальными деньгами на ${VENUE_LABEL[cfg.legA]} и ${VENUE_LABEL[cfg.legB]}.\n\n` +
      `Позиция до $${cfg.notionalMaxUsd} на каждой ноге, дневной лимит убытка $${cfg.maxDailyLossUsd}.\nПродолжить?`,
    )) return;
    if (!saved) await api().setBotConfig(cfg);
    setSaved(true);
    await api().startBot();
  });

  const avgNotional = (cfg.notionalMinUsd + cfg.notionalMaxUsd) / 2;
  const cycleMin = (cfg.holdMinMinutes + cfg.holdMaxMinutes) / 2 + (cfg.pauseMinMinutes + cfg.pauseMaxMinutes) / 2 + 0.3;
  const cyclesPerDay = 1440 / Math.max(cycleMin, 0.5);
  const farmVolPerDay = cyclesPerDay * avgNotional * 2; // open + close on leg A
  // Maker on leg A: no spread crossed there, only maker fee; leg B always pays taker + half its spread.
  const legABps = cfg.makerLegA ? MAKER_BPS[cfg.legA] : TAKER_BPS[cfg.legA] + cfg.maxEntrySpreadBps / 4;
  const legBBps = TAKER_BPS[cfg.legB] + cfg.maxEntrySpreadBps / 4;
  const costPerCycle = avgNotional * 2 * ((legABps + legBBps) / 10_000);
  const costPerDay = cyclesPerDay * costPerCycle;
  const s = status?.stats;

  return (
    <div className="page">
      <header className="page-head row">
        <div>
          <h1>Дельта-нейтральный бот</h1>
          <p className="muted">
            На ноге A (фарм поинтов) открывается лонг или шорт, на ноге B — та же позиция в обратную сторону. Пара держится случайное время,
            потом обе ноги закрываются, и цикл повторяется. Рыночный риск близок к нулю, тратишь только на комиссии и спред.
          </p>
        </div>
        <div className={`state-pill ${status?.state ?? 'stopped'}`}>{status ? stateLabel(status.state) : '—'}</div>
      </header>

      {err && <div className="banner error">{err}</div>}
      {status?.state === 'error' && <div className="banner error">{status.message}</div>}
      {cfg.mode === 'live' && <div className="banner warn">LIVE-режим: сделки идут реальными деньгами. Сначала прогоняй настройки в бумажном режиме.</div>}

      <div className="grid cols-4">
        <Stat label="Сейчас" value={status?.cycle ? `${status.cycle.coin} · ${phaseLabel(status.cycle.phase)}` : '—'} sub={status?.message} />
        <Stat label="Объём сегодня" value={usd(s?.volumeTodayUsd)} sub={`результат дня ${usd(s?.realizedPnlTodayUsd, 2)}`} />
        <Stat label="Объём всего" value={usd(s?.totalVolumeUsd)} sub={`${s?.cycles ?? 0} циклов, ${s?.failedCycles ?? 0} сбоев`} />
        <Stat label="Итог (комиссии+спред)" value={usd(s?.totalRealizedPnlUsd, 2)} sub={`комиссии ${usd(s?.totalFeesUsd, 2)}`} />
      </div>

      <div className="grid cols-2 align-start">
        <div className="card">
          <h3>Настройки</h3>
          <div className="form">
            <label>Режим
              <div className="seg">
                <button disabled={running} className={cfg.mode === 'paper' ? 'on' : ''} onClick={() => set('mode', 'paper')}>Бумажный (симуляция)</button>
                <button disabled={running} className={cfg.mode === 'live' ? 'on danger' : ''} onClick={() => set('mode', 'live')}>LIVE</button>
              </div>
            </label>
            <label>Нога A (фарм поинтов)
              <select disabled={running} value={cfg.legA} onChange={(e) => { const a = e.target.value as BotVenueId; set('legA', a); if (cfg.legB === a) set('legB', a === 'nado' ? 'lighter' : 'nado'); }}>
                <option value="nado">Nado</option>
                <option value="hyperliquid">Hyperliquid</option>
                <option value="lighter">Lighter</option>
              </select>
            </label>
            <label>Нога B (хедж)
              <select disabled={running} value={cfg.legB} onChange={(e) => set('legB', e.target.value as BotVenueId)}>
                {(['lighter', 'hyperliquid', 'nado'] as BotVenueId[]).filter((v) => v !== cfg.legA).map((v) => (
                  <option key={v} value={v}>{VENUE_LABEL[v]}{v === 'lighter' ? ' — 0% комиссии' : ''}</option>
                ))}
              </select>
            </label>
            <label className="wide">Монеты (через запятую)
              <input value={cfg.coins.join(', ')} onChange={(e) => set('coins', e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))} />
            </label>
            <Num label="Объём позиции от, $" v={cfg.notionalMinUsd} on={(v) => set('notionalMinUsd', v)} />
            <Num label="до, $" v={cfg.notionalMaxUsd} on={(v) => set('notionalMaxUsd', v)} />
            <Num label="Держать от, мин" v={cfg.holdMinMinutes} on={(v) => set('holdMinMinutes', v)} />
            <Num label="до, мин" v={cfg.holdMaxMinutes} on={(v) => set('holdMaxMinutes', v)} />
            <Num label="Пауза от, мин" v={cfg.pauseMinMinutes} on={(v) => set('pauseMinMinutes', v)} />
            <Num label="до, мин" v={cfg.pauseMaxMinutes} on={(v) => set('pauseMaxMinutes', v)} />
            <Num label="Макс. суммарный спред, bps" v={cfg.maxEntrySpreadBps} on={(v) => set('maxEntrySpreadBps', v)} />
            <Num label="Макс. расхождение цен, bps" v={cfg.maxBasisBps} on={(v) => set('maxBasisBps', v)} />
            <Num label="Проскальзывание IOC, bps" v={cfg.slippageBps} on={(v) => set('slippageBps', v)} />
            <Num label="Допуск дельты, $" v={cfg.deltaToleranceUsd} on={(v) => set('deltaToleranceUsd', v)} />
            <Num label="Дневной лимит убытка, $" v={cfg.maxDailyLossUsd} on={(v) => set('maxDailyLossUsd', v)} />
            <Num label="Дневная цель объёма, $ (0 = ∞)" v={cfg.dailyVolumeTargetUsd} on={(v) => set('dailyVolumeTargetUsd', v)} />
            <label className="wide">Ордера на ноге A
              <div className="seg">
                <button className={cfg.makerLegA ? 'on' : ''} onClick={() => set('makerLegA', true)}>Мейкер (post-only, дешевле)</button>
                <button className={!cfg.makerLegA ? 'on' : ''} onClick={() => set('makerLegA', false)}>Тейкер (быстрее)</button>
              </div>
            </label>
            {cfg.makerLegA && <Num label="Ждать исполнения мейкера, сек" v={cfg.makerWaitSec} on={(v) => set('makerWaitSec', v)} />}
            {cfg.makerLegA && <Num label="Перестановок ордера до тейкера" v={cfg.makerRequotes} on={(v) => set('makerRequotes', Math.max(1, Math.round(v)))} />}
            <label className="wide">Направление
              <div className="seg">
                <button className={cfg.direction === 'funding' ? 'on' : ''} onClick={() => set('direction', 'funding')}>По фандингу (лонг где дешевле)</button>
                <button className={cfg.direction === 'random' ? 'on' : ''} onClick={() => set('direction', 'random')}>Случайно</button>
              </div>
            </label>
          </div>
          <div className="estimate">
            <div>≈ <b>{Math.round(cyclesPerDay)}</b> циклов/день · объём на {VENUE_LABEL[cfg.legA]} ≈ <b>{usd(farmVolPerDay)}</b>/день</div>
            <div>Оценка затрат ≈ <b>{usd(costPerDay)}</b>/день (нога A {legABps.toFixed(1)} bps + нога B {legBBps.toFixed(1)} bps), т.е. ≈ {usd((costPerCycle / (avgNotional * 2)) * 1e6)} на $1M объёма ноги A</div>
            {cfg.makerLegA && <div className="muted small">В мейкер-режиме ордер ждёт исполнения, поэтому циклов будет меньше расчётного, зато каждый в ~2–3 раза дешевле.</div>}
          </div>
          <div className="actions">
            <button className="btn" disabled={busy || saved} onClick={save}>Сохранить</button>
            {!running ? (
              <button className={`btn ${cfg.mode === 'live' ? 'danger' : 'primary'}`} disabled={busy} onClick={start}>▶ Запустить{cfg.mode === 'live' ? ' LIVE' : ''}</button>
            ) : (
              <button className="btn" disabled={busy || status?.state === 'stopping'} onClick={() => act(() => api().stopBot())}>■ Остановить (закрыть цикл)</button>
            )}
            <button className="btn danger ghost" disabled={busy} onClick={() => act(async () => {
              if (window.confirm('Остановить бота и закрыть ВСЕ позиции по монетам бота на обеих биржах (включая ручные хеджи) маркет-ордерами?')) await api().flatten();
            })}>⚠ Закрыть всё (вкл. хеджи)</button>
            <button className="btn ghost" disabled={busy || running} onClick={() => act(() => api().resetStats())}>Сбросить статистику</button>
          </div>
        </div>

        <div className="card">
          <h3>Журнал</h3>
          <div className="log" ref={logRef}>
            {logs.length === 0 && <div className="muted">Пока пусто. Запусти бота в бумажном режиме, чтобы посмотреть, как он работает.</div>}
            {logs.map((l, i) => (
              <div key={i} className={`log-line ${l.level}`}>
                <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span> {l.msg}
              </div>
            ))}
          </div>
          {s && Object.keys(s.perVenue).length > 0 && (
            <table className="table dense">
              <thead><tr><th>Биржа</th><th className="num">Объём</th><th className="num">Комиссии</th><th className="num">Сделок</th></tr></thead>
              <tbody>
                {Object.entries(s.perVenue).map(([v, st]) => (
                  <tr key={v}><td>{VENUE_LABEL[v as BotVenueId]}</td><td className="num">{usd(st!.volumeUsd)}</td><td className="num">{usd(st!.feesUsd, 2)}</td><td className="num">{st!.trades}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <OmniHedge status={status} busy={busy} act={act} />
    </div>
  );
}

function OmniHedge({ status, busy, act }: { status: BotStatus | null; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [coin, setCoin] = useState('BTC');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [size, setSize] = useState(0.002);
  const [venue, setVenue] = useState<BotVenueId>('nado');
  const [maker, setMaker] = useState(true);
  const [done, setDone] = useState('');
  const hedges = status?.hedges ?? [];

  return (
    <div className="card">
      <h3>Ручная сделка на Variational Omni → автохедж</h3>
      <p className="muted small">
        У Omni нет торгового API, поэтому сделку открываешь сам на omni.variational.io (0% комиссии, капают поинты VAR).
        Потом вводишь её здесь, и приложение открывает обратную позицию на {VENUE_LABEL[venue]}. Получаешь дельта-нейтраль и
        поинты сразу на двух биржах. Когда закроешь позицию на Omni, нажми «Закрыть хедж».
      </p>
      <div className="form inline">
        <label>Монета<input value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} /></label>
        <label>Позиция на Omni
          <div className="seg">
            <button className={side === 'long' ? 'on' : ''} onClick={() => setSide('long')}>LONG</button>
            <button className={side === 'short' ? 'on' : ''} onClick={() => setSide('short')}>SHORT</button>
          </div>
        </label>
        <Num label="Размер (в монетах)" v={size} on={setSize} step={0.001} />
        <label>Хедж на
          <select value={venue} onChange={(e) => setVenue(e.target.value as BotVenueId)}>
            <option value="nado">Nado (копятся поинты Nado)</option>
            <option value="lighter">Lighter (0% комиссии)</option>
            <option value="hyperliquid">Hyperliquid</option>
          </select>
        </label>
        <label>Ордер хеджа
          <div className="seg">
            <button className={maker ? 'on' : ''} onClick={() => setMaker(true)}>Мейкер (дешевле)</button>
            <button className={!maker ? 'on' : ''} onClick={() => setMaker(false)}>Тейкер (мгновенно)</button>
          </div>
        </label>
        <button className="btn primary" disabled={busy || !(size > 0)} onClick={() => act(async () => {
          setDone('');
          const st = await api().openHedge(coin, side, size, venue, maker);
          const h = st.hedges[0];
          if (h?.status === 'open') setDone(`Хедж готов: ${VENUE_LABEL[venue]} ${h.hedgeSize > 0 ? '+' : ''}${h.hedgeSize} ${coin}. ${maker ? `Теперь открой ${side.toUpperCase()} ${Math.abs(h.hedgeSize)} ${coin} на Omni.` : ''}`);
        })}>
          {maker ? 'Шаг 1: поставить хедж' : 'Открыть хедж'} ({side === 'long' ? 'SHORT' : 'LONG'} {size} {coin})
        </button>
      </div>
      {maker && <p className="small">
        Самый дешёвый порядок: <b>1)</b> приложение ставит мейкер-ордер на {VENUE_LABEL[venue]} (ждёт исполнения до ~2 мин, остаток добивает тейкером),
        <b> 2)</b> после «Хедж готов» открываешь позицию на Omni: там исполнение мгновенное. Голой позиции нет ни секунды.
      </p>}
      {done && <div className="banner warn">{done}</div>}
      {hedges.length > 0 && (
        <table className="table dense">
          <thead><tr><th>Время</th><th>Omni</th><th>Хедж</th><th className="num">Цена</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {hedges.map((h) => (
              <tr key={h.id}>
                <td className="small">{new Date(h.openedAt).toLocaleString()}</td>
                <td>{h.omniSide.toUpperCase()} {h.size} {h.coin}</td>
                <td>{VENUE_LABEL[h.hedgeVenue]} {h.hedgeSize > 0 ? '+' : ''}{h.hedgeSize}</td>
                <td className="num">{h.hedgePx || '—'}</td>
                <td><span className={`pill ${h.status === 'open' ? 'farming' : h.status === 'failed' ? 'avoid' : 'watch'}`}>{h.status}</span></td>
                <td>{h.status === 'open' && <button className="btn small-btn" disabled={busy} onClick={() => act(() => api().closeHedge(h.id))}>Закрыть хедж</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">В бумажном режиме хеджи тоже симулируются. Для реального хеджа включи LIVE и добавь ключи в Настройках.</p>
    </div>
  );
}

function phaseLabel(p: string) {
  return ({ opening: 'открытие', holding: 'удержание', closing: 'закрытие', done: 'готово', failed: 'сбой' } as Record<string, string>)[p] ?? p;
}

export function Num({ label, v, on, step }: { label: string; v: number; on: (v: number) => void; step?: number }) {
  return (
    <label>{label}
      <input type="number" step={step ?? 'any'} value={Number.isFinite(v) ? v : ''} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}
