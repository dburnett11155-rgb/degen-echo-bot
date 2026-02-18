"use strict";

/**
 * DEGEN ECHO – PRODUCTION BOT
 *
 * Price feed chain (most reliable to last resort):
 *   1. Kraken WebSocket v2        – live streaming, primary
 *   2. Pyth Network on-chain      – reads SOL/USD directly from Solana via
 *                                   the RPC connection already in the bot.
 *                                   No HTTP, no API key, cannot be IP-blocked.
 *   3. Kraken REST                – public, no key needed
 *   4. Binance REST               – public, no key needed
 *   5. CoinGecko REST             – public, no key needed
 *   6. Last Known Good Price      – last real price saved to disk on every tick
 *   7. Betting paused             – only if every source above fails
 *
 * All fixes included:
 *   - Phantom callback params fixed (publicKey / signature, no dapp_key)
 *   - Phantom sessions persisted to disk (survive Render restarts/sleep)
 *   - Manual bet verification by sender address + amount (not broken memo logs)
 *   - Payout math: streak multipliers as weighted shares (pot never exceeded)
 *   - Atomic state saves (write .tmp then rename, no corruption on crash)
 *   - Settlement hour key persisted (no double-settlement after restart)
 *   - Render free-tier self-ping keep-alive every 10 min
 *   - processedTxSigs bounded to 500 entries
 */

require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection, PublicKey, LAMPORTS_PER_SOL,
  Keypair, Transaction, SystemProgram,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const express   = require("express");
const cron      = require("node-cron");
const bs58      = require("bs58");
const crypto    = require("crypto");
const fs        = require("fs");
const path      = require("path");
const https     = require("https");

// ─────────────────────────────────────────────────────────────
// ENV VALIDATION
// ─────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "BOT_TOKEN", "BOT_PRIVATE_KEY", "RAKE_WALLET",
  "ADMIN_TELEGRAM_ID", "APP_URL",
];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) { console.error("Missing env: " + k); process.exit(1); }
}

const BOT_TOKEN          = process.env.BOT_TOKEN;
const BOT_PRIVATE_KEY    = process.env.BOT_PRIVATE_KEY;
const RAKE_WALLET        = process.env.RAKE_WALLET;
const ADMIN_TELEGRAM_ID  = process.env.ADMIN_TELEGRAM_ID;
const ADMIN_IDS          = [ADMIN_TELEGRAM_ID, "1087968824"].filter(Boolean);
const APP_URL            = process.env.APP_URL.replace(/\/$/, "");
const SOLANA_RPC         = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT               = Number(process.env.PORT) || 3000;

const RAKE_PCT    = 0.19;
const POT_PCT     = 0.80;
const JACKPOT_PCT = 0.01;

const MIN_STAKE          = 0.001;
const MAX_STAKE          = 1000;
const PAYMENT_TIMEOUT_MS = 5 * 60_000;
const BLOCKCHAIN_POLL_MS = 6_000;
const RATE_LIMIT         = 20;
const RATE_WINDOW_MS     = 60_000;
const VOTE_COOLDOWN_MS   = 3_000;
const DAILY_REWARDS      = [0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.015];

// Pyth Network SOL/USD price account on Solana mainnet
// Verified address: https://pyth.network/price-feeds/crypto-sol-usd
const PYTH_SOL_USD = "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG";

function normalizeChatId(c) {
  if (!c) return c;
  if (/^-?\d+$/.test(c)) return c;
  return c.startsWith("@") ? c : "@" + c;
}

const LIVE_CHANNEL          = normalizeChatId(process.env.LIVE_CHANNEL          || "@degenecholive");
const COMMUNITY_GROUP       = normalizeChatId(process.env.COMMUNITY_GROUP       || "@degenechochat");
const ANNOUNCEMENTS_CHANNEL = normalizeChatId(process.env.ANNOUNCEMENTS_CHANNEL || "@degenechochamber");

// ─────────────────────────────────────────────────────────────
// SOLANA
// ─────────────────────────────────────────────────────────────

let connection;
try {
  connection = new Connection(SOLANA_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  console.log("Solana RPC ready");
} catch (e) { console.error("Solana init failed:", e.message); process.exit(1); }

let botWallet;
try {
  botWallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));
  console.log("Bot wallet: " + botWallet.publicKey.toString());
} catch (e) { console.error("Wallet load failed:", e.message); process.exit(1); }

// ─────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────

const log = {
  info:  (...a) => console.log (new Date().toISOString() + " INFO  " + a.join(" ")),
  warn:  (...a) => console.warn(new Date().toISOString() + " WARN  " + a.join(" ")),
  error: (...a) => console.error(new Date().toISOString() + " ERROR " + a.join(" ")),
  ok:    (...a) => console.log (new Date().toISOString() + " OK    " + a.join(" ")),
};

// ─────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────

const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE    = path.join(DATA_DIR, "state.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LKGP_FILE     = path.join(DATA_DIR, "lkgp.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Atomic write: temp file then rename prevents corruption on crash mid-write
function atomicWrite(filePath, data) {
  ensureDataDir();
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function saveLKGP(price) {
  try { atomicWrite(LKGP_FILE, { price, savedAt: Date.now() }); } catch (_) {}
}

function loadLKGP() {
  try {
    if (!fs.existsSync(LKGP_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(LKGP_FILE, "utf8"));
    return (d.price > 0) ? d : null;
  } catch { return null; }
}

function saveState() {
  try {
    atomicWrite(STATE_FILE, {
      userWallets:         Object.fromEntries(userWallets),
      userStats:           Object.fromEntries(userStats),
      userDailyStreak:     Object.fromEntries(userDailyStreak),
      referralCodes:       Object.fromEntries(referralCodes),
      userReferrals:       Object.fromEntries(userReferrals),
      jackpotAmountSOL,
      jackpotHistory,
      lastJackpotWin,
      pollMessageId,
      pollChatId,
      leaderboardMessageId,
      leaderboardChatId,
      currentPoll,
      openPrice,
      tournamentActive,
      tournamentEndTime,
      lastSettledHour,
    });
  } catch (e) { log.error("saveState:", e.message); }
}

function savePhantomSessions() {
  try {
    const data = {};
    for (const [k, v] of phantomSessions.entries())    data["s_" + k] = v;
    for (const [k, v] of pendingPhantomBets.entries()) data["b_" + k] = v;
    atomicWrite(SESSIONS_FILE, data);
  } catch (e) { log.error("savePhantomSessions:", e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s.userWallets)     Object.entries(s.userWallets).forEach(([k,v])     => userWallets.set(k,v));
    if (s.userStats)       Object.entries(s.userStats).forEach(([k,v])       => userStats.set(k,v));
    if (s.userDailyStreak) Object.entries(s.userDailyStreak).forEach(([k,v]) => userDailyStreak.set(k,v));
    if (s.referralCodes)   Object.entries(s.referralCodes).forEach(([k,v])   => referralCodes.set(k,v));
    if (s.userReferrals)   Object.entries(s.userReferrals).forEach(([k,v])   => userReferrals.set(k,v));
    if (s.jackpotAmountSOL    != null) jackpotAmountSOL     = s.jackpotAmountSOL;
    if (s.jackpotHistory)              jackpotHistory       = s.jackpotHistory;
    if (s.lastJackpotWin)              lastJackpotWin       = s.lastJackpotWin;
    if (s.pollMessageId)               pollMessageId        = s.pollMessageId;
    if (s.pollChatId)                  pollChatId           = s.pollChatId;
    if (s.leaderboardMessageId)        leaderboardMessageId = s.leaderboardMessageId;
    if (s.leaderboardChatId)           leaderboardChatId    = s.leaderboardChatId;
    if (s.openPrice)                   openPrice            = s.openPrice;
    if (s.tournamentActive != null)    tournamentActive     = s.tournamentActive;
    if (s.tournamentEndTime)           tournamentEndTime    = s.tournamentEndTime;
    if (s.lastSettledHour)             lastSettledHour      = s.lastSettledHour;
    if (s.currentPoll && s.currentPoll.endTime > Date.now()) currentPoll = s.currentPoll;
    log.ok("State loaded");
  } catch (e) { log.warn("loadState (fresh start):", e.message); }
}

function loadPhantomSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const now  = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (now - (v.createdAt || 0) > 10 * 60_000) continue;
      if (k.startsWith("s_"))      phantomSessions.set(k.slice(2), v);
      else if (k.startsWith("b_")) pendingPhantomBets.set(k.slice(2), v);
    }
    log.ok("Sessions loaded: " + phantomSessions.size + " phantom, " + pendingPhantomBets.size + " bets");
  } catch (e) { log.warn("loadPhantomSessions:", e.message); }
}

