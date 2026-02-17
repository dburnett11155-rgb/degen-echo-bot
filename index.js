"use strict";

/**
 * DEGEN ECHO – ULTIMATE BOT
 * Fully automated: hourly polls, 19% rake, 80% pot, 1% jackpot,
 * daily rewards, referrals, achievements, tournaments,
 * Phantom wallet (mobile + desktop) + manual send fallback.
 * Includes /envtest and /channeltest for easy debugging.
 */

require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  Transaction,
  SystemProgram,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const express = require("express");
const cron = require("node-cron");
const bs58 = require("bs58");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ============================================
// CONFIGURATION – ENVIRONMENT VARIABLES
// ============================================

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "BOT_PRIVATE_KEY",
  "RAKE_WALLET",
  "ADMIN_TELEGRAM_ID",
  "APP_URL",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY;
const RAKE_WALLET = process.env.RAKE_WALLET;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const ADMIN_IDS = [ADMIN_TELEGRAM_ID, "1087968824"].filter(Boolean);
const APP_URL = process.env.APP_URL.replace(/\/$/, "");

// Split configuration
const RAKE_PERCENT = 0.19;      // 19% to your rake wallet
const POT_PERCENT = 0.80;       // 80% to hourly winners
const JACKPOT_PERCENT = 0.01;   // 1% to jackpot (accumulates in bot wallet)

const MIN_STAKE = 0.001;
const MAX_STAKE = 1000;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BLOCKCHAIN_POLL_MS = 6000;           // 6 seconds
const PORT = Number(process.env.PORT) || 3000;

// Telegram channels – you can use usernames (with @) or numeric IDs
// The code will automatically prepend '@' if missing (but numeric IDs are safer)
function normalizeChatId(chat) {
  if (!chat) return chat;
  if (/^-?\d+$/.test(chat)) return chat;               // numeric ID
  return chat.startsWith('@') ? chat : '@' + chat;    // ensure @
}

const LIVE_CHANNEL = normalizeChatId(process.env.LIVE_CHANNEL || "@degenecholive");
const COMMUNITY_GROUP = normalizeChatId(process.env.COMMUNITY_GROUP || "@degenechochat");
const ANNOUNCEMENTS_CHANNEL = normalizeChatId(process.env.ANNOUNCEMENTS_CHANNEL || "@degenechochamber");

const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

// ============================================
// SOLANA SETUP
// ============================================

let connection;
try {
  connection = new Connection(SOLANA_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  console.log("✅ Solana connection established");
} catch (err) {
  console.error("❌ Solana connection failed:", err.message);
  process.exit(1);
}

let botWallet;
try {
  botWallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));
  console.log("✅ Bot wallet loaded:", botWallet.publicKey.toString());
} catch (err) {
  console.error("❌ Bot wallet load failed:", err.message);
  process.exit(1);
}

// ============================================
// LOGGER
// ============================================

const log = {
  info: (...a) => console.log(new Date().toISOString(), "ℹ️ ", ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "⚠️ ", ...a),
  error: (...a) => console.error(new Date().toISOString(), "❌ ", ...a),
  ok: (...a) => console.log(new Date().toISOString(), "✅ ", ...a),
};

