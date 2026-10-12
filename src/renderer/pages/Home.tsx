import { useEffect, useMemo, useState } from 'react';
import { AutopilotCard } from './AutopilotCard';
import type { BotStatus, ManualHedge, MarketSnapshot, ResearchFeed, VenueCredentialsView } from '../../shared/types';
import { dailyIncome, rankHoldIdeas, type EconomicsInputs, type HoldIdea } from '../../shared/economics';
import { api, usd } from '../api';
import type { Page } from '../App';

const OMNI_URL = 'https://omni.variational.io';

const NAMES: Record<string, string> = {
  BTC: 'Биткоин',
  ETH: 'Эфир',
  SOL: 'Солана',
  XAUT: 'Золото',
  XAG: 'Серебро',
  AVAX: 'Avalanche',
  UNI: 'Uniswap',
  ONDO: 'Ondo',
  XRP: 'XRP',
  HYPE: 'Hyperliquid',
  LINK: 'Chainlink',
  DOGE: 'Dogecoin',
};
const nameOf = (coin: string) => (NAMES[coin] ? `${NAMES[coin]} (${coin})` : coin);
const sideRu = (s: 'long' | 'short') => (s === 'long' ? 'LONG (купить)' : 'SHORT (продать)');
const opposite = (s: 'long' | 'short') => (s === 'long' ? 'short' : 'long');

const FALLBACK: EconomicsInputs = {
  nado: { pointsPer1MVolume: 160, cashBackBps: 0.4, pointValue: 0.6 },
  variational: { pointsPer1MVolume: 9.6, pointsPer1MOiWeek: 86, pointValue: 20, roundTripSpreadBps: 1 },
  fees: { nadoMaker: 1, nadoTaker: 3.5, hlTaker: 4.5, lighterTaker: 0 },
  hedgeSlippageBps: 0.3,
};

type Step = 'idle' | 'nado' | 'omni' | 'done' | 'close-omni' | 'close-nado';