// ─────────────────────────────────────────────────────────────
// IN-MEMORY STATE
// ─────────────────────────────────────────────────────────────

let currentPrice    = 0;
let openPrice       = 0;
let priceUpdatedAt  = 0;
let priceSource     = "none";
let bettingPaused   = false;
let lastSettledHour = "";

let currentPoll = {
  pot: 0, stakes: [], startTime: Date.now(),
  endTime: Date.now() + 3_600_000, totalBets: 0,
};

const userWallets        = new Map();
const phantomSessions    = new Map();
const pendingPhantomBets = new Map();
const pendingAmountInput = new Map();
const pendingManualBets  = new Map();
const processedTxSigs    = new Set();
const userStats          = new Map();
const userDailyStreak    = new Map();
const referralCodes      = new Map();
const userReferrals      = new Map();
const rateLimitMap       = new Map();
const voteActionCooldown = new Map();
const tournamentLB       = new Map();

let jackpotAmountSOL     = 0;
let jackpotHistory       = [];
let lastJackpotWin       = null;
let pollMessageId        = null;
let pollChatId           = null;
let leaderboardMessageId = null;
let leaderboardChatId    = null;
let tournamentActive     = false;
let tournamentEndTime    = 0;
let settlementLock       = false;
let botUsername          = "";

const ACHIEVEMENTS = {
  FIRST_BET:     { name: "First Bet",        xp: 10   },
  HOT_STREAK_5:  { name: "5-Win Streak",     xp: 50   },
  HOT_STREAK_10: { name: "10-Win Streak",    xp: 200  },
  WHALE:         { name: "Whale (10+ SOL)",  xp: 500  },
  JACKPOT:       { name: "Jackpot Winner",   xp: 1000 },
};

// ─────────────────────────────────────────────────────────────
// PRICE SYSTEM
// ─────────────────────────────────────────────────────────────

// All price sources call this one function
function applyPrice(price, source) {
  if (!price || price <= 0) return false;
  currentPrice   = price;
  priceUpdatedAt = Date.now();
  priceSource    = source;
  bettingPaused  = false;
  // Save every real price to disk so LKGP is always current
  if (source !== "lkgp") saveLKGP(price);
  return true;
}

// ── Source 1: Kraken WebSocket v2 ──

let ws               = null;
let wsReconnectDelay = 2_000;
let wsPingTimer      = null;

function connectKrakenWS() {
  if (ws) { try { ws.removeAllListeners(); ws.terminate(); } catch (_) {} ws = null; }
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }

  try { ws = new WebSocket("wss://ws.kraken.com/v2"); }
  catch (e) { log.error("Kraken WS create:", e.message); scheduleWsReconnect(); return; }

  ws.on("open", () => {
    log.ok("Kraken WS v2 connected");
    wsReconnectDelay = 2_000;
    ws.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: ["SOL/USD"] },
    }));
    wsPingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ method: "ping" }));
    }, 20_000);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // v2 format: { channel:"ticker", data:[{ symbol:"SOL/USD", last:142.5 }] }
      if (msg.channel === "ticker" && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          if (t.symbol === "SOL/USD" && t.last)
            applyPrice(parseFloat(t.last), "kraken_ws");
        }
      }
    } catch (_) {}
  });

  ws.on("error",  (e) => log.error("Kraken WS:", e.message));
  ws.on("close",  (code) => {
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    log.warn("Kraken WS closed [" + code + "] reconnect in " + wsReconnectDelay + "ms");
    scheduleWsReconnect();
  });
}

function scheduleWsReconnect() {
  setTimeout(connectKrakenWS, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000);
}

// ── Source 2: Pyth Network on-chain ──
//
// Reads SOL/USD price account data directly from Solana.
// Uses the bot's existing RPC connection. No HTTP, no IP blocking possible.
//
// Pyth v2 price account binary layout:
//   offset  0: magic u32     must equal 0xa1b2c3d4
//   offset 20: exponent i32  e.g. -8 means multiply by 10^-8
//   offset 208: price i64    raw integer price
//   offset 224: status u32   1 = trading (price is valid and live)

async function fetchPythPrice() {
  try {
    const info = await connection.getAccountInfo(new PublicKey(PYTH_SOL_USD), "confirmed");
    if (!info || !info.data || info.data.length < 240) return null;

    const buf = Buffer.from(info.data);

    // Validate magic number
    if (buf.readUInt32LE(0) !== 0xa1b2c3d4) {
      log.warn("Pyth: wrong magic number");
      return null;
    }

    const exponent = buf.readInt32LE(20);
    const priceRaw = buf.readBigInt64LE(208);
    const status   = buf.readUInt32LE(224);

    // Status 1 = Trading. Any other value means price is not currently valid.
    if (status !== 1) {
      log.warn("Pyth: status " + status + " (not trading)");
      return null;
    }

    const price = Number(priceRaw) * Math.pow(10, exponent);
    return price > 0 ? price : null;
  } catch (e) {
    log.warn("fetchPythPrice: " + e.message);
    return null;
  }
}

// ── Source 3: Kraken REST ──