// ============================================
// PERSISTENCE (save/load state)
// ============================================

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveState() {
  try {
    ensureDataDir();
    const state = {
      userWallets: Object.fromEntries(userWallets),
      userStats: Object.fromEntries(userStats),
      userDailyStreak: Object.fromEntries(userDailyStreak),
      referralCodes: Object.fromEntries(referralCodes),
      userReferrals: Object.fromEntries(userReferrals),
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
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error("saveState failed:", err.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const state = JSON.parse(raw);

    if (state.userWallets) Object.entries(state.userWallets).forEach(([k, v]) => userWallets.set(k, v));
    if (state.userStats) Object.entries(state.userStats).forEach(([k, v]) => userStats.set(k, v));
    if (state.userDailyStreak) Object.entries(state.userDailyStreak).forEach(([k, v]) => userDailyStreak.set(k, v));
    if (state.referralCodes) Object.entries(state.referralCodes).forEach(([k, v]) => referralCodes.set(k, v));
    if (state.userReferrals) Object.entries(state.userReferrals).forEach(([k, v]) => userReferrals.set(k, v));

    if (state.jackpotAmountSOL != null) jackpotAmountSOL = state.jackpotAmountSOL;
    if (state.jackpotHistory) jackpotHistory = state.jackpotHistory;
    if (state.lastJackpotWin) lastJackpotWin = state.lastJackpotWin;
    if (state.pollMessageId) pollMessageId = state.pollMessageId;
    if (state.pollChatId) pollChatId = state.pollChatId;
    if (state.leaderboardMessageId) leaderboardMessageId = state.leaderboardMessageId;
    if (state.leaderboardChatId) leaderboardChatId = state.leaderboardChatId;
    if (state.openPrice) openPrice = state.openPrice;
    if (state.tournamentActive != null) tournamentActive = state.tournamentActive;
    if (state.tournamentEndTime) tournamentEndTime = state.tournamentEndTime;

    if (state.currentPoll && state.currentPoll.endTime > Date.now()) {
      currentPoll = state.currentPoll;
    }

    log.ok("State loaded from disk");
  } catch (err) {
    log.warn("loadState failed (starting fresh):", err.message);
  }
}

// ============================================
// IN-MEMORY STATE
// ============================================

let currentPrice = 0;
let openPrice = 0;

let currentPoll = {
  pot: 0,
  stakes: [],
  startTime: Date.now(),
  endTime: Date.now() + 3_600_000,
  totalBets: 0,
};

const userWallets = new Map();           // userId → { address, username, via }
const phantomSessions = new Map();       // sessionId → { userId, createdAt, walletAddress }
const pendingPhantomBets = new Map();    // sessionId → bet data
const pendingAmountInput = new Map();    // userId → { choice, username, chatId, timeoutHandle }
const pendingManualBets = new Map();     // memoId → bet data
const processedTxSignatures = new Set(); // bounded set of processed tx ids

const userStats = new Map();
const userDailyStreak = new Map();
const referralCodes = new Map();
const userReferrals = new Map();
const rateLimitMap = new Map();
const tournamentLB = new Map();

const voteActionCooldown = new Map();
const VOTE_COOLDOWN_MS = 3000;

let jackpotAmountSOL = 0;
let jackpotHistory = [];
let lastJackpotWin = null;

let pollMessageId = null;
let pollChatId = null;
let leaderboardMessageId = null;
let leaderboardChatId = null;

let tournamentActive = false;
let tournamentEndTime = 0;

let settlementInProgress = false;

let botUsername = "";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const DAILY_REWARDS = [0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.015];

const ACHIEVEMENTS = {
  FIRST_BET: { name: "🎯 First Bet", xp: 10 },
  HOT_STREAK_5: { name: "🔥 5 Win Streak", xp: 50 },
  HOT_STREAK_10: { name: "⚡ 10 Win Streak", xp: 200 },
  WHALE: { name: "🐋 Whale (10+ SOL)", xp: 500 },
  JACKPOT: { name: "🎰 Jackpot Winner", xp: 1000 },
};

// ============================================
// KRAKEN WEBSOCKET
// ============================================

let ws = null;
let wsReconnectDelay = 2000;

function connectPriceWebSocket() {
  try {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
    ws = new WebSocket("wss://ws.kraken.com");
  } catch (err) {
    log.error("WS create failed:", err.message);
    setTimeout(connectPriceWebSocket, wsReconnectDelay);
    return;
  }

  const hb = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("open", () => {
    log.ok("Kraken WebSocket connected");
    wsReconnectDelay = 2000;
    ws.send(JSON.stringify({
      event: "subscribe",
      pair: ["SOL/USD"],
      subscription: { name: "ticker" },
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (
        Array.isArray(msg) &&
        msg.length === 4 &&
        msg[2] === "ticker" &&
        msg[3] === "SOL/USD" &&
        msg[1]?.c?.[0]
      ) {
        const price = parseFloat(msg[1].c[0]);
        if (!isNaN(price) && price > 0) currentPrice = price;
      }
    } catch (_) {}
  });

  ws.on("error", (err) => log.error("WS error:", err.message));
  ws.on("close", () => {
    clearInterval(hb);
    log.warn(`WS closed — reconnect in ${wsReconnectDelay}ms`);
    setTimeout(connectPriceWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000);
  });
}

// ============================================
// PHANTOM WALLET CONNECTOR
// ============================================

function generateSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

function createPhantomSession(userId) {
  const sessionId = generateSessionId();
  phantomSessions.set(sessionId, { userId, createdAt: Date.now(), walletAddress: null });
  setTimeout(() => phantomSessions.delete(sessionId), 10 * 60_000);
  return sessionId;
}

function getPhantomSession(sessionId) {
  const s = phantomSessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.createdAt > 10 * 60_000) {
    phantomSessions.delete(sessionId);
    return null;
  }
  return s;
}

function buildPhantomConnectUrl(userId) {
  const sessionId = createPhantomSession(userId);
  const redirectUrl = `${APP_URL}/phantom/callback?session=${sessionId}`;
  const params = new URLSearchParams({
    app_url: APP_URL,
    dapp_key: "degen-echo",
    redirect_link: redirectUrl,
    cluster: "mainnet-beta",
  });
  return { sessionId, url: `https://phantom.app/ul/v1/connect?${params.toString()}` };
}

async function buildPhantomTxUrl(sessionId, fromAddress, toAddress, lamports) {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(fromAddress),
        toPubkey: new PublicKey(toAddress),
        lamports: Math.floor(lamports),
      })
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = new PublicKey(fromAddress);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const encodedTx = bs58.encode(serialized);

    const redirectUrl = `${APP_URL}/phantom/callback?session=${sessionId}`;
    const params = new URLSearchParams({
      transaction: encodedTx,
      dapp_key: "degen-echo",
      redirect_link: redirectUrl,
      cluster: "mainnet-beta",
    });

    return `https://phantom.app/ul/v1/signAndSendTransaction?${params.toString()}`;
  } catch (err) {
    log.error("buildPhantomTxUrl error:", err.message);
    return null;
  }
}

// ============================================
// HELPERS
// ============================================

function isValidSolanaAddress(addr) {
  try { new PublicKey(addr); return true; } catch { return false; }
}

