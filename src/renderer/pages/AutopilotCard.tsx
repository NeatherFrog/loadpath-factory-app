import { useEffect, useState } from 'react';
import type { AutopilotConfig, AutopilotStatus, BotStatus, VenueCredentialsView } from '../../shared/types';
import { api, usd } from '../api';
import type { Page } from '../App';

const BUDGETS = [0, 2, 5, 10];
const NADO_POINTS_PER_1M = 160;

export function AutopilotCard({ bot, go }: { bot: BotStatus | null; go: (p: Page) => void }) {
  const [s, setS] = useState<AutopilotStatus | null>(null);
  const [cfg, setCfg] = useState<AutopilotConfig | null>(null);
  const [creds, setCreds] = useState<VenueCredentialsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void api().autopilotStatus().then(setS);
    void api().getAutopilotConfig().then(setCfg);
    void api().getCreds().then(setCreds);
    return api().onAutopilot(setS);
  }, []);

  const live = bot?.mode === 'live';
  const missingKeys = live && creds && (!creds.nado.hasKey || !creds.lighter.hasKey);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      setS(await api().autopilotStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setBudget = async (v: number) => {
    if (!cfg) return;
    setCfg(await api().setAutopilotConfig({ ...cfg, dailyBudgetUsd: v }));
  };

  const running = !!s?.running;
  const hold = s?.hold;
  const perDay = s ? (s.notionalUsd * s.incomeApr) / 365 : 0;
  const nadoVolume = bot?.stats.perVenue.nado?.volumeUsd ?? 0;

  return (
    <div className="card hero autopilot">
      <div className="row">
        <h2 className="hero-title">Автопилот</h2>
        <span className={`state-pill ${running ? 'running' : 'stopped'}`}>{running ? 'Работает' : 'Выключен'}</span>
      </div>

      {!running && (
        <p>
          Сам держит зеркальную сделку на <b>Nado</b> и <b>Lighter</b> по монете, где биржи сейчас платят больше всего. Сам
          открывает, докупает, переключается и закрывает. Всё, что заработал, тратит на объём на Nado, чтобы копились поинты.
        </p>
      )}

      {missingKeys && (
        <div className="banner error">
          Для настоящей торговли подключи Nado и Lighter в <a onClick={() => go('settings')}>Настройках</a>.
        </div>
      )}

      {running && (
        <div className="ap-grid">
          <div className="ap-box">
            <div className="muted small">Сейчас держу</div>
            {hold ? (
              <>
                <div className="ap-big">{hold.coin} на {usd(s!.notionalUsd)}</div>
                <div className="small">
                  Nado <b className={hold.nadoSide === 'long' ? 'good' : 'bad'}>{hold.nadoSide === 'long' ? 'LONG' : 'SHORT'}</b> · Lighter{' '}
                  <b className={hold.nadoSide === 'long' ? 'bad' : 'good'}>{hold.nadoSide === 'long' ? 'SHORT' : 'LONG'}</b>
                </div>
              </>
            ) : (
              <div className="ap-big muted">{s?.message}</div>
            )}
          </div>
          <div className="ap-box">
            <div className="muted small">Биржи платят</div>
            <div className={`ap-big ${perDay >= 0 ? 'good' : 'bad'}`}>{usd(perDay, 2)} в день</div>
            <div className="small muted">заработано сегодня {usd(s?.fundingTodayUsd ?? 0, 2)} · всего {usd(s?.fundingTotalUsd ?? 0, 2)}</div>
          </div>
          <div className="ap-box">
            <div className="muted small">Поинты Nado</div>
            <div className="ap-big">≈ {((nadoVolume / 1e6) * NADO_POINTS_PER_1M).toFixed(1)}</div>
            <div className="small muted">объём на Nado {usd(nadoVolume)}</div>
          </div>
        </div>
      )}

      {cfg && (
        <div>
          <div className="muted small">Сколько своих денег добавлять на поинты в день (кроме заработанного)</div>
          <div className="amount-row">
            {BUDGETS.map((b) => (
              <button key={b} className={`chip-btn ${cfg.dailyBudgetUsd === b ? 'on' : ''}`} onClick={() => void setBudget(b)}>
                {b === 0 ? '$0 — только заработанное' : `$${b}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="actions">
        {!running ? (
          <button className="btn primary big" disabled={busy || !!missingKeys} onClick={() => act(() => api().startAutopilot())}>
            ▶ Запустить автопилот
          </button>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => act(() => api().stopAutopilot(false))}>
              ■ Пауза (позиция остаётся)
            </button>
            <button
              className="btn danger ghost"
              disabled={busy}
              onClick={() => act(async () => {
                if (window.confirm('Остановить автопилот и закрыть позицию на обеих биржах?')) await api().stopAutopilot(true);
              })}
            >
              Остановить и закрыть всё
            </button>
          </>
        )}
      </div>
      {!running && (
        <p className="muted small">
          {live ? 'Торговля настоящими деньгами.' : 'Режим тренировки: на каждой бирже условно $1000, сделки не настоящие.'} Нужно держать деньги на
          Nado и Lighter примерно поровну: размер сделки = меньший баланс × 2.
        </p>
      )}
      {err && <div className="banner error">{err}</div>}

      {s && s.events.length > 0 && (
        <div>
          <div className="muted small">Что я делал</div>
          <ul className="ap-events">
            {s.events.slice(0, 8).map((e, i) => (
              <li key={i} className={e.kind}>
                <span className="muted">{new Date(e.ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> {e.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