function fetchKrakenREST() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
      { timeout: 8_000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(parseFloat(JSON.parse(raw)?.result?.SOLUSD?.c?.[0]) || null); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Source 4: Binance REST ──

function fetchBinanceREST() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
      { timeout: 8_000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(parseFloat(JSON.parse(raw)?.price) || null); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Source 5: CoinGecko REST ──

function fetchCoinGeckoREST() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: 8_000, headers: { Accept: "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(parseFloat(JSON.parse(raw)?.solana?.usd) || null); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * refreshPrice()
 * Runs every 15 seconds via setInterval.
 * If Kraken WS is delivering fresh prices it returns immediately.
 * Otherwise works through the fallback chain until it finds a price.
 */
async function refreshPrice() {
  // WS is fresh — no work needed
  if (priceSource === "kraken_ws" && Date.now() - priceUpdatedAt < 30_000) return;

  const pyth = await fetchPythPrice();
  if (applyPrice(pyth, "pyth")) return;

  const kraken = await fetchKrakenREST();
  if (applyPrice(kraken, "kraken_rest")) return;

  const binance = await fetchBinanceREST();
  if (applyPrice(binance, "binance")) return;

  const gecko = await fetchCoinGeckoREST();
  if (applyPrice(gecko, "coingecko")) return;

  const lkgp = loadLKGP();
  if (lkgp && lkgp.price > 0) {
    const ageMin = Math.floor((Date.now() - lkgp.savedAt) / 60_000);
    log.warn("All live sources failed - using LKGP $" + lkgp.price.toFixed(4) + " (" + ageMin + "m old)");
    applyPrice(lkgp.price, "lkgp");
    return;
  }

  log.error("ALL price sources failed - betting paused");
  bettingPaused = true;
}

setInterval(refreshPrice, 15_000);

// Self-ping to keep Render free tier alive
function selfPing() {
  try {
    const u = new URL(APP_URL + "/health");
    const req = https.get({ hostname: u.hostname, path: u.pathname, timeout: 5_000 }, (res) => res.resume());
    req.on("error",   () => {});
    req.on("timeout", () => req.destroy());
  } catch (_) {}
}
setInterval(selfPing, 10 * 60_000);

// ─────────────────────────────────────────────────────────────
// PHANTOM WALLET
// Correct Universal Link format, no dapp_key
// Phantom returns: publicKey (connect) / signature (tx)
// Sessions persisted to disk
// ─────────────────────────────────────────────────────────────

function newSessionId() { return crypto.randomBytes(16).toString("hex"); }

function createSession(userId, type) {
  const id = newSessionId();
  phantomSessions.set(id, { userId, type, createdAt: Date.now() });
  savePhantomSessions();
  setTimeout(() => { phantomSessions.delete(id); savePhantomSessions(); }, 10 * 60_000);
  return id;
}

function getSession(id) {
  const s = phantomSessions.get(id);
  if (!s || Date.now() - s.createdAt > 10 * 60_000) { phantomSessions.delete(id); return null; }
  return s;
}

function phantomConnectUrl(userId) {
  const sid      = createSession(userId, "connect");
  const redirect = APP_URL + "/phantom/callback?session=" + sid;
  const params   = new URLSearchParams({ app_url: APP_URL, redirect_link: redirect, cluster: "mainnet-beta" });
  return { sessionId: sid, url: "https://phantom.app/ul/v1/connect?" + params.toString() };
}

async function phantomTxUrl(sessionId, fromAddress, lamports) {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(fromAddress),
        toPubkey:   botWallet.publicKey,
        lamports:   Math.floor(lamports),
      })
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = new PublicKey(fromAddress);
    const encoded  = bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const redirect = APP_URL + "/phantom/callback?session=" + sessionId;
    const params   = new URLSearchParams({ transaction: encoded, redirect_link: redirect, cluster: "mainnet-beta" });
    return "https://phantom.app/ul/v1/signAndSendTransaction?" + params.toString();
  } catch (e) { log.error("phantomTxUrl:", e.message); return null; }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const isValidAddr = (a) => { try { new PublicKey(a); return true; } catch { return false; } };

async function getBalance(addr) {
  try { return (await connection.getBalance(new PublicKey(addr))) / LAMPORTS_PER_SOL; }
  catch { return 0; }
}

function validateStake(input) {
  const v = parseFloat(String(input).trim().replace(",", "."));
  if (isNaN(v))      return { ok: false, err: "Enter a valid number" };
  if (v < MIN_STAKE) return { ok: false, err: "Min " + MIN_STAKE + " SOL" };
  if (v > MAX_STAKE) return { ok: false, err: "Max " + MAX_STAKE + " SOL" };
  return { ok: true, amount: Math.round(v * 1e6) / 1e6 };
}

function priceStr() {
  if (bettingPaused)  return "Unavailable";
  if (!currentPrice)  return "Loading...";
  const ageS = Math.floor((Date.now() - priceUpdatedAt) / 1000);
  let tag = "";
  if      (priceSource === "pyth")        tag = " [Pyth]";
  else if (priceSource === "lkgp")        tag = " [last known, " + Math.floor(ageS / 60) + "m ago]";
  else if (priceSource !== "kraken_ws" && priceSource !== "kraken_rest") tag = " [" + priceSource + "]";
  return "$" + currentPrice.toFixed(4) + tag + (ageS > 120 ? " WARNING" : "");
}

function timeLeft() {
  const ms = currentPoll.endTime - Date.now();
  if (ms <= 0) return "Settling...";
  return Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s";
}

function currentHourKey() { return new Date().toISOString().slice(0, 13); }
function getWallet(uid)    { return userWallets.get(uid) || null; }
function refCode(uid)      { return Buffer.from(uid).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6); }

function ensureStats(uid, username) {
  if (!userStats.has(uid))
    userStats.set(uid, { username, totalBets: 0, totalWon: 0, totalStaked: 0,
      winStreak: 0, bestStreak: 0, xp: 0, badges: [] });
  const s = userStats.get(uid);
  s.username = username;
  return s;
}

function award(uid, key) {
  const s = userStats.get(uid);
  if (!s || s.badges.includes(key)) return;
  s.badges.push(key);
  s.xp += ACHIEVEMENTS[key]?.xp || 0;
}

// Streak multipliers used as weights — total payouts can never exceed the pot
function streakMultiplier(uid) {
  const s = userStats.get(uid);
  if (!s) return 1;
  if (s.winStreak >= 10) return 2.0;
  if (s.winStreak >= 5)  return 1.5;
  return 1.0;
}

// ─────────────────────────────────────────────────────────────
// JACKPOT
// ─────────────────────────────────────────────────────────────

function addJackpot(sol) { jackpotAmountSOL += sol; }

async function tryJackpot(uid, username) {
  if (jackpotAmountSOL < 0.1) return null;
  if (Math.random() >= (tournamentActive ? 0.002 : 0.001)) return null;
  const won        = jackpotAmountSOL;
  jackpotAmountSOL = 0;
  jackpotHistory.unshift({ uid, username, amount: won, ts: Date.now() });
  if (jackpotHistory.length > 10) jackpotHistory.pop();
  lastJackpotWin = { uid, username, amount: won, ts: Date.now() };
  return won;
}

// ─────────────────────────────────────────────────────────────
// DAILY REWARDS
// ─────────────────────────────────────────────────────────────

async function claimDaily(uid) {
  const now   = Date.now();
  const entry = userDailyStreak.get(uid) || { streak: 0, lastClaim: 0 };
  const hrs   = (now - entry.lastClaim) / 3_600_000;
  if (hrs < 24)  return { ok: false, hoursLeft: 24 - hrs };
  if (hrs > 48)  entry.streak = 0;
  entry.streak    = Math.min(entry.streak + 1, DAILY_REWARDS.length);
  entry.lastClaim = now;
  userDailyStreak.set(uid, entry);
  return { ok: true, reward: DAILY_REWARDS[entry.streak - 1], streak: entry.streak };
}

// ─────────────────────────────────────────────────────────────
// TOURNAMENT
// ─────────────────────────────────────────────────────────────

function startTournament(hours) {
  hours             = hours || 24;
  tournamentActive  = true;
  tournamentEndTime = Date.now() + hours * 3_600_000;
  tournamentLB.clear();
  saveState();
  log.ok("Tournament started: " + hours + "h");
}

async function endTournament() {
  tournamentActive = false;
  const top3 = [...tournamentLB.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  let msg = "TOURNAMENT ENDED!\n\nTop Winners:\n";
  top3.forEach(([uid, won], i) => {
    msg += (i + 1) + ". " + (userStats.get(uid)?.username || "?") + " - " + won.toFixed(4) + " SOL\n";
  });
  await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, msg).catch(() => {});
  tournamentLB.clear();
  saveState();
}

// ─────────────────────────────────────────────────────────────
// PAYOUT
// ─────────────────────────────────────────────────────────────