async function checkBalance(address) {
  try {
    return (await connection.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

function validateStakeAmount(input) {
  const cleaned = input.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(cleaned))
    return { valid: false, error: "Please enter a valid number" };
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount < MIN_STAKE)
    return { valid: false, error: `Minimum stake is ${MIN_STAKE} SOL` };
  if (amount > MAX_STAKE)
    return { valid: false, error: `Maximum stake is ${MAX_STAKE} SOL` };
  return { valid: true, amount: Math.round(amount * 1e6) / 1e6 };
}

function formatPrice() {
  if (!currentPrice || currentPrice === 0) return "Loading…";
  return `$${currentPrice.toFixed(4)}`;
}

function getTimeRemaining() {
  const ms = currentPoll.endTime - Date.now();
  if (ms <= 0) return "Settling now…";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function generateMemoId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getUserWallet(userId) {
  return userWallets.get(userId) || null;
}

function ensureStats(userId, username) {
  if (!userStats.has(userId)) {
    userStats.set(userId, {
      username,
      totalBets: 0,
      totalWon: 0,
      totalStaked: 0,
      winStreak: 0,
      bestStreak: 0,
      xp: 0,
      badges: [],
    });
  }
  const s = userStats.get(userId);
  s.username = username;
  return s;
}

function awardAchievement(userId, key) {
  const s = userStats.get(userId);
  if (!s || s.badges.includes(key)) return;
  s.badges.push(key);
  s.xp += ACHIEVEMENTS[key]?.xp || 0;
}

function getStreakMultiplier(userId) {
  const s = userStats.get(userId);
  if (!s) return 1;
  if (s.winStreak >= 10) return 2.0;
  if (s.winStreak >= 5) return 1.5;
  return 1.0;
}

function generateReferralCode(userId) {
  return Buffer.from(userId).toString("base64").replace(/[^a-zA-Z0-9]/g, "").substring(0, 6);
}

// ============================================
// JACKPOT
// ============================================

function addToJackpot(sol) { jackpotAmountSOL += sol; }

async function tryWinJackpot(userId, username) {
  if (jackpotAmountSOL < 0.1) return null;
  const chance = tournamentActive ? 0.002 : 0.001;
  if (Math.random() < chance) {
    const won = jackpotAmountSOL;
    jackpotAmountSOL = 0;
    jackpotHistory.unshift({ userId, username, amount: won, timestamp: Date.now() });
    if (jackpotHistory.length > 10) jackpotHistory.pop();
    lastJackpotWin = { userId, username, amount: won, timestamp: Date.now() };
    return won;
  }
  return null;
}

// ============================================
// DAILY REWARDS
// ============================================

async function claimDailyReward(userId) {
  const now = Date.now();
  const entry = userDailyStreak.get(userId) || { streak: 0, lastClaim: 0 };
  const hrs = (now - entry.lastClaim) / 3_600_000;
  if (hrs < 24) return { success: false, hoursLeft: 24 - hrs };
  if (hrs > 48) entry.streak = 0;
  entry.streak = Math.min(entry.streak + 1, DAILY_REWARDS.length);
  entry.lastClaim = now;
  userDailyStreak.set(userId, entry);
  return { success: true, reward: DAILY_REWARDS[entry.streak - 1], streak: entry.streak };
}

// ============================================
// TOURNAMENT
// ============================================

function startTournament(durationHours = 24) {
  tournamentActive = true;
  tournamentEndTime = Date.now() + durationHours * 3_600_000;
  tournamentLB.clear();
  log.ok(`Tournament started — ${durationHours}h`);
  saveState();
}

async function endTournament() {
  tournamentActive = false;
  const top3 = [...tournamentLB.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  let msg = `🏆 *Tournament Ended!*\n\nTop Winners:\n`;
  top3.forEach(([uid, won], i) => {
    const name = userStats.get(uid)?.username || "Unknown";
    msg += `${i + 1}. ${name} – ${won.toFixed(4)} SOL\n`;
  });

  await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, msg, { parse_mode: "Markdown" }).catch(() => {});
  tournamentLB.clear();
  saveState();
}

// ============================================
// PAYOUT
// ============================================

async function sendPayout(toAddress, amountSOL, description, retries = 3) {
  if (!botWallet || !connection) return null;

  const toPubkey = new PublicKey(toAddress);
  const fromPubkey = botWallet.publicKey;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const balLamports = await connection.getBalance(fromPubkey);
      const neededLamports = Math.ceil(amountSOL * LAMPORTS_PER_SOL) + 5000;
      if (balLamports < neededLamports) {
        const have = (balLamports / LAMPORTS_PER_SOL).toFixed(6);
        for (const id of ADMIN_IDS) {
          await bot.telegram.sendMessage(
            id,
            `⚠️ *Bot wallet low!*\nNeed: ${amountSOL.toFixed(6)} SOL\nHave: ${have} SOL\nFor: ${description}`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
        return null;
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL),
        })
      );
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromPubkey;
      tx.sign(botWallet);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      log.ok(`Paid ${amountSOL.toFixed(6)} SOL → ${toAddress} | ${description}`);
      return sig;
    } catch (err) {
      log.error(`sendPayout attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  log.error(`sendPayout gave up after ${retries} attempts for ${description}`);
  return null;
}

// ============================================
// ON-CHAIN PAYMENT VERIFICATION (manual flow)
// ============================================

async function checkOnChainPayment(memoId, createdAt) {
  try {
    const sigs = await connection.getSignaturesForAddress(botWallet.publicKey, { limit: 100 });
    const cutoff = (createdAt || 0) - 30_000;

    for (const info of sigs) {
      if (processedTxSignatures.has(info.signature) || info.err) continue;
      if (info.blockTime && info.blockTime * 1000 < cutoff) break;

      const tx = await connection.getParsedTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      const logs = tx.meta?.logMessages || [];
      if (!logs.some((l) => l.includes(memoId))) continue;

      const keys = tx.transaction.message.accountKeys;
      const botIndex = keys.findIndex(
        (k) => k.pubkey.toString() === botWallet.publicKey.toString()
      );
      if (botIndex === -1) continue;

      const received = (tx.meta.postBalances[botIndex] - tx.meta.preBalances[botIndex]) / LAMPORTS_PER_SOL;
      if (received <= 0) continue;

      processedTxSignatures.add(info.signature);
      return { signature: info.signature, amount: received };
    }
    return null;
  } catch (err) {
    log.error("checkOnChainPayment:", err.message);
    return null;
  }
}

// ============================================
// BET CONFIRMATION (shared)
// ============================================

async function confirmBet(userId, username, amount, choice, signature, chatId) {
  const rakeAmt = amount * RAKE_PERCENT;
  const potAmt = amount * POT_PERCENT;
  const jackpotAmt = amount * JACKPOT_PERCENT;

  currentPoll.pot += potAmt;
  currentPoll.stakes.push({ userId, username, choice, amount: potAmt, timestamp: Date.now(), signature });
  currentPoll.totalBets++;

  addToJackpot(jackpotAmt);

  const stats = ensureStats(userId, username);
  stats.totalBets++;
  stats.totalStaked += amount;
  stats.xp += 10;

  if (stats.totalBets === 1) awardAchievement(userId, "FIRST_BET");
  if (amount >= 10) awardAchievement(userId, "WHALE");

  if (tournamentActive) {
    tournamentLB.set(userId, (tournamentLB.get(userId) || 0) + potAmt);
  }

  const jackpotWin = await tryWinJackpot(userId, username);
  if (jackpotWin) {
    awardAchievement(userId, "JACKPOT");
    const wallet = getUserWallet(userId);
    if (wallet) await sendPayout(wallet.address, jackpotWin, "Jackpot win");
    await bot.telegram.sendMessage(chatId, `🎰 *JACKPOT! You won ${jackpotWin.toFixed(4)} SOL!*`, { parse_mode: "Markdown" }).catch(() => {});
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, `🎰 *JACKPOT HIT!*\n👤 ${username} won *${jackpotWin.toFixed(4)} SOL*!`, { parse_mode: "Markdown" }).catch(() => {});
  }

  const emoji = { pump: "🚀", dump: "📉", stagnate: "🟡" }[choice];
  await bot.telegram.sendMessage(chatId, `${emoji} *Bet Confirmed!*\n\nChoice: *${choice.toUpperCase()}*\nAmount: *${amount.toFixed(6)} SOL*\nTX: \`${signature.slice(0, 8)}…${signature.slice(-8)}\``, { parse_mode: "Markdown" }).catch(() => {});
  await bot.telegram.sendMessage(LIVE_CHANNEL, `${emoji} *New Bet!*\n👤 ${username}\n💰 ${amount.toFixed(4)} SOL → *${choice.toUpperCase()}*\n📦 Pot: ${currentPoll.pot.toFixed(4)} SOL`, { parse_mode: "Markdown" }).catch(() => {});

  saveState();
  await updatePoll();
}

// ============================================
// MESSAGE BUILDERS
// ============================================

function buildPollMessage() {
  const pump = currentPoll.stakes.filter((s) => s.choice === "pump").reduce((a, s) => a + s.amount, 0);
  const dump = currentPoll.stakes.filter((s) => s.choice === "dump").reduce((a, s) => a + s.amount, 0);
  const flat = currentPoll.stakes.filter((s) => s.choice === "stagnate").reduce((a, s) => a + s.amount, 0);

  let msg = `🎰 *DEGEN ECHO HOURLY POLL*\n\n`;
  msg += `💰 SOL Price: *${formatPrice()}*\n`;
  msg += `⏰ Time Left: *${getTimeRemaining()}*\n\n`;

  if (currentPoll.stakes.length === 0) {
    msg += `_No stakes yet – be first!_\n\n`;
  } else {
    msg += `💰 *Pot:* ${currentPoll.pot.toFixed(6)} SOL\n`;
    msg += `🚀 PUMP: ${pump.toFixed(6)} SOL (${currentPoll.stakes.filter((s) => s.choice === "pump").length})\n`;
    msg += `📉 DUMP: ${dump.toFixed(6)} SOL (${currentPoll.stakes.filter((s) => s.choice === "dump").length})\n`;
    msg += `🟡 FLAT: ${flat.toFixed(6)} SOL (${currentPoll.stakes.filter((s) => s.choice === "stagnate").length})\n\n`;
  }

  msg += `🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL\n`;
  msg += `Min: ${MIN_STAKE} SOL | 19% rake · 80% pot · 1% jackpot`;
  if (tournamentActive) msg += `\n🏆 *TOURNAMENT ACTIVE — double jackpot chance!*`;

  return msg;
}

function getPollKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🚀 Pump", callback_data: "vote_pump" },
      { text: "📉 Dump", callback_data: "vote_dump" },
      { text: "🟡 Flat", callback_data: "vote_stagnate" },
    ]],
  };
}

