import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AUTOPILOT_CONFIG,
  DEFAULT_BOT_CONFIG,
  type AutopilotConfig,
  type AutopilotStatus,
  type BotConfig,
  type BotStats,
  type CredentialsInput,
  type ManualHedge,
  type PointsEntry,
  type VenueCredentialsView,
} from '../shared/types';

interface StoredCreds {
  nado: { address: string; subaccount: string; keyEnc: string };
  hyperliquid: { address: string; keyEnc: string };
  lighter: { accountIndex: string; apiKeyIndex: string; keyEnc: string };
}

interface StoreData {
  /** Bumped when defaults change in a way existing installs should pick up. */
  configRev?: number;
  botConfig: BotConfig;
  stats?: BotStats;
  hedges: ManualHedge[];
  points: PointsEntry[];
  creds: StoredCreds;
  autopilotConfig?: AutopilotConfig;
  /** The user turned the autopilot on (and did not turn it off): resume it on app start. */
  autopilotEnabled?: boolean;
  /** Kept per mode so a practice position is never "restored" into live trading. */
  /** Keyed by mode ("paper"/"live") for the Nado strategy and "entropy:<mode>" for Entropy. */
  autopilotState?: Record<string, AutopilotStatus | undefined>;
}

const DEFAULTS: StoreData = {
  botConfig: DEFAULT_BOT_CONFIG,
  hedges: [],
  points: [],
  creds: {
    nado: { address: '', subaccount: 'default', keyEnc: '' },
    hyperliquid: { address: '', keyEnc: '' },
    lighter: { accountIndex: '', apiKeyIndex: '', keyEnc: '' },
  },
};

/** Small JSON store in the user-data folder. Private keys are encrypted with the OS keychain (safeStorage). */
export class Store {
  private file: string;
  private data: StoreData;

  constructor() {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    this.data = this.read();
    this.migrate();
  }

  private migrate() {
    if ((this.data.configRev ?? 1) < 2) {
      // v0.1.2: Lighter (0% fees) replaces Hyperliquid as the default hedge leg.
      if (this.data.botConfig.legB === 'hyperliquid' && this.data.botConfig.legA !== 'lighter') this.data.botConfig.legB = 'lighter';
      this.data.configRev = 2;
      this.write();
    }
    if ((this.data.configRev ?? 1) < 3) {
      // v0.1.2: tuned maker settings from paper experiments (cheapest cost per $1M of Nado volume).
      const c = this.data.botConfig;
      c.makerLegA = true;
      c.makerWaitSec = 45;
      c.makerRequotes = 6;
      if (c.coins.join(',') === 'BTC,ETH,SOL') c.coins = ['BTC', 'ETH'];
      this.data.configRev = 3;
      this.write();
    }
    if ((this.data.configRev ?? 1) < 4) {
      // v0.1.5: the default autopilot farms Entropy. Keep Nado only for a real (live) Nado position.
      const holding = !!this.data.autopilotState?.live?.hold;
      if (holding) this.data.autopilotConfig = { ...DEFAULT_AUTOPILOT_CONFIG, ...this.data.autopilotConfig, strategy: 'nado' };
      this.data.configRev = 4;
      this.write();
    }
  }