async function sendPayout(toAddr, amountSOL, label, retries) {
  retries = retries || 3;
  const toPub   = new PublicKey(toAddr);
  const fromPub = botWallet.publicKey;
  for (let i = 1; i <= retries; i++) {
    try {
      const bal  = await connection.getBalance(fromPub);
      const need = Math.ceil(amountSOL * LAMPORTS_PER_SOL) + 5_000;
      if (bal < need) {
        for (const id of ADMIN_IDS)
          await bot.telegram.sendMessage(id,
            "Bot wallet low!\nNeed: " + amountSOL.toFixed(6) + " SOL\n" +
            "Have: " + (bal / LAMPORTS_PER_SOL).toFixed(6) + " SOL\n" + label
          ).catch(() => {});
        return null;
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromPub, toPubkey: toPub,
          lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL),
        })
      );
      tx.recentBlockhash = blockhash; tx.feePayer = fromPub; tx.sign(botWallet);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      log.ok("Payout " + amountSOL.toFixed(6) + " -> " + toAddr.slice(0,8) + "... [" + label + "]");
      return sig;
    } catch (e) {
      log.error("sendPayout attempt " + i + "/" + retries + ": " + e.message);
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ON-CHAIN PAYMENT VERIFICATION
// Matches by sender address + expected amount (plain SOL transfers
// have no log messages so the old memo approach never worked)
// ─────────────────────────────────────────────────────────────

async function checkOnChainPayment(uid, expectedSOL, createdAt) {
  try {
    const senderAddr = getWallet(uid)?.address;
    const cutoffMs   = createdAt - 30_000;
    const sigs       = await connection.getSignaturesForAddress(botWallet.publicKey, { limit: 50 });

    for (const info of sigs) {
      if (processedTxSigs.has(info.signature) || info.err) continue;
      if (info.blockTime && info.blockTime * 1000 < cutoffMs) break;

      const tx = await connection.getParsedTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      const keys   = tx.transaction.message.accountKeys;
      const botIdx = keys.findIndex(k => k.pubkey.toString() === botWallet.publicKey.toString());
      if (botIdx === -1) continue;

      const received = (tx.meta.postBalances[botIdx] - tx.meta.preBalances[botIdx]) / LAMPORTS_PER_SOL;
      if (received <= 0) continue;

      // Match expected amount within 0.001 SOL tolerance
      const expectedBotAmt = expectedSOL * (POT_PCT + JACKPOT_PCT);
      if (Math.abs(received - expectedBotAmt) > 0.001) continue;

      // Verify the known sender was part of this transaction
      if (senderAddr && !keys.some(k => k.pubkey.toString() === senderAddr)) continue;

      processedTxSigs.add(info.signature);
      return { signature: info.signature, amount: expectedSOL };
    }
    return null;
  } catch (e) {
    log.error("checkOnChainPayment: " + e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// BET CONFIRMATION
// ─────────────────────────────────────────────────────────────

async function confirmBet(uid, username, amount, choice, signature, chatId) {
  const potAmt     = amount * POT_PCT;
  const jackpotAmt = amount * JACKPOT_PCT;

  currentPoll.pot += potAmt;
  currentPoll.stakes.push({ uid, username, choice, amount: potAmt, ts: Date.now(), signature });
  currentPoll.totalBets++;
  addJackpot(jackpotAmt);

  const stats = ensureStats(uid, username);
  stats.totalBets++;
  stats.totalStaked += amount;
  stats.xp += 10;
  if (stats.totalBets === 1) award(uid, "FIRST_BET");
  if (amount >= 10)          award(uid, "WHALE");
  if (tournamentActive)      tournamentLB.set(uid, (tournamentLB.get(uid) || 0) + potAmt);

  const jpWin = await tryJackpot(uid, username);
  if (jpWin) {
    award(uid, "JACKPOT");
    const w = getWallet(uid);
    if (w) await sendPayout(w.address, jpWin, "Jackpot");
    await bot.telegram.sendMessage(chatId, "JACKPOT! You won " + jpWin.toFixed(4) + " SOL!").catch(() => {});
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, "JACKPOT!\n" + username + " won " + jpWin.toFixed(4) + " SOL!").catch(() => {});
  }

  await bot.telegram.sendMessage(chatId,
    choice.toUpperCase() + " Bet Confirmed!\n\n" +
    "Choice: " + choice.toUpperCase() + "\n" +
    "Amount: " + amount.toFixed(6) + " SOL\n" +
    "TX: " + signature.slice(0, 8) + "..." + signature.slice(-8)
  ).catch(() => {});

  await bot.telegram.sendMessage(LIVE_CHANNEL,
    "New Bet!\n" + username + "\n" +
    amount.toFixed(4) + " SOL -> " + choice.toUpperCase() + "\n" +
    "Pot: " + currentPoll.pot.toFixed(4) + " SOL"
  ).catch(() => {});

  saveState();
  await updatePoll();
}

// ─────────────────────────────────────────────────────────────
// MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────

function buildPoll() {
  const sum = function(ch) { return currentPoll.stakes.filter(function(s) { return s.choice === ch; }).reduce(function(a,s) { return a + s.amount; }, 0); };
  const cnt = function(ch) { return currentPoll.stakes.filter(function(s) { return s.choice === ch; }).length; };

  let msg = "*DEGEN ECHO HOURLY POLL*\n\n";
  msg += "SOL Price: *" + priceStr() + "*\n";
  msg += "Time Left: *" + timeLeft() + "*\n";
  if (bettingPaused) msg += "\n*BETTING PAUSED - price feed recovering*\n";
  msg += "\n";

  if (!currentPoll.stakes.length) {
    msg += "_No stakes yet - be first!_\n\n";
  } else {
    msg += "Pot: *" + currentPoll.pot.toFixed(6) + " SOL*\n";
    msg += "PUMP: " + sum("pump").toFixed(6) + " SOL (" + cnt("pump") + ")\n";
    msg += "DUMP: " + sum("dump").toFixed(6) + " SOL (" + cnt("dump") + ")\n";
    msg += "FLAT: " + sum("stagnate").toFixed(6) + " SOL (" + cnt("stagnate") + ")\n\n";
  }

  msg += "Jackpot: *" + jackpotAmountSOL.toFixed(4) + " SOL*\n";
  msg += "Min: " + MIN_STAKE + " SOL | 19% rake / 80% pot / 1% jackpot";
  if (tournamentActive) msg += "\n*TOURNAMENT ACTIVE - double jackpot chance!*";
  if (priceSource === "lkgp") msg += "\n_Using last known price - live feed recovering_";
  return msg;
}

const pollKb = function() {
  return {
    inline_keyboard: [[
      { text: "PUMP", callback_data: "vote_pump"      },
      { text: "DUMP", callback_data: "vote_dump"      },
      { text: "FLAT", callback_data: "vote_stagnate"  },
    ]],
  };
};

function buildLeaderboard() {
  if (!userStats.size) return "*LEADERBOARD*\n\n_No bets yet!_";
  const top    = [...userStats.entries()].sort(function(a,b) { return (b[1].totalWon||0)-(a[1].totalWon||0); }).slice(0, 10);
  const medals = ["1.", "2.", "3."];
  let msg = "*DEGEN ECHO LEADERBOARD*\n\n";
  top.forEach(function([, s], i) {
    const wr = s.totalBets ? ((s.totalWon / Math.max(s.totalStaked, 0.0001)) * 100).toFixed(1) : "0.0";
    msg += (medals[i] || (i + 1) + ".") + " *" + s.username + "*\n";
    msg += "   Won: " + (s.totalWon || 0).toFixed(4) + " SOL | Win rate: " + wr + "%\n";
    msg += "   Bets: " + s.totalBets + " | Streak: " + s.winStreak + "\n";
    if (s.badges && s.badges.length) msg += "   " + s.badges.map(function(b) { return ACHIEVEMENTS[b]?.name || b; }).join(", ") + "\n";
    msg += "\n";
  });
  msg += "Jackpot: *" + jackpotAmountSOL.toFixed(4) + " SOL*";
  if (tournamentActive) msg += "\n*TOURNAMENT ACTIVE*";
  return msg;
}

// ─────────────────────────────────────────────────────────────
// AUTO-UPDATE POLL + LEADERBOARD
// ─────────────────────────────────────────────────────────────

async function updatePoll() {
  try {
    const text = buildPoll(), rm = pollKb();
    if (pollMessageId && pollChatId) {
      try {
        await bot.telegram.editMessageText(pollChatId, pollMessageId, undefined, text, { parse_mode: "Markdown", reply_markup: rm });
        return;
      } catch (_) { pollMessageId = null; pollChatId = null; }
    }
    try {
      const m = await bot.telegram.sendMessage(LIVE_CHANNEL, text, { parse_mode: "Markdown", reply_markup: rm });
      pollMessageId = m.message_id; pollChatId = m.chat.id;
      await bot.telegram.pinChatMessage(LIVE_CHANNEL, m.message_id).catch(() => {});
    } catch (e) {
      log.error("Live channel fallback to community: " + e.message);
      const m = await bot.telegram.sendMessage(COMMUNITY_GROUP, text, { parse_mode: "Markdown", reply_markup: rm });
      pollMessageId = m.message_id; pollChatId = m.chat.id;
    }
    saveState();
  } catch (e) { log.error("updatePoll: " + e.message); }
}

async function updateLeaderboard() {
  try {
    const text = buildLeaderboard();
    if (leaderboardMessageId && leaderboardChatId) {
      try {
        await bot.telegram.editMessageText(leaderboardChatId, leaderboardMessageId, undefined, text, { parse_mode: "Markdown" });
        return;
      } catch (_) { leaderboardMessageId = null; leaderboardChatId = null; }
    }
    const m = await bot.telegram.sendMessage(COMMUNITY_GROUP, text, { parse_mode: "Markdown" });
    leaderboardMessageId = m.message_id; leaderboardChatId = m.chat.id;
    await bot.telegram.pinChatMessage(COMMUNITY_GROUP, m.message_id).catch(() => {});
    saveState();
  } catch (e) { log.error("updateLeaderboard: " + e.message); }
}

// ─────────────────────────────────────────────────────────────
// HOURLY SETTLEMENT
// ─────────────────────────────────────────────────────────────

async function settleHour() {
  const hourKey = currentHourKey();
  if (lastSettledHour === hourKey) { log.warn("Already settled hour " + hourKey + " - skip"); return; }
  if (settlementLock)              { log.warn("Settlement lock active - skip"); return; }

  if (bettingPaused || !currentPrice) {
    log.warn("Price unavailable - skipping settlement");
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL,
      "Settlement skipped - price feed unavailable. Bets carry over to next hour."
    ).catch(() => {});
    return;
  }

  settlementLock = true;
  try {
    log.info("Settling hour: " + hourKey);

    if (currentPoll.stakes.length < 2) {
      await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, "Not enough bets this hour.").catch(() => {});
    } else {
      const winChoice =
        currentPrice > openPrice * 1.001 ? "pump"     :
        currentPrice < openPrice * 0.999 ? "dump"     : "stagnate";

      const winners = currentPoll.stakes.filter(function(s) { return s.choice === winChoice; });
      const losers  = currentPoll.stakes.filter(function(s) { return s.choice !== winChoice; });
      const totalPot = currentPoll.pot;

      // Weighted share: guarantees sum(payouts) === totalPot even with streak multipliers
      const weightedTotal = winners.reduce(function(sum, w) { return sum + w.amount * streakMultiplier(w.uid); }, 0);

      let paidCount = 0, paidTotal = 0;

      for (const w of winners) {
        const wallet = getWallet(w.uid);
        if (!wallet) continue;
        const mult   = streakMultiplier(w.uid);
        const payout = parseFloat((totalPot * (w.amount * mult / weightedTotal)).toFixed(6));
        const sig    = await sendPayout(wallet.address, payout, "Win - " + winChoice);
        if (sig) {
          paidCount++; paidTotal += payout;
          const s = userStats.get(w.uid);
          if (s) {
            s.totalWon  += payout;
            s.winStreak  = (s.winStreak || 0) + 1;
            if (s.winStreak > (s.bestStreak || 0)) s.bestStreak = s.winStreak;
            s.xp        += 50;
            if (s.winStreak >= 5)  award(w.uid, "HOT_STREAK_5");
            if (s.winStreak >= 10) award(w.uid, "HOT_STREAK_10");
            if (tournamentActive)  tournamentLB.set(w.uid, (tournamentLB.get(w.uid) || 0) + payout);
          }
          await bot.telegram.sendMessage(w.uid,
            "YOU WON!\n\nSOL went " + winChoice.toUpperCase() + "\n" +
            "+" + payout.toFixed(6) + " SOL paid\n" +
            "TX: " + sig.slice(0, 8) + "..." + sig.slice(-8)
          ).catch(() => {});
        }
      }

      for (const l of losers) { const s = userStats.get(l.uid); if (s) s.winStreak = 0; }

      await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL,
        "Hourly Results\n\nWinner: " + winChoice.toUpperCase() + "\n" +
        "Open: $" + openPrice.toFixed(4) + " -> Close: $" + currentPrice.toFixed(4) + "\n" +
        "Pot: " + totalPot.toFixed(6) + " SOL | Winners: " + paidCount + " | Paid: " + paidTotal.toFixed(6) + " SOL\n" +
        "Jackpot: " + jackpotAmountSOL.toFixed(4) + " SOL | Source: " + priceSource
      ).catch(() => {});
    }

    lastSettledHour = hourKey;
    openPrice       = currentPrice;
    pollMessageId   = null; pollChatId = null;
    currentPoll     = { pot: 0, stakes: [], startTime: Date.now(), endTime: Date.now() + 3_600_000, totalBets: 0 };

    await updatePoll();
    await updateLeaderboard();
    saveState();

    if (tournamentActive && Date.now() >= tournamentEndTime) await endTournament();
  } finally {
    settlementLock = false;
  }
}