function buildLeaderboardMessage() {
  if (userStats.size === 0) return "🏆 *LEADERBOARD*\n\n_No bets yet – be first!_";

  const sorted = [...userStats.entries()]
    .sort((a, b) => (b[1].totalWon || 0) - (a[1].totalWon || 0))
    .slice(0, 10);

  const medals = ["🥇", "🥈", "🥉"];
  let msg = "🏆 *DEGEN ECHO LEADERBOARD*\n\n";

  sorted.forEach(([, s], i) => {
    const medal = medals[i] || `${i + 1}.`;
    const wr = s.totalBets ? ((s.totalWon / Math.max(s.totalStaked, 0.0001)) * 100).toFixed(1) : "0.0";
    msg += `${medal} *${s.username}*\n`;
    msg += `   💰 Won: ${(s.totalWon || 0).toFixed(4)} SOL | Rate: ${wr}%\n`;
    msg += `   🎯 Bets: ${s.totalBets} | 🔥 Streak: ${s.winStreak}\n`;
    if (s.badges?.length) msg += `   ${s.badges.map((b) => ACHIEVEMENTS[b]?.name || b).join(" ")}\n`;
    msg += "\n";
  });

  msg += `🎰 Jackpot: *${jackpotAmountSOL.toFixed(4)} SOL*`;
  if (tournamentActive) msg += "\n🏆 *TOURNAMENT ACTIVE*";
  return msg;
}

// ============================================
// AUTO-UPDATE POLL & LEADERBOARD
// ============================================

async function updatePoll() {
  try {
    const text = buildPollMessage();
    const reply_markup = getPollKeyboard();

    if (pollMessageId && pollChatId) {
      try {
        await bot.telegram.editMessageText(
          pollChatId, pollMessageId, undefined, text,
          { parse_mode: "Markdown", reply_markup }
        );
        return;
      } catch (err) {
        log.warn("Poll edit failed, sending new message:", err.message);
        pollMessageId = null;
        pollChatId = null;
      }
    }

    try {
      const sent = await bot.telegram.sendMessage(LIVE_CHANNEL, text, {
        parse_mode: "Markdown", reply_markup,
      });
      pollMessageId = sent.message_id;
      pollChatId = sent.chat.id;
      await bot.telegram.pinChatMessage(LIVE_CHANNEL, sent.message_id).catch(() => {});
    } catch (channelErr) {
      log.error(`Live channel failed, falling back to community group: ${channelErr.message}`);
      const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, text, {
        parse_mode: "Markdown", reply_markup,
      });
      pollMessageId = sent.message_id;
      pollChatId = sent.chat.id;
    }

    saveState();
  } catch (err) {
    log.error("updatePoll error:", err.message);
  }
}

async function updateLeaderboard() {
  try {
    const text = buildLeaderboardMessage();

    if (leaderboardMessageId && leaderboardChatId) {
      try {
        await bot.telegram.editMessageText(
          leaderboardChatId, leaderboardMessageId, undefined, text,
          { parse_mode: "Markdown" }
        );
        return;
      } catch (_) {
        leaderboardMessageId = null;
        leaderboardChatId = null;
      }
    }

    const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, text, { parse_mode: "Markdown" });
    leaderboardMessageId = sent.message_id;
    leaderboardChatId = sent.chat.id;
    await bot.telegram.pinChatMessage(COMMUNITY_GROUP, sent.message_id).catch(() => {});
    saveState();
  } catch (err) {
    log.error("updateLeaderboard error:", err.message);
  }
}

// ============================================
// HOURLY SETTLEMENT
// ============================================

