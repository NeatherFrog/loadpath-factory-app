import { useEffect, useState } from 'react';
import type { AppInfo, UpdateStatus, VenueCredentialsView } from '../../shared/types';
import { api } from '../api';

export const ENTROPY_URL = 'https://entropy.io/?r=exalt0x';

export function Settings({ update, info }: { update: UpdateStatus; info: AppInfo | null }) {
  const [creds, setCreds] = useState<VenueCredentialsView | null>(null);
  const [nadoAddr, setNadoAddr] = useState('');
  const [nadoSub, setNadoSub] = useState('default');
  const [nadoKey, setNadoKey] = useState('');
  const [hlAddr, setHlAddr] = useState('');
  const [hlKey, setHlKey] = useState('');
  const [ltAcc, setLtAcc] = useState('');
  const [ltIdx, setLtIdx] = useState('');
  const [ltKey, setLtKey] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setModeState] = useState<'paper' | 'live'>('paper');
  const [modeMsg, setModeMsg] = useState('');

  useEffect(() => {
    void api().getBotConfig().then((c) => setModeState(c.mode));
  }, []);

  const setMode = async (m: 'paper' | 'live') => {
    setModeMsg('');
    if (m === 'live' && !window.confirm('Включить настоящий режим? Автопилот будет торговать реальными деньгами.')) return;
    try {
      const c = await api().getBotConfig();
      const saved = await api().setBotConfig({ ...c, mode: m });
      setModeState(saved.mode);
    } catch (e) {
      setModeMsg(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void api().getCreds().then((c) => {
      setCreds(c);
      setNadoAddr(c.nado.address);
      setNadoSub(c.nado.subaccount);
      setHlAddr(c.hyperliquid.address);
      setLtAcc(c.lighter.accountIndex);
      setLtIdx(c.lighter.apiKeyIndex);
    });
  }, []);

  const save = async () => {
    try {
      const c = await api().setCreds({
        nado: { address: nadoAddr, subaccount: nadoSub, ...(nadoKey ? { privateKey: nadoKey } : {}) },
        hyperliquid: { address: hlAddr, ...(hlKey ? { privateKey: hlKey } : {}) },
        lighter: { accountIndex: ltAcc, apiKeyIndex: ltIdx, ...(ltKey ? { privateKey: ltKey } : {}) },
      });
      setCreds(c);
      setNadoKey('');
      setHlKey('');
      setLtKey('');
      setMsg('Сохранено. Ключи зашифрованы системным хранилищем (Windows DPAPI / macOS Keychain).');
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Настройки</h1></header>

      <div className="card mode-card">
        <h3>Режим</h3>
        <div className="seg big-seg">
          <button className={mode === 'paper' ? 'on' : ''} onClick={() => void setMode('paper')}>Тренировка (деньги не настоящие)</button>
          <button className={mode === 'live' ? 'on danger' : ''} onClick={() => void setMode('live')}>По-настоящему</button>
        </div>
        {modeMsg && <p className="small bad">{modeMsg}</p>}
      </div>

      <div className="card">
        <h3>Hyperliquid — для автопилота Entropy</h3>
        <p className="small muted">Entropy работает поверх Hyperliquid, поэтому нужен только один счёт и один ключ.</p>
        <ol className="small steps">
          <li>Зайди на <a onClick={() => void api().openExternal(ENTROPY_URL)}>entropy.io</a> и подключи тот же кошелёк, что на Hyperliquid, чтобы аккаунт числился на Entropy.</li>
          <li>Внеси USDC на <a onClick={() => void api().openExternal('https://app.hyperliquid.xyz')}>app.hyperliquid.xyz</a> (Deposit, сеть Arbitrum). Все деньги держи на этом одном счёте.</li>
          <li>Создай <b>API Wallet</b>: <a onClick={() => void api().openExternal('https://app.hyperliquid.xyz/API')}>More → API</a>. Такой ключ может торговать, но не может выводить деньги.</li>
          <li>Вставь сюда адрес основного кошелька и приватный ключ API-кошелька.</li>
        </ol>
        <div className="form">
          <label className="wide">Адрес основного кошелька<input value={hlAddr} onChange={(e) => setHlAddr(e.target.value)} placeholder="0x…" /></label>
          <label className="wide">Приватный ключ API-кошелька {creds?.hyperliquid.hasKey && <span className="ok">✓ сохранён</span>}
            <input type="password" value={hlKey} onChange={(e) => setHlKey(e.target.value)} placeholder={creds?.hyperliquid.hasKey ? 'оставь пустым, чтобы не менять' : '0x…'} />
          </label>
        </div>
      </div>

      <details className="card">
        <summary><b>Nado и Lighter (нужны только для автопилота «Nado + Lighter»)</b></summary>
        <div className="grid cols-2 align-start">
          <div className="card">
            <h3>Nado</h3>
            <ol className="small steps">
              <li>Внеси USDT0 на <a onClick={() => void api().openExternal('https://app.nado.xyz')}>app.nado.xyz</a> (минимум $5, чтобы создался субаккаунт).</li>
              <li>Включи <b>1-Click Trading</b> или создай <b>linked signer</b> по <a onClick={() => void api().openExternal('https://docs.nado.xyz/developer-resources/get-started/linked-signers')}>инструкции</a>: это отдельный ключ, который можно отозвать.</li>
              <li>Вставь адрес основного кошелька и приватный ключ linked signer'а.</li>
            </ol>
            <div className="form">
              <label className="wide">Адрес кошелька (владелец субаккаунта)<input value={nadoAddr} onChange={(e) => setNadoAddr(e.target.value)} placeholder="0x…" /></label>
              <label>Субаккаунт<input value={nadoSub} onChange={(e) => setNadoSub(e.target.value)} /></label>
              <label>Приватный ключ {creds?.nado.hasKey && <span className="ok">✓ сохранён</span>}
                <input type="password" value={nadoKey} onChange={(e) => setNadoKey(e.target.value)} placeholder={creds?.nado.hasKey ? 'оставь пустым, чтобы не менять' : '0x…'} />
              </label>
            </div>
          </div>
          <div className="card">
            <h3>Lighter (хедж с 0% комиссии)</h3>
            <ol className="small steps">
              <li>Внеси USDC на <a onClick={() => void api().openExternal('https://app.lighter.xyz')}>app.lighter.xyz</a>.</li>
              <li>Создай API-ключ на странице <a onClick={() => void api().openExternal('https://app.lighter.xyz/apikeys')}>API Keys</a>. Скопируй Account Index, API Key Index и Private Key. Такой ключ может торговать, но не может вывести средства без подписи твоего кошелька.</li>
            </ol>
            <div className="form">
              <label>Account Index<input value={ltAcc} onChange={(e) => setLtAcc(e.target.value)} placeholder="например 123456" /></label>
              <label>API Key Index<input value={ltIdx} onChange={(e) => setLtIdx(e.target.value)} placeholder="2–254" /></label>
              <label className="wide">API Private Key {creds?.lighter.hasKey && <span className="ok">✓ сохранён</span>}
                <input type="password" value={ltKey} onChange={(e) => setLtKey(e.target.value)} placeholder={creds?.lighter.hasKey ? 'оставь пустым, чтобы не менять' : 'ключ Lighter'} />
              </label>
            </div>
          </div>
        </div>
      </details>
      <div className="actions">
        <button className="btn primary" onClick={save}>Сохранить ключи</button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
      <div className="banner warn">
        Никогда не вставляй сид-фразу и ключ кошелька с основными средствами. Используй только торговые ключи (linked signer или API wallet)
        и держи на биржах ровно столько, сколько нужно боту.
      </div>

      <div className="card">
        <h3>Обновления</h3>
        <p className="small">
          Версия <b>{info?.version}</b>. Приложение проверяет GitHub Releases при запуске и каждые 30 минут, скачивает новую версию в фоне
          и ставит её при перезапуске. Данные исследования (проекты, оценки) подтягиваются отдельно, без переустановки.
        </p>
        <div className="actions">
          <button className="btn" onClick={() => void api().checkUpdates()}>Проверить сейчас</button>
          {update.state === 'downloaded' && <button className="btn primary" onClick={() => void api().installUpdate()}>Перезапустить и обновить до v{update.version}</button>}
          <span className="muted small">Статус: {update.state}{update.message ? ` — ${update.message}` : ''}</span>
        </div>
      </div>
    </div>
  );
}