// ─────────────────────────────────────────────────────────────
// BOT SETUP
// ─────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);
bot.catch(function(e, ctx) { log.error("Bot error: " + e.message + " " + (ctx?.updateType || "")); });

bot.use(function(ctx, next) {
  const uid = ctx.from?.id?.toString();
  if (!uid) return next();
  const now = Date.now();
  const e   = rateLimitMap.get(uid) || { count: 0, start: now };
  if (now - e.start > RATE_WINDOW_MS) { e.count = 1; e.start = now; } else e.count++;
  rateLimitMap.set(uid, e);
  if (e.count > RATE_LIMIT) return ctx.reply("Slow down!").catch(() => {});
  return next();
});

// ─────────────────────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────────────────────

bot.start(async function(ctx) {
  const uid      = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  const name     = ctx.from.first_name || "Degen";
  const args     = ctx.message.text.split(" ");

  if (args[1] && args[1].startsWith("ref_")) {
    const code  = args[1].slice(4);
    const refId = referralCodes.get(code);
    if (refId && refId !== uid && !userReferrals.has(uid)) {
      userReferrals.set(uid, { refBy: refId });
      const rs = userStats.get(refId);
      if (rs) rs.xp += 50;
      await bot.telegram.sendMessage(refId, "Someone joined via your referral! +50 XP").catch(() => {});
      saveState();
    }
  }

  const w       = getWallet(uid);
  const wStatus = w
    ? "Wallet: " + w.address.slice(0, 6) + "..." + w.address.slice(-4) + " (" + w.via + ")"
    : "No wallet connected";

  ctx.reply(
    "Welcome to Degen Echo, " + name + "!\n\n" +
    wStatus + "\n\n" +
    "Connect wallet:\n/connect - Phantom\n/register <address> - Manual\n\n" +
    "Commands:\n/poll /balance /leaderboard /jackpot /daily /ref /stats /achievements /tournament /cancel /help",
    { parse_mode: "Markdown" }
  );
});

bot.command("connect", async function(ctx) {
  const result = phantomConnectUrl(ctx.from.id.toString());
  ctx.reply(
    "*Connect Phantom Wallet*\n\nTap below. Phantom redirects back automatically.",
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Connect Phantom", url: result.url }]] } }
  );
});