async function settleHour() {
  if (settlementInProgress) {
    log.warn("Settlement already in progress — skipping");
    return;
  }
  settlementInProgress = true;

  try {
    log.info("⏰ Hourly settlement");

    if (currentPoll.stakes.length < 2) {
      await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, "⏰ Not enough bets this hour.").catch(() => {});
    } else {
      let winnerChoice;
      if (currentPrice > openPrice * 1.001) winnerChoice = "pump";
      else if (currentPrice < openPrice * 0.999) winnerChoice = "dump";
      else winnerChoice = "stagnate";

      const emojiMap = { pump: "🚀", dump: "📉", stagnate: "🟡" };
      const winners = currentPoll.stakes.filter((s) => s.choice === winnerChoice);
      const losers = currentPoll.stakes.filter((s) => s.choice !== winnerChoice);
      const totalPot = currentPoll.pot;
      const winPool = winners.reduce((a, s) => a + s.amount, 0);

      let paidCount = 0, paidAmount = 0;

      for (const w of winners) {
        const wallet = getUserWallet(w.userId);
        if (!wallet) continue;

        const share = w.amount / winPool;
        const multiplier = getStreakMultiplier(w.userId);
        const payout = parseFloat((totalPot * share * multiplier).toFixed(6));

        const sig = await sendPayout(wallet.address, payout, `Hourly win – ${winnerChoice}`);
        if (sig) {
          paidCount++;
          paidAmount += payout;

          const s = userStats.get(w.userId);
          if (s) {
            s.totalWon += payout;
            s.winStreak = (s.winStreak || 0) + 1;
            if (s.winStreak > (s.bestStreak || 0)) s.bestStreak = s.winStreak;
            s.xp += 50;
            if (s.winStreak >= 5) awardAchievement(w.userId, "HOT_STREAK_5");
            if (s.winStreak >= 10) awardAchievement(w.userId, "HOT_STREAK_10");
            if (tournamentActive) tournamentLB.set(w.userId, (tournamentLB.get(w.userId) || 0) + payout);
          }

          await bot.telegram.sendMessage(
            w.userId,
            `🏆 *You won!*\n\nSOL went *${winnerChoice.toUpperCase()}*\n💰 *+${payout.toFixed(6)} SOL* paid to your wallet\nTX: \`${sig.slice(0, 8)}…${sig.slice(-8)}\``,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }

      for (const l of losers) {
        const s = userStats.get(l.userId);
        if (s) s.winStreak = 0;
      }

      await bot.telegram.sendMessage(
        ANNOUNCEMENTS_CHANNEL,
        `⏰ *Hourly Results*\n\n${emojiMap[winnerChoice]} Winner: *${winnerChoice.toUpperCase()}*\nOpen: $${openPrice.toFixed(4)} → Close: $${currentPrice.toFixed(4)}\n💰 Pot: ${totalPot.toFixed(6)} SOL\n🏆 Winners: ${paidCount} | Paid: ${paidAmount.toFixed(6)} SOL\n🎰 Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL`,
        { parse_mode: "Markdown" }
      ).catch(() => {});

      log.ok(`Settlement done: ${paidCount} winners, ${paidAmount.toFixed(6)} SOL`);
    }

    openPrice = currentPrice;
    pollMessageId = null;
    pollChatId = null;
    currentPoll = {
      pot: 0,
      stakes: [],
      startTime: Date.now(),
      endTime: Date.now() + 3_600_000,
      totalBets: 0,
    };

    await updatePoll();
    await updateLeaderboard();
    saveState();

    if (tournamentActive && Date.now() >= tournamentEndTime) await endTournament();
  } finally {
    settlementInProgress = false;
  }
}

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => log.error("Bot error:", err.message, ctx?.updateType));

// Rate limiter
bot.use((ctx, next) => {
  const uid = ctx.from?.id?.toString();
  if (!uid) return next();
  const now = Date.now();
  const entry = rateLimitMap.get(uid) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) { entry.count = 1; entry.windowStart = now; }
  else entry.count++;
  rateLimitMap.set(uid, entry);
  if (entry.count > RATE_LIMIT) return ctx.reply("⏳ Slow down!").catch(() => {});
  return next();
});

// ============================================
// COMMANDS
// ============================================

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  const name = ctx.from.first_name || "Degen";

  const args = ctx.message.text.split(" ");
  if (args[1]?.startsWith("ref_")) {
    const code = args[1].slice(4);
    const referrerId = referralCodes.get(code);
    if (referrerId && referrerId !== userId && !userReferrals.has(userId)) {
      userReferrals.set(userId, { referredBy: referrerId });
      const rs = userStats.get(referrerId);
      if (rs) rs.xp += 50;
      await bot.telegram.sendMessage(referrerId, `🤝 Someone joined via your referral link! +50 XP`).catch(() => {});
      saveState();
    }
  }

  const wallet = getUserWallet(userId);
  const walletStatus = wallet
    ? `✅ Wallet: \`${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}\` (${wallet.via})`
    : "❌ No wallet connected";

  await ctx.reply(
    `🎰 *Welcome to Degen Echo, ${name}!*\n\n${walletStatus}\n\n` +
    `*Connect wallet:*\n/connect – Phantom deep link\n/register <address> – Manual\n\n` +
    `*Commands:*\n/balance /leaderboard /poll /jackpot /daily /ref /stats /achievements /tournament /cancel /help`,
    { parse_mode: "Markdown" }
  );
});

bot.command("connect", async (ctx) => {
  const userId = ctx.from.id.toString();
  const { url } = buildPhantomConnectUrl(userId);
  await ctx.reply(
    `🔌 *Connect Phantom Wallet*\n\nMobile/desktop: tap the button below.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🔌 Connect Phantom", url }]],
      },
    }
  );
});

bot.command("register", async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.trim().split(/\s+/);

  if (args.length !== 2) {
    return ctx.reply("Usage: `/register <solana_wallet_address>`", { parse_mode: "Markdown" });
  }

  const address = args[1].trim();
  if (!isValidSolanaAddress(address)) {
    return ctx.reply("❌ Invalid Solana address.");
  }
  if (address === botWallet.publicKey.toString() || address === RAKE_WALLET) {
    return ctx.reply("❌ Cannot register a system wallet.");
  }

  const balance = await checkBalance(address);
  userWallets.set(userId, { address, username, registeredAt: Date.now(), via: "manual" });
  saveState();

  return ctx.reply(
    `✅ *Wallet Registered!*\n\n💳 \`${address}\`\n💰 Balance: ${balance.toFixed(6)} SOL`,
    { parse_mode: "Markdown" }
  );
});

bot.command("balance", async (ctx) => {
  const userId = ctx.from.id.toString();
  const wallet = getUserWallet(userId);
  if (!wallet) return ctx.reply("❌ No wallet. Use /connect or /register first.");
  const balance = await checkBalance(wallet.address);
  return ctx.reply(
    `💰 *Balance*\n\n\`${wallet.address}\`\n*${balance.toFixed(6)} SOL*`,
    { parse_mode: "Markdown" }
  );
});

