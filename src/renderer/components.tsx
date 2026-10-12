export function Stat({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  return (
    <div className={`card stat ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small ellipsis">{sub}</div>}
    </div>
  );
}

export function StatusPill({ s }: { s: string }) {
  const map: Record<string, string> = {
    farming: 'Фармится',
    'tge-announced': 'TGE объявлен',
    'token-live': 'Токен вышел',
    watch: 'Наблюдаем',
    avoid: 'Избегать',
  };
  return <span className={`pill ${s}`}>{map[s] ?? s}</span>;
}

export function stateLabel(s: string) {
  return ({ stopped: 'Остановлен', starting: 'Запуск…', running: 'Работает', stopping: 'Останавливается', error: 'Ошибка' } as Record<string, string>)[s] ?? s;
}
