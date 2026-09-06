const QUOTA_CONFLICT_WINDOW_MS = 5 * 60 * 1000;
const QUOTA_ESTIMATE_ALGORITHM = 4;
const QUOTA_MODE_LOCAL = "local";
const QUOTA_MODE_ONLINE = "online";
const TOKEN_LEDGER_VERSION = 1;
const TOKEN_LEDGER_SCAN_LIMIT = 120;
const TOKEN_LEDGER_FILE_LIMIT = 180;
const TOKEN_LEDGER_EVENT_LIMIT = 25000;
const QUOTA_RATE_CARD_BASE_INPUT_CREDITS = 125;
const LOCAL_DATA_CACHE_TTL_MS = 2500;
const SESSION_POLL_RECENT_FILE_LIMIT = 40;
const SESSION_POLL_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const CODEX_RATE_CARDS = [
  { pattern: /gpt[-_\s]?5\.5/, input: 125, cachedInput: 12.5, output: 750, fastMultiplier: 2.5 },
  { pattern: /gpt[-_\s]?5\.4[-_\s]?mini/, input: 18.75, cachedInput: 1.875, output: 113, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.4/, input: 62.5, cachedInput: 6.25, output: 375, fastMultiplier: 2 },
  { pattern: /gpt[-_\s]?5\.3[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.2/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
];
const DEFAULT_CODEX_RATE_CARD = CODEX_RATE_CARDS[0];

module.exports = {
  QUOTA_CONFLICT_WINDOW_MS,
  QUOTA_ESTIMATE_ALGORITHM,
  QUOTA_MODE_LOCAL,
  QUOTA_MODE_ONLINE,
  TOKEN_LEDGER_VERSION,
  TOKEN_LEDGER_SCAN_LIMIT,
  TOKEN_LEDGER_FILE_LIMIT,
  TOKEN_LEDGER_EVENT_LIMIT,
  QUOTA_RATE_CARD_BASE_INPUT_CREDITS,
  LOCAL_DATA_CACHE_TTL_MS,
  SESSION_POLL_RECENT_FILE_LIMIT,
  SESSION_POLL_RECENT_WINDOW_MS,
  CODEX_RATE_CARDS,
  DEFAULT_CODEX_RATE_CARD,
};