bot.command("poll", async (ctx) => {
  await ctx.reply(buildPollMessage(), { parse_mode: "Markdown", reply_markup: getPollKeyboard() });
});

bot.command("leaderboard", (ctx) => {
  ctx.reply(buildLeaderboardMessage(), { parse_mode: "Markdown" });
});

bot.command("jackpot", (ctx) => {
  let msg = `🎰 *Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL*\n`;
  if (lastJackpotWin) {
    const ago = Math.floor((Date.now() - lastJackpotWin.timestamp) / 60_000);
    msg += `\nLast winner: *${lastJackpotWin.username}* won *${lastJackpotWin.amount.toFixed(4)} SOL* (${ago}m ago)`;
  }
  ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("daily", async (ctx) => {
  const userId = ctx.from.id.toString();
  const result = await claimDailyReward(userId);
  if (!result.success) {
    return ctx.reply(`⏳ Next daily in *${Math.ceil(result.hoursLeft)}h*`, { parse_mode: "Markdown" });
  }

  saveState();

  const wallet = getUserWallet(userId);
  if (!wallet) {
    return ctx.reply(
      `✅ *Daily Reward Earned!*\n\n💰 ${result.reward} SOL\n🔥 Streak: ${result.streak}\n\n⚠️ No wallet registered – use /connect or /register to receive your reward.`,
      { parse_mode: "Markdown" }
    );
  }

  await sendPayout(wallet.address, result.reward, "Daily reward");
  ctx.reply(
    `✅ *Daily Reward Claimed!*\n\n💰 ${result.reward} SOL\n🔥 Streak: ${result.streak} day${result.streak > 1 ? "s" : ""}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("ref", (ctx) => {
  const userId = ctx.from.id.toString();
  const code = generateReferralCode(userId);
  referralCodes.set(code, userId);
  const link = `https://t.me/${botUsername}?start=ref_${code}`;
  ctx.reply(
    `🤝 *Your Referral Link*\n\n\`${link}\`\n\nShare this — you earn *50 XP* per signup!`,
    { parse_mode: "Markdown" }
  );
});

bot.command("stats", (ctx) => {
  const userId = ctx.from.id.toString();
  const s = userStats.get(userId);
  if (!s) return ctx.reply("No stats yet. Place a bet first!");
  const wr = s.totalBets ? ((s.totalWon / Math.max(s.totalStaked, 0.0001)) * 100).toFixed(1) : "0.0";
  ctx.reply(
    `📊 *Your Stats*\n\nBets: ${s.totalBets}\nStaked: ${s.totalStaked.toFixed(4)} SOL\nWon: ${s.totalWon.toFixed(4)} SOL\nWin Rate: ${wr}%\n🔥 Streak: ${s.winStreak} (Best: ${s.bestStreak})\n⭐ XP: ${s.xp}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("achievements", (ctx) => {
  const userId = ctx.from.id.toString();
  const s = userStats.get(userId);
  if (!s?.badges?.length) return ctx.reply("No achievements yet. Start betting!");
  let msg = "🏅 *Your Achievements*\n\n";
  s.badges.forEach((b) => { if (ACHIEVEMENTS[b]) msg += `${ACHIEVEMENTS[b].name} (+${ACHIEVEMENTS[b].xp} XP)\n`; });
  ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("tournament", (ctx) => {
  if (!tournamentActive) return ctx.reply("No tournament active right now.");
  const ms = tournamentEndTime - Date.now();
  const hrs = Math.floor(ms / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  ctx.reply(
    `🏆 *Tournament Active!*\n\nTime left: *${hrs}h ${min}m*\nDouble jackpot chance!\nTop 3 win prizes at the end.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("cancel", (ctx) => {
  const userId = ctx.from.id.toString();
  const inp = pendingAmountInput.get(userId);
  if (inp) { clearTimeout(inp.timeoutHandle); pendingAmountInput.delete(userId); }
  for (const [memoId, bet] of pendingManualBets.entries()) {
    if (bet.userId === userId) {
      clearTimeout(bet.timeoutHandle);
      pendingManualBets.delete(memoId);
    }
  }
  ctx.reply("✅ Cancelled.");
});

bot.command("help", (ctx) => {
  ctx.reply(
    `📋 *Commands*\n\n` +
    `/connect – Connect Phantom wallet\n` +
    `/register <addr> – Manual wallet registration\n` +
    `/balance – Check wallet balance\n` +
    `/leaderboard – View top players\n` +
    `/poll – Show current poll\n` +
    `/jackpot – Check jackpot\n` +
    `/daily – Claim daily reward\n` +
    `/ref – Get referral link\n` +
    `/stats – Your betting stats\n` +
    `/achievements – Your badges\n` +
    `/tournament – Tournament info\n` +
    `/cancel – Cancel pending bet`,
    { parse_mode: "Markdown" }
  );
});

bot.command("debug", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  const bal = await checkBalance(botWallet.publicKey.toString());
  ctx.reply(
    `🔧 *Debug*\n\n` +
    `Price: ${formatPrice()}\n` +
    `Bot balance: ${bal.toFixed(6)} SOL\n` +
    `Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL\n` +
    `Poll stakes: ${currentPoll.stakes.length}\n` +
    `Poll pot: ${currentPoll.pot.toFixed(6)} SOL\n` +
    `Users with wallets: ${userWallets.size}\n` +
    `Total users: ${userStats.size}\n` +
    `Pending manual bets: ${pendingManualBets.size}\n` +
    `Pending amount inputs: ${pendingAmountInput.size}\n` +
    `Processed sigs: ${processedTxSignatures.size}\n` +
    `Tournament: ${tournamentActive ? "Active" : "Off"}\n` +
    `Settlement lock: ${settlementInProgress}\n` +
    `Uptime: ${Math.floor(process.uptime())}s`,
    { parse_mode: "Markdown" }
  );
});

// 🔧 DIAGNOSTIC COMMANDS
bot.command('envtest', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return ctx.reply('Admin only');
  await ctx.reply(
    `🔧 *Environment*\n` +
    `LIVE: \`${LIVE_CHANNEL}\`\n` +
    `COMMUNITY: \`${COMMUNITY_GROUP}\`\n` +
    `ANNOUNCEMENTS: \`${ANNOUNCEMENTS_CHANNEL}\`\n` +
    `ADMIN_IDS: ${JSON.stringify(ADMIN_IDS)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('channeltest', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return ctx.reply('Admin only');
  const results = [];
  const channels = [
    { name: 'LIVE', id: LIVE_CHANNEL },
    { name: 'COMMUNITY', id: COMMUNITY_GROUP },
    { name: 'ANNOUNCEMENTS', id: ANNOUNCEMENTS_CHANNEL }
  ];
  for (const ch of channels) {
    try {
      await bot.telegram.sendMessage(ch.id, `🧪 Test from bot to ${ch.name}`);
      results.push(`✅ ${ch.name} (${ch.id}) works`);
    } catch (e) {
      results.push(`❌ ${ch.name} (${ch.id}): ${e.message}`);
    }
  }
  await ctx.reply(results.join('\n'));
});

bot.command('starttournament', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  const hours = parseInt(ctx.message.text.split(" ")[1]) || 24;
  startTournament(hours);
  ctx.reply(`🏆 Tournament started for ${hours} hours!`);
  await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, `🏆 *TOURNAMENT STARTED!*\n\nDuration: ${hours} hours\nDouble jackpot chance!\nTop 3 winners get prizes!`, { parse_mode: "Markdown" }).catch(() => {});
});

// ============================================
// VOTE BUTTON HANDLER
// ============================================

bot.action(/^vote_(pump|dump|stagnate)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  const choice = ctx.match[1];
  const wallet = getUserWallet(userId);

  const lastVote = voteActionCooldown.get(userId) || 0;
  if (Date.now() - lastVote < VOTE_COOLDOWN_MS) {
    return ctx.answerCbQuery("⏳ Please wait a moment before voting again.").catch(() => {});
  }
  voteActionCooldown.set(userId, Date.now());

  if (pendingAmountInput.has(userId)) {
    return ctx.reply("⚠️ You already have a pending bet. Use /cancel first.").catch(() => {});
  }

  if (!wallet) {
    const { url } = buildPhantomConnectUrl(userId);
    return ctx.reply(
      `🔌 *Connect a wallet first*\n\nChoose one:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔌 Connect Phantom", url }],
            [{ text: "📝 Manual Register", callback_data: "show_register" }],
          ],
        },
      }
    );
  }

  const emoji = { pump: "🚀", dump: "📉", stagnate: "🟡" }[choice];

  const timeoutHandle = setTimeout(() => {
    pendingAmountInput.delete(userId);
    bot.telegram.sendMessage(ctx.chat.id, "⏱️ Timed out. Click a button to try again.").catch(() => {});
  }, PAYMENT_TIMEOUT_MS);

  pendingAmountInput.set(userId, { choice, username, chatId: ctx.chat.id, timeoutHandle });

  await ctx.reply(
    `${emoji} *${choice.toUpperCase()}* on SOL!\n\nEnter stake amount in SOL _(min ${MIN_STAKE}):_`,
    { parse_mode: "Markdown" }
  );
});