bot.command("register", async function(ctx) {
  const uid  = ctx.from.id.toString();
  const user = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.trim().split(/\s+/);
  if (args.length !== 2) return ctx.reply("Usage: /register <solana_address>");
  const addr = args[1].trim();
  if (!isValidAddr(addr)) return ctx.reply("Invalid Solana address.");
  if (addr === botWallet.publicKey.toString() || addr === RAKE_WALLET)
    return ctx.reply("Cannot register a system wallet.");
  const bal = await getBalance(addr);
  userWallets.set(uid, { address: addr, username: user, registeredAt: Date.now(), via: "manual" });
  saveState();
  ctx.reply("Wallet Registered!\n\n" + addr + "\nBalance: " + bal.toFixed(6) + " SOL");
});

bot.command("balance", async function(ctx) {
  const w = getWallet(ctx.from.id.toString());
  if (!w) return ctx.reply("No wallet. Use /connect or /register first.");
  const bal = await getBalance(w.address);
  ctx.reply("Balance\n\n" + w.address + "\n" + bal.toFixed(6) + " SOL");
});

bot.command("poll",        function(ctx) { ctx.reply(buildPoll(), { parse_mode: "Markdown", reply_markup: pollKb() }); });
bot.command("leaderboard", function(ctx) { ctx.reply(buildLeaderboard(), { parse_mode: "Markdown" }); });

bot.command("jackpot", function(ctx) {
  let msg = "Jackpot: *" + jackpotAmountSOL.toFixed(4) + " SOL*";
  if (lastJackpotWin) {
    const ago = Math.floor((Date.now() - lastJackpotWin.ts) / 60_000);
    msg += "\n\nLast winner: *" + lastJackpotWin.username + "* won *" + lastJackpotWin.amount.toFixed(4) + " SOL* (" + ago + "m ago)";
  }
  ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("daily", async function(ctx) {
  const uid = ctx.from.id.toString();
  const r   = await claimDaily(uid);
  if (!r.ok) return ctx.reply("Next daily in *" + Math.ceil(r.hoursLeft) + "h*", { parse_mode: "Markdown" });
  saveState();
  const w = getWallet(uid);
  if (!w) return ctx.reply("Daily reward: " + r.reward + " SOL earned!\nStreak: " + r.streak + "\n\nRegister a wallet to receive it.");
  await sendPayout(w.address, r.reward, "Daily reward");
  ctx.reply("Daily Claimed!\n\n" + r.reward + " SOL\nStreak: " + r.streak + " day" + (r.streak > 1 ? "s" : ""));
});

bot.command("ref", function(ctx) {
  const uid  = ctx.from.id.toString();
  const code = refCode(uid);
  referralCodes.set(code, uid);
  ctx.reply(
    "*Referral Link*\n\nhttps://t.me/" + botUsername + "?start=ref_" + code + "\n\nEarn *50 XP* per signup!",
    { parse_mode: "Markdown" }
  );
});

bot.command("stats", function(ctx) {
  const s = userStats.get(ctx.from.id.toString());
  if (!s) return ctx.reply("No stats yet. Place a bet first!");
  const wr = s.totalBets ? ((s.totalWon / Math.max(s.totalStaked, 0.0001)) * 100).toFixed(1) : "0.0";
  ctx.reply(
    "*Your Stats*\n\nBets: " + s.totalBets + "\nStaked: " + s.totalStaked.toFixed(4) + " SOL\n" +
    "Won: " + s.totalWon.toFixed(4) + " SOL\nWin rate: " + wr + "%\n" +
    "Streak: " + s.winStreak + " (Best: " + s.bestStreak + ")\nXP: " + s.xp,
    { parse_mode: "Markdown" }
  );
});

bot.command("achievements", function(ctx) {
  const s = userStats.get(ctx.from.id.toString());
  if (!s || !s.badges || !s.badges.length) return ctx.reply("No achievements yet. Start betting!");
  let msg = "*Achievements*\n\n";
  s.badges.forEach(function(b) { if (ACHIEVEMENTS[b]) msg += ACHIEVEMENTS[b].name + " (+" + ACHIEVEMENTS[b].xp + " XP)\n"; });
  ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("tournament", function(ctx) {
  if (!tournamentActive) return ctx.reply("No tournament active.");
  const ms = tournamentEndTime - Date.now();
  ctx.reply(
    "*Tournament Active!*\n\nTime left: *" + Math.floor(ms / 3_600_000) + "h " +
    Math.floor((ms % 3_600_000) / 60_000) + "m*\nDouble jackpot chance!\nTop 3 win prizes.",
    { parse_mode: "Markdown" }
  );
});

bot.command("cancel", function(ctx) {
  const uid = ctx.from.id.toString();
  const p   = pendingAmountInput.get(uid);
  if (p) { clearTimeout(p.timeoutHandle); pendingAmountInput.delete(uid); }
  for (const [id, bet] of pendingManualBets.entries()) {
    if (bet.uid === uid) { clearTimeout(bet.timeoutHandle); pendingManualBets.delete(id); }
  }
  ctx.reply("Cancelled.");
});

bot.command("help", function(ctx) {
  ctx.reply(
    "*Commands*\n\n" +
    "/connect - Phantom wallet\n/register <addr> - Manual wallet\n" +
    "/balance - Check balance\n/poll - Current poll\n/leaderboard - Top players\n" +
    "/jackpot - Jackpot status\n/daily - Daily reward\n/ref - Referral link\n" +
    "/stats - Your stats\n/achievements - Your badges\n" +
    "/tournament - Tournament info\n/cancel - Cancel pending bet",
    { parse_mode: "Markdown" }
  );
});

// ── Admin commands ──

bot.command("debug", async function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  const bal      = await getBalance(botWallet.publicKey.toString());
  const priceAge = Math.floor((Date.now() - priceUpdatedAt) / 1000);
  const wsState  = ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][ws.readyState] : "null";
  ctx.reply(
    "*Debug*\n\n" +
    "Price: " + priceStr() + "\n" +
    "Age: " + priceAge + "s | Source: " + priceSource + "\n" +
    "WS: " + wsState + " | Betting paused: " + bettingPaused + "\n" +
    "Bot wallet: " + bal.toFixed(6) + " SOL\n" +
    "Jackpot: " + jackpotAmountSOL.toFixed(4) + " SOL\n" +
    "Poll: " + currentPoll.stakes.length + " bets / " + currentPoll.pot.toFixed(6) + " SOL\n" +
    "Wallets: " + userWallets.size + " | Users: " + userStats.size + "\n" +
    "Pending manual: " + pendingManualBets.size + "\n" +
    "Phantom sessions: " + phantomSessions.size + " | Pending bets: " + pendingPhantomBets.size + "\n" +
    "Processed sigs: " + processedTxSigs.size + "\n" +
    "Tournament: " + (tournamentActive ? "Active" : "Off") + "\n" +
    "Last settled: " + (lastSettledHour || "never") + "\n" +
    "Uptime: " + Math.floor(process.uptime()) + "s",
    { parse_mode: "Markdown" }
  );
});

bot.command("pricetest", async function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  await ctx.reply("Testing all price sources...").catch(() => {});
  const pyth    = await fetchPythPrice();
  const kraken  = await fetchKrakenREST();
  const binance = await fetchBinanceREST();
  const gecko   = await fetchCoinGeckoREST();
  const lkgp    = loadLKGP();
  ctx.reply(
    "*Price Source Test*\n\n" +
    "Pyth on-chain: " + (pyth    ? "$" + pyth.toFixed(4)    : "FAILED") + "\n" +
    "Kraken REST:   " + (kraken  ? "$" + kraken.toFixed(4)  : "FAILED") + "\n" +
    "Binance REST:  " + (binance ? "$" + binance.toFixed(4) : "FAILED") + "\n" +
    "CoinGecko:     " + (gecko   ? "$" + gecko.toFixed(4)   : "FAILED") + "\n" +
    "LKGP (disk):   " + (lkgp ? "$" + lkgp.price.toFixed(4) + " (" + Math.floor((Date.now()-lkgp.savedAt)/60000) + "m ago)" : "none") + "\n\n" +
    "Active: " + priceStr() + "\nSource: " + priceSource,
    { parse_mode: "Markdown" }
  );
});

bot.command("envtest", function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  ctx.reply(
    "*Env*\n\n" +
    "LIVE: " + LIVE_CHANNEL + "\n" +
    "COMMUNITY: " + COMMUNITY_GROUP + "\n" +
    "ANNOUNCEMENTS: " + ANNOUNCEMENTS_CHANNEL + "\n" +
    "APP_URL: " + APP_URL + "\n" +
    "ADMINS: " + JSON.stringify(ADMIN_IDS),
    { parse_mode: "Markdown" }
  );
});

