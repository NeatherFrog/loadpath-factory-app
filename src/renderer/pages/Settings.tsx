import { useEffect, useState } from 'react';
import type { AppInfo, UpdateStatus, VenueCredentialsView } from '../../shared/types';
import { api } from '../api';

export function Settings({ update, info }: { update: UpdateStatus; info: AppInfo | null }) {
  const [creds, setCreds] = useState<VenueCredentialsView | null>(null);
  const [nadoAddr, setNadoAddr] = useState('');
  const [nadoSub, setNadoSub] = useState('default');
  const [nadoKey, setNadoKey] = useState('');
  const [hlAddr, setHlAddr] = useState('');
  const [hlKey, setHlKey] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void api().getCreds().then((c) => {
      setCreds(c);
      setNadoAddr(c.nado.address);
      setNadoSub(c.nado.subaccount);
      setHlAddr(c.hyperliquid.address);
    });
  }, []);

  const save = async () => {
    try {
      const c = await api().setCreds({
        nado: { address: nadoAddr, subaccount: nadoSub, ...(nadoKey ? { privateKey: nadoKey } : {}) },
        hyperliquid: { address: hlAddr, ...(hlKey ? { privateKey: hlKey } : {}) },
      });
      setCreds(c);
      setNadoKey('');
      setHlKey('');
      setMsg('Сохранено. Ключи зашифрованы системным хранилищем (Windows DPAPI / macOS Keychain).');
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Настройки</h1></header>

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
          <h3>Hyperliquid (хедж)</h3>
          <ol className="small steps">
            <li>Внеси USDC на <a onClick={() => void api().openExternal('https://app.hyperliquid.xyz')}>app.hyperliquid.xyz</a>.</li>
            <li>Создай <b>API Wallet</b> на странице <a onClick={() => void api().openExternal('https://app.hyperliquid.xyz/API')}>More → API</a>. Такой ключ может торговать, но не может выводить средства.</li>
            <li>Вставь адрес основного аккаунта и приватный ключ API-кошелька.</li>
          </ol>
          <div className="form">
            <label className="wide">Адрес основного аккаунта<input value={hlAddr} onChange={(e) => setHlAddr(e.target.value)} placeholder="0x…" /></label>
            <label className="wide">Приватный ключ API-кошелька {creds?.hyperliquid.hasKey && <span className="ok">✓ сохранён</span>}
              <input type="password" value={hlKey} onChange={(e) => setHlKey(e.target.value)} placeholder={creds?.hyperliquid.hasKey ? 'оставь пустым, чтобы не менять' : '0x…'} />
            </label>
          </div>
        </div>
      </div>
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
