import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'rate_limits.json');

interface UserRecord {
  date: string;
  count: number;
  lastRequestAt: number;
}

type Store = Record<string, UserRecord>;

function readStore(): Store {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

export function countTodayRequests(userId: string): number {
  const store = readStore();
  const rec = store[userId];
  if (!rec || rec.date !== todayStr()) return 0;
  return rec.count;
}

export function getLastRequestTime(userId: string): number | null {
  const store = readStore();
  return store[userId]?.lastRequestAt ?? null;
}

export function recordRequest(userId: string): void {
  const store = readStore();
  const today = todayStr();
  const existing = store[userId];
  store[userId] = {
    date: today,
    count: existing?.date === today ? existing.count + 1 : 1,
    lastRequestAt: Math.floor(Date.now() / 1000),
  };
  writeStore(store);
}