bot.command("channeltest", async function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  const channels = [
    { name: "LIVE", id: LIVE_CHANNEL },
    { name: "COMMUNITY", id: COMMUNITY_GROUP },
    { name: "ANNOUNCEMENTS", id: ANNOUNCEMENTS_CHANNEL },
  ];
  const results = [];
  for (const ch of channels) {
    try {
      const info = await bot.telegram.getChat(ch.id);
      results.push("OK " + ch.name + ": " + info.title);
      await bot.telegram.sendMessage(ch.id, "Test -> " + ch.name);
      results.push("   -> Can post");
    } catch (e) { results.push("FAIL " + ch.name + ": " + e.message); }
  }
  ctx.reply(results.join("\n"));
});

bot.command("chatid", function(ctx) { ctx.reply("Chat ID: " + ctx.chat.id); });

bot.command("settle", async function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  await settleHour();
  ctx.reply("Manual settlement done.");
});

bot.command("starttournament", async function(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  const h = parseInt(ctx.message.text.split(" ")[1]) || 24;
  startTournament(h);
  ctx.reply("Tournament started - " + h + "h");
  await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL,
    "TOURNAMENT STARTED!\n\n" + h + " hours | Double jackpot chance!\nTop 3 win prizes!"
  ).catch(() => {});
});

// ─────────────────────────────────────────────────────────────
// VOTE HANDLER
// ─────────────────────────────────────────────────────────────

bot.action(/^vote_(pump|dump|stagnate)$/, async function(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const uid      = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  const choice   = ctx.match[1];

  const last = voteActionCooldown.get(uid) || 0;
  if (Date.now() - last < VOTE_COOLDOWN_MS) {
    return ctx.answerCbQuery("Wait a moment.").catch(() => {});
  }
  voteActionCooldown.set(uid, Date.now());

  if (bettingPaused)
    return ctx.reply("Betting is paused while price feed recovers. Try again in a moment.").catch(() => {});

  if (pendingAmountInput.has(uid))
    return ctx.reply("You have a pending bet active. Use /cancel first.").catch(() => {});

  const wallet = getWallet(uid);
  if (!wallet) {
    const result = phantomConnectUrl(uid);
    return ctx.reply("Connect a wallet first:", {
      reply_markup: { inline_keyboard: [
        [{ text: "Connect Phantom",  url: result.url }],
        [{ text: "Manual Register",  callback_data: "show_register" }],
      ]},
    });
  }

  const th = setTimeout(function() {
    pendingAmountInput.delete(uid);
    bot.telegram.sendMessage(ctx.chat.id, "Timed out. Try again.").catch(() => {});
  }, PAYMENT_TIMEOUT_MS);

  pendingAmountInput.set(uid, { choice, username, chatId: ctx.chat.id, timeoutHandle: th });
  ctx.reply(choice.toUpperCase() + " selected!\n\nEnter stake amount in SOL (min " + MIN_STAKE + "):");
});

bot.action("show_register", async function(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  ctx.reply("Manual Registration\n\nSend:\n/register YOUR_SOLANA_ADDRESS");
});

// ─────────────────────────────────────────────────────────────
// TEXT HANDLER - stake amount input
// ─────────────────────────────────────────────────────────────

bot.on("text", async function(ctx) {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  const uid     = ctx.from.id.toString();
  const pending = pendingAmountInput.get(uid);
  if (!pending) return;

  const v = validateStake(text);
  if (!v.ok) return ctx.reply("Invalid amount: " + v.err + ". Try again:");

  const amount = v.amount;
  clearTimeout(pending.timeoutHandle);
  pendingAmountInput.delete(uid);

  if (bettingPaused)
    return ctx.reply("Betting is paused - price feed unavailable. Please try again shortly.");

  const wallet = getWallet(uid);
  if (!wallet) return ctx.reply("Wallet not found. Use /connect or /register.");

  const rakeAmt = parseFloat((amount * RAKE_PCT).toFixed(6));
  const botAmt  = parseFloat((amount * (POT_PCT + JACKPOT_PCT)).toFixed(6));

  // Phantom flow
  const sessionId = newSessionId();
  phantomSessions.set(sessionId, { userId: uid, type: "bet", createdAt: Date.now() });
  pendingPhantomBets.set(sessionId, {
    userId: uid, username: pending.username, amount,
    choice: pending.choice, chatId: pending.chatId || ctx.chat.id, createdAt: Date.now(),
  });
  savePhantomSessions();
  setTimeout(function() {
    phantomSessions.delete(sessionId);
    pendingPhantomBets.delete(sessionId);
    savePhantomSessions();
  }, PAYMENT_TIMEOUT_MS);

  let txUrl = null;
  try { txUrl = await phantomTxUrl(sessionId, wallet.address, amount * LAMPORTS_PER_SOL); }
  catch (e) { log.error("phantomTxUrl: " + e.message); }

  // Manual flow
  const betId     = crypto.randomBytes(4).toString("hex").toUpperCase();
  const createdAt = Date.now();
  const expiresAt = createdAt + PAYMENT_TIMEOUT_MS;

  const th = setTimeout(function() {
    pendingManualBets.delete(betId);
    bot.telegram.sendMessage(ctx.chat.id, "Manual payment window closed.").catch(() => {});
  }, PAYMENT_TIMEOUT_MS);

  pendingManualBets.set(betId, {
    uid, username: pending.username, amount, choice: pending.choice,
    chatId: ctx.chat.id, createdAt, expiresAt, timeoutHandle: th,
  });

  // Poll on-chain for manual payment
  (async function() {
    while (pendingManualBets.has(betId) && Date.now() < expiresAt) {
      const result = await checkOnChainPayment(uid, amount, createdAt);
      if (result) {
        pendingManualBets.delete(betId);
        await confirmBet(uid, pending.username, result.amount, pending.choice, result.signature, ctx.chat.id);
        return;
      }
      await new Promise(function(r) { setTimeout(r, BLOCKCHAIN_POLL_MS); });
    }
  })();

  const keyboard = txUrl
    ? { inline_keyboard: [[{ text: "Sign in Phantom", url: txUrl }]] }
    : undefined;

  ctx.reply(
    "Stake Summary\n\n" +
    "Amount: " + amount + " SOL\n" +
    "Choice: " + pending.choice.toUpperCase() + "\n\n" +
    "Option 1 - Phantom (easiest):\n" +
    (txUrl ? "Tap the button below.\n\n" : "(Phantom unavailable - use Option 2)\n\n") +
    "Option 2 - Manual send:\n" +
    "Send " + botAmt + " SOL to:\n" + botWallet.publicKey.toString() + "\n\n" +
    "Also send " + rakeAmt + " SOL to:\n" + RAKE_WALLET + "\n\n" +
    "Bot detects your payment automatically on-chain.\n\n" +
    "5 minutes to complete.",
    { reply_markup: keyboard }
  );
});

// ─────────────────────────────────────────────────────────────
// EXPRESS + PHANTOM CALLBACK
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", function(_, res) { res.send("Degen Echo Bot - Running"); });

