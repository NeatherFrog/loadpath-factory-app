import { useEffect, useState } from 'react';
import type { AppInfo, BotStatus, ResearchFeed, UpdateStatus } from '../shared/types';
import { api } from './api';
import { Overview } from './pages/Overview';
import { Research } from './pages/Research';
import { Markets } from './pages/Markets';
import { Bot } from './pages/Bot';
import { Points } from './pages/Points';
import { Settings } from './pages/Settings';

export type Page = 'overview' | 'research' | 'markets' | 'bot' | 'points' | 'settings';

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'overview', label: 'Обзор', icon: '◎' },
  { id: 'research', label: 'Исследование', icon: '⌕' },
  { id: 'markets', label: 'Рынки', icon: '≋' },
  { id: 'bot', label: 'Бот (дельта-нейтрал)', icon: '⇄' },
  { id: 'points', label: 'Поинты & OTC', icon: '◈' },
  { id: 'settings', label: 'Настройки', icon: '⚙' },
];

export function App() {
  const [page, setPage] = useState<Page>('overview');
  const [feed, setFeed] = useState<ResearchFeed | null>(null);
  const [feedSource, setFeedSource] = useState<string>('');
  const [feedError, setFeedError] = useState('');
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' });
  const [info, setInfo] = useState<AppInfo | null>(null);

  const loadFeed = async (refresh = false) => {
    try {
      const r = await api().getFeed(refresh);
      setFeed(r.feed);
      setFeedSource(r.source);
      setFeedError('');
    } catch (e) {
      setFeedError(String(e));
    }
  };

  useEffect(() => {
    void loadFeed();
    void api().botStatus().then(setBot);
    void api().updateStatus().then(setUpdate);
    void api().appInfo().then(setInfo);
    const offs = [api().onBotStatus(setBot), api().onUpdateStatus(setUpdate)];
    // Research data refreshes from GitHub every 30 minutes.
    const t = setInterval(() => void loadFeed(true), 30 * 60_000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(t);
    };
  }, []);

  const running = bot && ['running', 'starting', 'stopping'].includes(bot.state);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◢</span>
          <div>
            <div className="brand-name">RetroDrop</div>
            <div className="brand-sub">dashboard · v{info?.version ?? '…'}</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.id === 'bot' && running && <span className="pulse" title="Бот работает" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <UpdateBadge s={update} />
          <div className="muted small">
            Данные: {feedSource === 'remote' ? 'GitHub (свежие)' : feedSource === 'cache' ? 'кэш' : 'встроенные'}
            {feed ? ` · ${feed.updatedAt}` : ''}
          </div>
        </div>
      </aside>
      <main className="content">
        {feedError && <div className="banner error">Не удалось загрузить исследование: {feedError}</div>}
        {page === 'overview' && <Overview feed={feed} bot={bot} go={setPage} />}
        {page === 'research' && <Research feed={feed} onRefresh={() => loadFeed(true)} />}
        {page === 'markets' && <Markets />}
        {page === 'bot' && <Bot status={bot} />}
        {page === 'points' && <Points feed={feed} bot={bot} />}
        {page === 'settings' && <Settings update={update} info={info} />}
      </main>
    </div>
  );
}

function UpdateBadge({ s }: { s: UpdateStatus }) {
  if (s.state === 'downloaded') {
    return (
      <button className="btn primary small-btn" onClick={() => void api().installUpdate()}>
        ⟳ Обновить до v{s.version}
      </button>
    );
  }
  const text: Record<UpdateStatus['state'], string> = {
    idle: 'Проверка обновлений…',
    checking: 'Проверяю обновления…',
    available: `Найдена v${s.version}, скачиваю…`,
    downloading: `Скачиваю v${s.version}: ${Math.round(s.progress ?? 0)}%`,
    downloaded: '',
    'up-to-date': 'Последняя версия ✓',
    error: 'Ошибка обновления',
    dev: 'Dev-режим',
  };
  return <div className={`update-badge ${s.state}`} title={s.message}>{text[s.state]}</div>;
}
