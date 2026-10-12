import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_BOT_CONFIG,
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
}

interface StoreData {
  botConfig: BotConfig;
  stats?: BotStats;
  hedges: ManualHedge[];
  points: PointsEntry[];
  creds: StoredCreds;
}

const DEFAULTS: StoreData = {
  botConfig: DEFAULT_BOT_CONFIG,
  hedges: [],
  points: [],
  creds: { nado: { address: '', subaccount: 'default', keyEnc: '' }, hyperliquid: { address: '', keyEnc: '' } },
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
    this.write();
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