app.get("/health", function(_, res) {
  res.json({
    ok:          true,
    uptime:      Math.floor(process.uptime()),
    price:       currentPrice,
    priceSource,
    priceAge:    Math.floor((Date.now() - priceUpdatedAt) / 1000),
    wsState:     ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][ws.readyState] : "null",
    bettingPaused,
    jackpot:     jackpotAmountSOL,
    pot:         currentPoll.pot,
    stakes:      currentPoll.stakes.length,
    users:       userStats.size,
    wallets:     userWallets.size,
    tournament:  tournamentActive,
  });
});

function htmlPage(msg, ok) {
  const color = (ok !== false) ? "#4ade80" : "#f87171";
  return "<!DOCTYPE html><html><head><title>Degen Echo</title>" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<style>*{box-sizing:border-box;margin:0;padding:0}" +
    "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;" +
    "align-items:center;justify-content:center;min-height:100vh;background:#0d0d1a;color:#fff}" +
    ".box{text-align:center;padding:2rem;max-width:380px;background:#1a1a2e;" +
    "border-radius:16px;border:1px solid " + color + "}" +
    "h2{font-size:2rem;margin-bottom:.5rem}" +
    ".s{font-size:1.2rem;margin-top:1rem;color:" + color + ";line-height:1.5}" +
    "small{color:#555;font-size:.8rem;display:block;margin-top:1rem}</style></head>" +
    "<body><div class=\"box\"><h2>Degen Echo</h2>" +
    "<p class=\"s\">" + msg + "</p>" +
    "<small>Close this window and return to Telegram</small></div>" +
    "<script>setTimeout(function(){try{if(window.opener||window.history.length<2)window.close();}catch(e){}},3000);</script>" +
    "</body></html>";
}

app.get("/phantom/callback", async function(req, res) {
  log.info("Phantom callback: " + JSON.stringify(req.query));

  const sessionId = req.query.session;
  // Phantom connect returns publicKey (camelCase), we also accept public_key
  const walletAddr = req.query.publicKey || req.query.public_key;
  // Phantom tx returns signature, we also accept transaction_signature
  const txSig      = req.query.signature || req.query.transaction_signature;
  const errorCode  = req.query.errorCode;
  const errorMsg   = req.query.errorMessage;

  if (errorCode) {
    log.warn("Phantom error: " + errorCode + " " + (errorMsg || ""));
    const s = getSession(sessionId);
    if (s) await bot.telegram.sendMessage(s.userId, "Phantom error: " + (errorMsg || errorCode) + "\n\nTry /connect again.").catch(() => {});
    return res.send(htmlPage("Error: " + (errorMsg || errorCode), false));
  }

  if (walletAddr && sessionId) {
    if (!isValidAddr(walletAddr)) return res.send(htmlPage("Invalid wallet address.", false));
    const s = getSession(sessionId);
    if (!s) return res.send(htmlPage("Session expired. Try /connect again.", false));
    const username = userStats.get(s.userId)?.username || "User";
    userWallets.set(s.userId, { address: walletAddr, username, registeredAt: Date.now(), via: "phantom" });
    phantomSessions.delete(sessionId);
    saveState();
    savePhantomSessions();
    log.ok("Phantom wallet connected: " + walletAddr.slice(0, 8) + "... user " + s.userId);
    await bot.telegram.sendMessage(s.userId,
      "Phantom Connected!\n\n" + walletAddr + "\n\nYou can now bet on the polls!"
    ).catch(() => {});
    return res.send(htmlPage("Wallet connected! Head back to Telegram."));
  }

  if (txSig && sessionId) {
    const bet = pendingPhantomBets.get(sessionId);
    if (bet) {
      pendingPhantomBets.delete(sessionId);
      phantomSessions.delete(sessionId);
      processedTxSigs.add(txSig);
      savePhantomSessions();
      log.ok("Phantom tx confirmed: " + txSig.slice(0, 8) + "... for " + bet.username);
      await confirmBet(bet.userId, bet.username, bet.amount, bet.choice, txSig, bet.chatId || bet.userId);
      return res.send(htmlPage("Bet confirmed! Good luck!"));
    }
    log.warn("Phantom tx received but session missing: " + sessionId);
    return res.send(htmlPage("Transaction received! Check Telegram for confirmation."));
  }

  return res.send(htmlPage("Done! You can close this window."));
});

app.listen(PORT, "0.0.0.0", function() { log.ok("HTTP server on port " + PORT); });

// ─────────────────────────────────────────────────────────────
// CRON JOBS
// ─────────────────────────────────────────────────────────────

cron.schedule("0 * * * *",      settleHour);
cron.schedule("*/30 * * * * *", updatePoll);
cron.schedule("*/5 * * * *",    updateLeaderboard);
cron.schedule("*/5 * * * *",    saveState);
cron.schedule("*/2 * * * *",    savePhantomSessions);
cron.schedule("* * * * *", function() {
  if (tournamentActive && Date.now() >= tournamentEndTime) endTournament();
});
cron.schedule("0 0 * * *", function() {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries())       if (now - v.start > RATE_WINDOW_MS * 2) rateLimitMap.delete(k);
  for (const [k, v] of voteActionCooldown.entries()) if (now - v       > 3_600_000)          voteActionCooldown.delete(k);
  if (processedTxSigs.size > 500) {
    const arr = [...processedTxSigs];
    arr.slice(0, arr.length - 500).forEach(function(s) { processedTxSigs.delete(s); });
  }
  log.info("Daily cleanup done");
});

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────

async function startup() {
  log.info("Starting Degen Echo...");
  loadState();
  loadPhantomSessions();

  // Start Kraken WS
  connectKrakenWS();

  // Fetch initial price through fallback chain immediately
  log.info("Fetching initial SOL price...");

  const pyth = await fetchPythPrice();
  if (applyPrice(pyth, "pyth")) {
    log.ok("Initial price from Pyth: $" + currentPrice.toFixed(4));
  } else {
    const kraken = await fetchKrakenREST();
    if (applyPrice(kraken, "kraken_rest")) {
      log.ok("Initial price from Kraken REST: $" + currentPrice.toFixed(4));
    } else {
      const binance = await fetchBinanceREST();
      if (applyPrice(binance, "binance")) {
        log.ok("Initial price from Binance: $" + currentPrice.toFixed(4));
      } else {
        const gecko = await fetchCoinGeckoREST();
        if (applyPrice(gecko, "coingecko")) {
          log.ok("Initial price from CoinGecko: $" + currentPrice.toFixed(4));
        } else {
          const lkgp = loadLKGP();
          if (lkgp && lkgp.price > 0) {
            applyPrice(lkgp.price, "lkgp");
            log.warn("Initial price from LKGP: $" + currentPrice.toFixed(4));
          } else {
            log.warn("No price at startup - betting paused until price loads");
            bettingPaused = true;
          }
        }
      }
    }
  }

  // Wait briefly for Kraken WS to upgrade the price source
  for (let i = 0; i < 5 && priceSource !== "kraken_ws"; i++) {
    await new Promise(function(r) { setTimeout(r, 1000); });
  }

  if (!openPrice && currentPrice) openPrice = currentPrice;

  log.ok("Price ready: " + priceStr() + " (source: " + priceSource + ")");
  await updatePoll();
  await updateLeaderboard();
  log.ok("Startup complete");
}

process.on("unhandledRejection", function(r) { log.error("Unhandled rejection: " + r); });
process.on("uncaughtException",  function(e) { log.error("Uncaught exception: " + e.message + " " + e.stack); });

bot.launch({ dropPendingUpdates: true })
  .then(async function() {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    log.ok("@" + botUsername + " is LIVE");
    log.ok("Rake wallet: " + RAKE_WALLET);
    log.ok("Bot wallet:  " + botWallet.publicKey.toString());
    await startup();
  })
  .catch(function(e) { log.error("Launch failed: " + e.message); process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, function() {
    log.info("Shutting down...");
    saveState();
    savePhantomSessions();
    bot.stop(sig);
    if (ws) ws.close();
    setTimeout(function() { process.exit(0); }, 2000);
  });
}