export function VariationalManual({ feed, bot, go }: { feed: ResearchFeed | null; bot: BotStatus | null; go: (p: Page) => void }) {
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [creds, setCreds] = useState<VenueCredentialsView | null>(null);
  const [amount, setAmount] = useState(1000);
  const [step, setStep] = useState<Step>('idle');
  const [chosen, setChosen] = useState<HoldIdea | null>(null);
  const [closing, setClosing] = useState<ManualHedge | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    const load = () => api().getMarkets().then(setSnap).catch(() => {});
    void load();
    void api().getCreds().then(setCreds);
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const e = feed?.economics ?? FALLBACK;
  const ideas = useMemo(() => (snap ? rankHoldIdeas(snap.rows, e, amount, 7) : []), [snap, e, amount]);
  const best = ideas[0];
  const paper = bot?.mode !== 'live';
  const ready = paper || !!creds?.nado.hasKey;
  const deals = (bot?.hedges ?? []).filter((h) => h.status === 'open');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  const start = (idea: HoldIdea) => {
    setChosen(idea);
    setStep('nado');
  };

  const openNado = (idea: HoldIdea) =>
    run(async () => {
      const size = amount / idea.price;
      const st = await api().openHedge(idea.coin, idea.omniSide, size, 'nado', true);
      if (st.hedges[0]?.status !== 'open') throw new Error('Nado не исполнил ордер. Попробуй ещё раз через минуту.');
      setStep('omni');
    });

  const closeNado = (deal: ManualHedge) =>
    run(async () => {
      await api().closeHedge(deal.id);
      setStep('done');
      setClosing(null);
    });

  const quoteFor = (coin: string) => snap?.rows.find((r) => r.coin === coin)?.quotes;

  return (
    <div className="manual">
      {!ready && (
        <div className="banner error">
          Чтобы приложение само открывало сделку на Nado, подключи Nado в <a onClick={() => go('settings')}>Настройках</a> (2 минуты).
        </div>
      )}

      <div className="card how">
        <div className="row clickable" onClick={() => setShowHow(!showHow)}>
          <h3>Как это работает? (30 секунд)</h3>
          <span className="muted">{showHow ? '▴' : '▾'}</span>
        </div>
        {showHow && (
          <ol className="how-list">
            <li><b>Две сделки в разные стороны.</b> На одной бирже ты в LONG (зарабатываешь, когда цена растёт), на другой в SHORT (зарабатываешь, когда падает).</li>
            <li><b>Цена монеты тебе не важна.</b> Сколько одна сделка теряет, столько другая зарабатывает. Итог по цене около нуля.</li>
            <li><b>Деньги приходят из двух мест:</b> 1) биржи каждый час доплачивают тем, кто держит сделку в «правильную» сторону (это называется фандинг); 2) Variational начисляет поинты за открытую сделку, а потом обменяет их на свои токены.</li>
            <li><b>Риск:</b> если цена улетит очень сильно, биржа может принудительно закрыть одну сторону. Поэтому на каждую биржу клади <b>половину суммы сделки + запас</b> и не бери большое плечо.</li>
          </ol>
        )}
      </div>

      {step === 'idle' && (
        <div className="card hero">
          <div className="muted small">Сумма сделки</div>
          <div className="amount-row">
            {[500, 1000, 2000, 5000].map((v) => (
              <button key={v} className={`chip-btn ${amount === v ? 'on' : ''}`} onClick={() => setAmount(v)}>{usd(v)}</button>
            ))}
          </div>

          {!best && <p className="muted">Ищу лучшую сделку…</p>}
          {best && (
            <>
              <h2 className="hero-title">Лучшая сделка сейчас: {nameOf(best.coin)}</h2>
              <div className="legs">
                <div className="leg">
                  <div className="muted small">Variational (руками)</div>
                  <div className={`leg-side ${best.omniSide}`}>{sideRu(best.omniSide)}</div>
                  <div className="small">на {usd(amount)}</div>
                </div>
                <div className="leg-plus">+</div>
                <div className="leg">
                  <div className="muted small">Nado (сделает приложение)</div>
                  <div className={`leg-side ${opposite(best.omniSide)}`}>{sideRu(opposite(best.omniSide))}</div>
                  <div className="small">на {usd(amount)}</div>
                </div>
              </div>
              <div className="earn">
                <div className="earn-big">≈ {usd(best.netUsd)} <span className="muted">за неделю</span></div>
                <div className="small muted">
                  {usd(best.fundingUsd)} доплатят биржи + {usd(best.pointsUsd)} поинтами Variational − {usd(best.costUsd)} на вход и выход
                </div>
              </div>
              <button className="btn primary big" disabled={!ready} onClick={() => start(best)}>Начать сделку</button>
              <p className="muted small">На каждую биржу нужно положить хотя бы {usd(amount * 0.6)}.</p>

              {ideas.length > 1 && (
                <details className="others">
                  <summary>Другие варианты</summary>
                  {ideas.slice(1, 6).map((i) => (
                    <div key={i.coin} className="other-row">
                      <span><b>{nameOf(i.coin)}</b> · Variational {i.omniSide.toUpperCase()}</span>
                      <span className={i.netUsd >= 0 ? 'good' : 'bad'}>≈ {usd(i.netUsd)} / неделя</span>
                      <button className="btn ghost small-btn" disabled={!ready} onClick={() => start(i)}>выбрать</button>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      )}

      {chosen && (step === 'nado' || step === 'omni') && (
        <div className="card hero">
          <h2 className="hero-title">{nameOf(chosen.coin)} на {usd(amount)}</h2>
          <div className={`step ${step === 'nado' ? 'active' : 'done'}`}>
            <div className="step-num">{step === 'nado' ? '1' : '✓'}</div>
            <div className="grow">
              <b>Шаг 1. {sideRu(opposite(chosen.omniSide))} на Nado</b>
              <div className="small muted">Нажми кнопку, приложение сделает всё само. Это займёт до 1 минуты.</div>
              {step === 'nado' && (
                <button className="btn primary" disabled={busy} onClick={() => openNado(chosen)}>
                  {busy ? 'Открываю на Nado…' : 'Открыть на Nado'}
                </button>
              )}
            </div>
          </div>
          <div className={`step ${step === 'omni' ? 'active' : ''}`}>
            <div className="step-num">2</div>
            <div className="grow">
              <b>Шаг 2. {sideRu(chosen.omniSide)} на Variational</b>
              <div className="small muted">
                Открой сайт, выбери <b>{chosen.coin}</b>, нажми <b>{chosen.omniSide === 'long' ? 'Buy / Long' : 'Sell / Short'}</b>, сумма{' '}
                <b>{usd(amount)}</b> (≈ {(amount / chosen.price).toFixed(4)} {chosen.coin}), плечо 2x.
              </div>
              {step === 'omni' && (
                <div className="actions">
                  <button className="btn" onClick={() => void api().openExternal(OMNI_URL)}>Открыть Variational ↗</button>
                  <button className="btn primary" onClick={() => setStep('done')}>Готово, открыл</button>
                </div>
              )}
            </div>
          </div>
          {step === 'nado' && <button className="btn ghost small-btn" onClick={() => setStep('idle')}>Отмена</button>}
        </div>
      )}

      {step === 'done' && (
        <div className="card hero done-card">
          <h2 className="hero-title">Готово!</h2>
          <p>Сделка работает. Ничего не трогай: раз в день-два загляни сюда и проверь, что она всё ещё «зелёная».</p>
          <button className="btn" onClick={() => { setStep('idle'); setChosen(null); }}>Ок</button>
        </div>
      )}

      {closing && (step === 'close-omni' || step === 'close-nado') && (
        <div className="card hero">
          <h2 className="hero-title">Закрываем {nameOf(closing.coin)}</h2>
          <div className={`step ${step === 'close-omni' ? 'active' : 'done'}`}>
            <div className="step-num">{step === 'close-omni' ? '1' : '✓'}</div>
            <div className="grow">
              <b>Шаг 1. Закрой сделку на Variational</b>
              <div className="small muted">На сайте во вкладке Positions нажми Close у {closing.coin}.</div>
              {step === 'close-omni' && (
                <div className="actions">
                  <button className="btn" onClick={() => void api().openExternal(OMNI_URL)}>Открыть Variational ↗</button>
                  <button className="btn primary" onClick={() => setStep('close-nado')}>Закрыл</button>
                </div>
              )}
            </div>
          </div>
          <div className={`step ${step === 'close-nado' ? 'active' : ''}`}>
            <div className="step-num">2</div>
            <div className="grow">
              <b>Шаг 2. Закрыть на Nado</b>
              <div className="small muted">Приложение закроет вторую половину само.</div>
              {step === 'close-nado' && (
                <button className="btn primary" disabled={busy} onClick={() => closeNado(closing)}>{busy ? 'Закрываю…' : 'Закрыть на Nado'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {err && <div className="banner error">{err}</div>}

      <div className="card">
        <h3>Мои ручные сделки</h3>
        {deals.length === 0 && <p className="muted">Пока нет открытых сделок.</p>}
        {deals.map((d) => {
          const q = quoteFor(d.coin);
          const notional = Math.abs(d.hedgeSize) * (q?.nado?.mid ?? d.hedgePx);
          const perDay =
            q?.variational?.fundingApr != null && q?.nado?.fundingApr != null
              ? dailyIncome(notional, d.omniSide, q.variational.fundingApr, q.nado.fundingApr)
              : null;
          const days = Math.max(0, (Date.now() - d.openedAt) / 86_400_000);
          const pointsPerDay = (notional / 1e6) * (e.variational.pointsPer1MOiWeek / 7);
          const good = perDay === null || perDay + pointsPerDay * e.variational.pointValue >= 0;
          return (
            <div key={d.id} className={`deal ${good ? "deal-ok" : "deal-warn"}`}>
              <div className="grow">
                <b>{nameOf(d.coin)}</b> · {usd(notional)} · открыта {days < 1 ? 'сегодня' : `${Math.floor(days)} дн. назад`}
                <div className="small muted">
                  Variational {d.omniSide.toUpperCase()} · Nado {opposite(d.omniSide).toUpperCase()}
                </div>
                <div className="small">
                  {perDay === null ? '—' : perDay >= 0 ? <span className="good">биржи платят тебе ≈ {usd(perDay, 2)} в день</span> : <span className="bad">сейчас фандинг против тебя: −{usd(-perDay, 2)} в день</span>}
                  {' · '}поинты ≈ {(pointsPerDay * 7).toFixed(2)} в неделю
                </div>
                {!good && <div className="small bad">Сделка перестала окупаться — лучше закрыть.</div>}
              </div>
              <button className="btn" disabled={busy} onClick={() => { setClosing(d); setStep('close-omni'); }}>Закрыть сделку</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Home({ feed, bot, go }: { feed: ResearchFeed | null; bot: BotStatus | null; go: (p: Page) => void }) {
  return (
    <div className="page home">
      <header className="page-head">
        <h1>Главная</h1>
        <p className="muted">Нажми «Запустить» — дальше приложение торгует само.</p>
      </header>
      {bot?.mode !== 'live' && (
        <div className="banner warn">
          Режим <b>тренировки</b>: деньги не настоящие. Когда посмотришь, как работает, включи «По-настоящему» в{' '}
          <a onClick={() => go('settings')}>Настройках</a>.
        </div>
      )}
      <AutopilotCard bot={bot} go={go} />
      <details className="card">
        <summary>
          <b>Variational — самые ценные поинты (только руками)</b>
          <div className="small muted">
            Правила Variational запрещают ботов: за автоматическую торговлю там могут обнулить поинты. Поэтому сделку там открываешь сам,
            один раз на неделю-две, а приложение подсказывает, что нажать, и само ставит вторую половину на Nado.
          </div>
        </summary>
        <VariationalManual feed={feed} bot={bot} go={go} />
      </details>
    </div>
  );
}