  private read(): StoreData {
    if (!existsSync(this.file)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>;
      return {
        ...structuredClone(DEFAULTS),
        ...raw,
        botConfig: { ...DEFAULT_BOT_CONFIG, ...raw.botConfig },
        creds: {
          nado: { ...DEFAULTS.creds.nado, ...raw.creds?.nado },
          hyperliquid: { ...DEFAULTS.creds.hyperliquid, ...raw.creds?.hyperliquid },
          lighter: { ...DEFAULTS.creds.lighter, ...raw.creds?.lighter },
        },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  private write() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get botConfig() {
    return this.data.botConfig;
  }
  setBotConfig(c: BotConfig) {
    this.data.botConfig = { ...DEFAULT_BOT_CONFIG, ...c };
    this.write();
  }

  get stats() {
    return this.data.stats;
  }
  get hedges() {
    return this.data.hedges;
  }
  saveBotState(stats: BotStats, hedges: ManualHedge[]) {
    this.data.stats = stats;
    this.data.hedges = hedges;
    this.write();
  }

  get autopilotConfig(): AutopilotConfig {
    return { ...DEFAULT_AUTOPILOT_CONFIG, ...this.data.autopilotConfig };
  }
  setAutopilotConfig(c: AutopilotConfig) {
    this.data.autopilotConfig = { ...DEFAULT_AUTOPILOT_CONFIG, ...c };
    this.write();
  }
  get autopilotEnabled() {
    return !!this.data.autopilotEnabled;
  }
  setAutopilotEnabled(on: boolean) {
    this.data.autopilotEnabled = on;
    this.write();
  }
  autopilotState(key: string): AutopilotStatus | undefined {
    return this.data.autopilotState?.[key];
  }
  saveAutopilotState(key: string, s: AutopilotStatus) {
    this.data.autopilotState = { ...this.data.autopilotState, [key]: s };
    this.write();
  }

  get points() {
    return this.data.points;
  }
  setPoints(points: PointsEntry[]) {
    this.data.points = points;
    this.write();
  }

  credentialsView(): VenueCredentialsView {
    const c = this.data.creds;
    return {
      nado: { address: c.nado.address, subaccount: c.nado.subaccount, hasKey: !!c.nado.keyEnc },
      hyperliquid: { address: c.hyperliquid.address, hasKey: !!c.hyperliquid.keyEnc },
      lighter: { accountIndex: c.lighter.accountIndex, apiKeyIndex: c.lighter.apiKeyIndex, hasKey: !!c.lighter.keyEnc },
    };
  }

  setCredentials(input: CredentialsInput) {
    const c = this.data.creds;
    if (input.nado) {
      if (input.nado.address !== undefined) c.nado.address = input.nado.address.trim();
      if (input.nado.subaccount !== undefined) c.nado.subaccount = input.nado.subaccount.trim() || 'default';
      if (input.nado.privateKey !== undefined) c.nado.keyEnc = encrypt(input.nado.privateKey);
    }
    if (input.hyperliquid) {
      if (input.hyperliquid.address !== undefined) c.hyperliquid.address = input.hyperliquid.address.trim();
      if (input.hyperliquid.privateKey !== undefined) c.hyperliquid.keyEnc = encrypt(input.hyperliquid.privateKey);
    }
    if (input.lighter) {
      if (input.lighter.accountIndex !== undefined) c.lighter.accountIndex = input.lighter.accountIndex.trim();
      if (input.lighter.apiKeyIndex !== undefined) c.lighter.apiKeyIndex = input.lighter.apiKeyIndex.trim();
      if (input.lighter.privateKey !== undefined) c.lighter.keyEnc = encrypt(input.lighter.privateKey);
    }
    this.write();
  }

  lighterCredentials() {
    const c = this.data.creds.lighter;
    const accountIndex = Number(c.accountIndex);
    const apiKeyIndex = Number(c.apiKeyIndex);
    if (!c.keyEnc || !Number.isInteger(accountIndex) || !Number.isInteger(apiKeyIndex) || c.accountIndex === '' || c.apiKeyIndex === '') {
      throw new Error('Lighter: укажи account index, API key index и API-ключ в Настройках');
    }
    return { accountIndex, apiKeyIndex, apiKeyPrivateKey: decrypt(c.keyEnc) };
  }

  nadoCredentials() {
    const c = this.data.creds.nado;
    if (!c.address || !c.keyEnc) throw new Error('Nado: укажи адрес и ключ в Настройках');
    return { address: c.address, subaccount: c.subaccount, privateKey: decrypt(c.keyEnc) };
  }

  hyperliquidCredentials() {
    const c = this.data.creds.hyperliquid;
    if (!c.address || !c.keyEnc) throw new Error('Hyperliquid: укажи адрес и API-ключ в Настройках');
    return { address: c.address, privateKey: decrypt(c.keyEnc) };
  }
}

function encrypt(secret: string): string {
  const s = secret.trim();
  if (!s) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Шифрование ОС недоступно — ключ не сохранён');
  return safeStorage.encryptString(s).toString('base64');
}

function decrypt(enc: string): string {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'));
}