bot.action("show_register", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `📝 *Manual Registration*\n\nSend:\n\`/register YOUR_SOLANA_WALLET_ADDRESS\``,
    { parse_mode: "Markdown" }
  );
});

// ============================================
// TEXT HANDLER – stake amount
// ============================================

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const userId = ctx.from.id.toString();
  const pending = pendingAmountInput.get(userId);
  if (!pending) return;

  const validation = validateStakeAmount(text);
  if (!validation.valid) return ctx.reply(`❌ ${validation.error}. Try again:`);

  const amount = validation.amount;
  clearTimeout(pending.timeoutHandle);
  pendingAmountInput.delete(userId);

  const wallet = getUserWallet(userId);
  if (!wallet) return ctx.reply("❌ Wallet not found. Use /connect or /register.");

  const rakeAmt = parseFloat((amount * RAKE_PERCENT).toFixed(6));
  const botAmt = parseFloat((amount * (POT_PERCENT + JACKPOT_PERCENT)).toFixed(6));

  // Phantom flow
  const sessionId = generateSessionId();
  phantomSessions.set(sessionId, { userId, createdAt: Date.now(), walletAddress: wallet.address });
  pendingPhantomBets.set(sessionId, {
    userId,
    username: pending.username,
    amount,
    choice: pending.choice,
    chatId: pending.chatId || ctx.chat.id,
  });
  setTimeout(() => {
    phantomSessions.delete(sessionId);
    pendingPhantomBets.delete(sessionId);
  }, PAYMENT_TIMEOUT_MS);

  let txUrl = null;
  try {
    txUrl = await buildPhantomTxUrl(
      sessionId,
      wallet.address,
      botWallet.publicKey.toString(),
      amount * LAMPORTS_PER_SOL
    );
  } catch (err) {
    log.error("buildPhantomTxUrl error:", err.message);
  }

  // Manual flow
  const memoId = generateMemoId();
  const createdAt = Date.now();
  const expiresAt = createdAt + PAYMENT_TIMEOUT_MS;

  const timeoutHandle = setTimeout(() => {
    pendingManualBets.delete(memoId);
    bot.telegram.sendMessage(ctx.chat.id, `⏱️ Manual payment window expired for memo \`${memoId}\`.`, { parse_mode: "Markdown" }).catch(() => {});
  }, PAYMENT_TIMEOUT_MS);

  pendingManualBets.set(memoId, {
    userId,
    username: pending.username,
    amount,
    choice: pending.choice,
    chatId: ctx.chat.id,
    createdAt,
    expiresAt,
    timeoutHandle,
  });

  // Start watching for manual payment (simplified)
  (async () => {
    while (true) {
      const bet = pendingManualBets.get(memoId);
      if (!bet) break;
      if (Date.now() > bet.expiresAt) {
        pendingManualBets.delete(memoId);
        await bot.telegram.sendMessage(ctx.chat.id, `⏱️ Payment window expired for memo \`${memoId}\`.`, { parse_mode: "Markdown" }).catch(() => {});
        break;
      }
      const result = await checkOnChainPayment(memoId, createdAt);
      if (result) {
        pendingManualBets.delete(memoId);
        await confirmBet(userId, pending.username, result.amount, pending.choice, result.signature, ctx.chat.id);
        break;
      }
      await new Promise(r => setTimeout(r, BLOCKCHAIN_POLL_MS));
    }
  })();

  const keyboard = txUrl
    ? { inline_keyboard: [[{ text: "💎 Approve in Phantom", url: txUrl }]] }
    : undefined;

  await ctx.reply(
    `📋 *Stake Summary*\n\n` +
    `💰 Amount: *${amount} SOL*\n` +
    `📈 Choice: *${pending.choice.toUpperCase()}*\n\n` +
    `*Option 1 — Phantom (easiest):*\n` +
    (txUrl ? `Tap the button below.\n\n` : `_(Phantom link unavailable — use Option 2)_\n\n`) +
    `*Option 2 — Manual send:*\n` +
    `Send *${botAmt} SOL* to:\n\`${botWallet.publicKey.toString()}\`\n\n` +
    `Also send *${rakeAmt} SOL* to:\n\`${RAKE_WALLET}\`\n\n` +
    `🔑 *Memo:* \`${memoId}\`\n` +
    `_(Bot auto-detects payment on-chain)_\n\n` +
    `⏱️ 5 minutes to complete`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

// ============================================
// EXPRESS SERVER + PHANTOM CALLBACK
// ============================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_, res) => res.send("Degen Echo Bot — Running ✅"));

app.get("/health", (_, res) => res.json({
  status: "ok",
  uptime: Math.floor(process.uptime()),
  price: currentPrice,
  jackpot: jackpotAmountSOL,
  pot: currentPoll.pot,
  stakes: currentPoll.stakes.length,
  users: userStats.size,
  wallets: userWallets.size,
  tournament: tournamentActive,
}));

app.get("/phantom/callback", async (req, res) => {
  const { session: sessionId, public_key, transaction_signature, errorCode, errorMessage } = req.query;

  log.info("Phantom callback:", { sessionId, public_key: public_key?.slice(0, 8), transaction_signature: transaction_signature?.slice(0, 8), errorCode });

  const htmlClose = (msg) => res.send(`
    <!DOCTYPE html>
    <html><head><title>Degen Echo</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#fff;}.box{text-align:center;padding:2rem;}</style></head>
    <body><div class="box"><h2>🎰 Degen Echo</h2><p>${msg}</p><p><small>You can close this window</small></p><script>setTimeout(() => { if(window.opener) window.close(); }, 2000);</script></div></body></html>
  `);

  if (errorCode) {
    log.warn("Phantom error:", errorCode, errorMessage);
    const session = getPhantomSession(sessionId);
    if (session) {
      await bot.telegram.sendMessage(session.userId, `❌ Phantom connection failed: ${errorMessage || errorCode}\n\nTry /connect again.`).catch(() => {});
    }
    return htmlClose("❌ Connection failed. Please try again.");
  }

  if (public_key && sessionId) {
    if (!isValidSolanaAddress(public_key)) {
      log.warn("Phantom callback: invalid public_key received:", public_key);
      return htmlClose("❌ Invalid wallet address received.");
    }

    const session = getPhantomSession(sessionId);
    if (session) {
      session.walletAddress = public_key;
      phantomSessions.set(sessionId, session);

      const username = userStats.get(session.userId)?.username || "User";
      userWallets.set(session.userId, { address: public_key, username, registeredAt: Date.now(), via: "phantom" });

      saveState();
      log.ok(`Phantom wallet connected: ${public_key.slice(0, 8)}… for user ${session.userId}`);

      await bot.telegram.sendMessage(session.userId, `✅ *Phantom Wallet Connected!*\n\n\`${public_key}\`\n\nYou can now bet on the polls.`, { parse_mode: "Markdown" }).catch(() => {});

      return htmlClose("✅ Wallet connected! Head back to Telegram.");
    }
  }

  if (transaction_signature && sessionId) {
    const betData = pendingPhantomBets.get(sessionId);
    if (betData) {
      pendingPhantomBets.delete(sessionId);
      processedTxSignatures.add(transaction_signature);

      await confirmBet(betData.userId, betData.username, betData.amount, betData.choice, transaction_signature, betData.chatId || betData.userId);

      return htmlClose("✅ Bet confirmed! Good luck 🍀");
    }
  }

  return htmlClose("Done! You can close this window.");
});

app.listen(PORT, "0.0.0.0", () => log.ok(`Server on port ${PORT}`));

// ============================================
// CRON JOBS
// ============================================

cron.schedule("0 * * * *", settleHour);
cron.schedule("*/30 * * * * *", updatePoll);
cron.schedule("*/5 * * * *", updateLeaderboard);
cron.schedule("* * * * *", () => {
  if (tournamentActive && Date.now() >= tournamentEndTime) endTournament();
});

cron.schedule("0 0 * * *", () => {
  const now = Date.now();
  for (const [uid, e] of rateLimitMap.entries()) {
    if (now - e.windowStart > RATE_WINDOW_MS * 2) rateLimitMap.delete(uid);
  }
  for (const [uid, ts] of voteActionCooldown.entries()) {
    if (now - ts > 3_600_000) voteActionCooldown.delete(uid);
  }
  log.info("Daily cleanup done");
});

cron.schedule("*/5 * * * *", saveState);

// ============================================
// STARTUP
// ============================================

async function startup() {
  log.info("Starting Degen Echo Bot…");

  loadState();
  connectPriceWebSocket();

  for (let i = 0; i < 15; i++) {
    if (currentPrice > 0) { log.ok(`Price: ${formatPrice()}`); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (currentPrice <= 0) { currentPrice = 20; log.warn("Using fallback price $20"); }

  if (!openPrice) openPrice = currentPrice;

  await updatePoll();
  await updateLeaderboard();
  log.ok("✅ Startup complete!");
}

process.on("unhandledRejection", (reason) => log.error("Unhandled promise rejection:", reason));
process.on("uncaughtException", (err) => log.error("Uncaught exception:", err.message, err.stack));

bot.launch({ dropPendingUpdates: true })
  .then(async () => {
    const info = await bot.telegram.getMe();
    botUsername = info.username;
    log.ok(`Bot @${botUsername} is LIVE!`);
    log.ok("Rake wallet:", RAKE_WALLET);
    log.ok("Bot wallet :", botWallet.publicKey.toString());
    await startup();
  })
  .catch((err) => {
    log.error("Launch failed:", err.message);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    log.info("Shutting down…");
    saveState();
    bot.stop(sig);
    if (ws) ws.close();
    setTimeout(() => process.exit(0), 2000);
  });
}
