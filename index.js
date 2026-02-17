"use strict";

/**
 * DEGEN ECHO – COMPLETE PRODUCTION BOT
 * ALL FEATURES INTACT + FIXES
 * - Daily rewards, referrals, achievements, tournaments
 * - Fixed price display & Phantom connect
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
const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================

const REQUIRED_ENV = [
  "BOT_TOKEN",
  "BOT_PRIVATE_KEY",
  "RAKE_WALLET",
  "ADMIN_TELEGRAM_ID",
  "APP_URL",
  "SESSION_SECRET"
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
const ADMIN_IDS = [process.env.ADMIN_TELEGRAM_ID, "1087968824"].filter(Boolean);
const APP_URL = process.env.APP_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Split configuration
const RAKE_PERCENT = 0.19;
const POT_PERCENT = 0.80;
const JACKPOT_PERCENT = 0.01;

const MIN_STAKE = 0.001;
const MAX_STAKE = 1000;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000;
const PORT = Number(process.env.PORT) || 3000;

// Telegram channels
const LIVE_CHANNEL = process.env.LIVE_CHANNEL || "@degenecholive";
const ANNOUNCEMENTS_CHANNEL = process.env.ANNOUNCEMENTS_CHANNEL || "@degenechochamber";
const COMMUNITY_GROUP = process.env.COMMUNITY_GROUP || "@degenechochat";

// Solana
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const ANONYMOUS_ADMIN_ID = "1087968824";
const CURRENT_COIN = "SOL/USD";

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
  console.error("❌ Failed to connect to Solana:", err.message);
  process.exit(1);
}

let botWallet;
try {
  const secretKey = bs58.decode(BOT_PRIVATE_KEY);
  botWallet = Keypair.fromSecretKey(secretKey);
  console.log("✅ Bot wallet loaded:", botWallet.publicKey.toString());
} catch (err) {
  console.error("❌ Failed to load bot wallet:", err.message);
  process.exit(1);
}

// ============================================
// PHANTOM WALLET CONNECTOR - FIXED
// ============================================

class PhantomConnector {
  constructor(config) {
    this.appUrl = config.appUrl;
    this.dappKey = 'degen-echo-bot';
    this.sessions = new Map();
    this.userSessions = new Map();
    console.log("✅ Phantom connector initialized");
  }

  generateConnectLink(userId) {
    const sessionId = this.createSession(userId);
    return `https://phantom.app/ul/v1/connect?app_url=${encodeURIComponent(this.appUrl)}&dapp_key=${this.dappKey}&session=${sessionId}&redirect_url=${encodeURIComponent(this.appUrl + '/phantom/callback')}`;
  }

  async generateTransactionLink(userId, amount, choice, walletAddress) {
    const session = this.userSessions.get(userId);
    if (!session || !session.walletAddress) {
      throw new Error('Wallet not connected');
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(session.walletAddress),
        toPubkey: new PublicKey(RAKE_WALLET),
        lamports: Math.floor(amount * LAMPORTS_PER_SOL)
      })
    );

    const serializedTx = bs58.encode(transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    }));

    return `https://phantom.app/ul/v1/signAndSendTransaction?transaction=${serializedTx}&session=${session.id}&app_url=${encodeURIComponent(this.appUrl)}&dapp_key=${this.dappKey}&redirect_url=${encodeURIComponent(this.appUrl + '/phantom/callback')}`;
  }

  createSession(userId) {
    const sessionId = bs58.encode(Buffer.from(`${userId}-${Date.now()}`)).substring(0, 20);
    const session = { id: sessionId, userId, createdAt: Date.now() };
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  validateSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  updateSessionWithWallet(sessionId, walletAddress, userId) {
    const session = this.sessions.get(sessionId) || { id: sessionId, userId };
    session.walletAddress = walletAddress;
    session.connectedAt = Date.now();
    this.sessions.set(sessionId, session);
    this.userSessions.set(userId, session);
    return session;
  }

  getSessionByUserId(userId) {
    return this.userSessions.get(userId);
  }
}

const phantom = new PhantomConnector({ appUrl: APP_URL });

// ============================================
// IN-MEMORY STATE
// ============================================

let currentPrice = 0;
let openPrice = 0;
let currentPoll = {
  pot: 0,
  stakes: [],
  startTime: Date.now(),
  endTime: Date.now() + 3600000,
  totalBets: 0,
  seedHash: null,
  serverSeed: null,
  clientSeed: null,
};

const pendingBets = new Map(); // userId -> { amount, choice, timestamp }
const pendingAmountInput = new Map(); // temp userId -> { choice, timeout }
const processedTxSignatures = new Set();
const userStats = new Map(); // userId -> { username, totalBets, totalWon, totalStaked, winStreak, bestStreak, xp, badges[] }

let jackpotAmountSOL = 0;
let jackpotHistory = [];
let lastJackpotWin = null;

let pollMessageId = null;
let pollChatId = null;
let leaderboardMessageId = null;
let leaderboardChatId = null;

const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

const userDailyStreak = new Map();
const DAILY_REWARDS = [0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.015];

const referralCodes = new Map();
const userReferrals = new Map(); // userId -> { referredBy, referrals: [] }

const ACHIEVEMENTS = {
  FIRST_BET:   { id: 'first_bet', name: '🎯 First Bet', xp: 10 },
  HOT_STREAK_5: { id: 'streak_5', name: '🔥 5 Wins Streak', xp: 50 },
  HOT_STREAK_10: { id: 'streak_10', name: '⚡ 10 Wins Streak', xp: 200 },
  WHALE:       { id: 'whale', name: '🐋 Whale', xp: 500 },
  JACKPOT:     { id: 'jackpot', name: '🎰 Jackpot Winner', xp: 1000 },
};

let tournamentActive = false;
let tournamentEndTime = 0;
const tournamentLeaderboard = new Map();

// ============================================
// LOGGER
// ============================================

const log = {
  info: (...a) => console.log(new Date().toISOString(), "ℹ️", ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "⚠️", ...a),
  error: (...a) => console.error(new Date().toISOString(), "❌", ...a),
  ok: (...a) => console.log(new Date().toISOString(), "✅", ...a),
  debug: (...a) => process.env.DEBUG ? console.log(new Date().toISOString(), "🔍", ...a) : null,
};

// ============================================
// KRAKEN WEBSOCKET - FIXED
// ============================================

let ws = null;

function connectPriceWebSocket() {
  try {
    if (ws) ws.terminate();
    ws = new WebSocket("wss://ws.kraken.com");

    ws.on("open", () => {
      log.ok("Kraken WebSocket connected");
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: ["SOL/USD"],
        subscription: { name: "ticker" }
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[1] && msg[1].c) {
          const price = parseFloat(msg[1].c[0]);
          if (!isNaN(price) && price > 0) {
            currentPrice = price;
          }
        }
      } catch (_) {}
    });

    ws.on("error", (err) => log.error("WebSocket error:", err.message));
    
    ws.on("close", () => {
      log.warn("WebSocket closed - reconnecting in 5s");
      setTimeout(connectPriceWebSocket, 5000);
    });
  } catch (err) {
    log.error("WebSocket creation failed:", err);
    setTimeout(connectPriceWebSocket, 5000);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getUserIdentifier(ctx) {
  return ctx.from?.id?.toString() || 'unknown';
}

function isValidSolanaAddress(address) {
  try { new PublicKey(address); return true; } catch { return false; }
}

async function checkBalance(address) {
  try {
    const publicKey = new PublicKey(address);
    const lamports = await connection.getBalance(publicKey);
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    return 0;
  }
}

function validateStakeAmount(input) {
  const cleaned = input.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(cleaned)) {
    return { valid: false, error: "Please enter a valid number" };
  }
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount < MIN_STAKE) {
    return { valid: false, error: `Minimum stake is ${MIN_STAKE} SOL` };
  }
  if (amount > MAX_STAKE) {
    return { valid: false, error: `Maximum stake is ${MAX_STAKE} SOL` };
  }
  return { valid: true, amount: Math.round(amount * 1e6) / 1e6 };
}

function formatPrice() {
  if (!currentPrice || currentPrice === 0) return "Loading...";
  return currentPrice.toFixed(4);
}

function getTimeRemaining() {
  const remaining = currentPoll.endTime - Date.now();
  if (remaining <= 0) return "Settling now";
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function generateReferralCode(userId) {
  return bs58.encode(Buffer.from(userId)).substring(0, 6);
}

function awardAchievement(userId, achievementId) {
  const stats = userStats.get(userId);
  if (!stats) return;
  if (!stats.badges) stats.badges = [];
  if (stats.badges.includes(achievementId)) return;
  stats.badges.push(achievementId);
  stats.xp = (stats.xp || 0) + (ACHIEVEMENTS[achievementId]?.xp || 0);
  userStats.set(userId, stats);
}

function getStreakMultiplier(userId) {
  const stats = userStats.get(userId);
  if (!stats) return 1;
  if (stats.winStreak >= 10) return 2.0;
  if (stats.winStreak >= 5) return 1.5;
  return 1.0;
}

// ============================================
// JACKPOT FUNCTIONS
// ============================================

function addToJackpot(amountSOL) {
  jackpotAmountSOL += amountSOL;
}

async function tryWinJackpot(userId, username, betAmount) {
  if (jackpotAmountSOL < 1) return null;
  const winChance = tournamentActive ? 0.002 : 0.001;
  if (Math.random() < winChance) {
    const winAmount = jackpotAmountSOL;
    jackpotAmountSOL = 0;
    jackpotHistory.unshift({ userId, username, amount: winAmount, timestamp: Date.now() });
    if (jackpotHistory.length > 10) jackpotHistory.pop();
    lastJackpotWin = { userId, username, amount: winAmount, timestamp: Date.now() };
    return winAmount;
  }
  return null;
}

// ============================================
// DAILY REWARDS
// ============================================

async function claimDailyReward(userId) {
  const now = Date.now();
  const entry = userDailyStreak.get(userId) || { streak: 0, lastClaim: 0 };
  const hoursSinceLast = (now - entry.lastClaim) / (1000 * 60 * 60);
  
  if (hoursSinceLast < 24) {
    return { success: false, hoursLeft: 24 - hoursSinceLast };
  }
  
  if (hoursSinceLast > 48) entry.streak = 0;
  entry.streak++;
  if (entry.streak > DAILY_REWARDS.length) entry.streak = DAILY_REWARDS.length;
  entry.lastClaim = now;
  userDailyStreak.set(userId, entry);
  
  const reward = DAILY_REWARDS[entry.streak - 1];
  return { success: true, reward, streak: entry.streak };
}

// ============================================
// TOURNAMENT MODE
// ============================================

function startTournament(durationHours = 24) {
  tournamentActive = true;
  tournamentEndTime = Date.now() + durationHours * 3600000;
  tournamentLeaderboard.clear();
  log.ok("🏆 Tournament started");
}

function endTournament() {
  tournamentActive = false;
  const sorted = [...tournamentLeaderboard.entries()].sort((a,b) => b[1] - a[1]).slice(0,3);
  let msg = `🏆 *Tournament Ended*\n\nTop 3 Winners:\n`;
  sorted.forEach(([userId, won], i) => {
    const username = userStats.get(userId)?.username || 'Unknown';
    msg += `${i+1}. ${username} – ${won.toFixed(4)} SOL\n`;
  });
  bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, msg, { parse_mode: "Markdown" }).catch(()=>{});
  tournamentLeaderboard.clear();
}

// ============================================
// MESSAGE BUILDERS
// ============================================

function buildLeaderboardMessage() {
  if (userStats.size === 0) {
    return "🏆 *LEADERBOARD*\n\nNo bets yet";
  }
  
  const sorted = [...userStats.entries()]
    .sort((a,b) => (b[1].totalWon || 0) - (a[1].totalWon || 0))
    .slice(0, 10);
  
  let msg = "🏆 *LEADERBOARD*\n\n";
  
  sorted.forEach(([uid, stats], i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
    msg += `${medal} *${stats.username || 'Anonymous'}*\n`;
    msg += `   Won: ${(stats.totalWon || 0).toFixed(4)} SOL\n`;
    msg += `   Bets: ${stats.totalBets || 0} | Streak: ${stats.winStreak || 0}\n`;
    if (stats.badges && stats.badges.length) {
      msg += `   Badges: ${stats.badges.map(b => ACHIEVEMENTS[b]?.name || b).join(' ')}\n`;
    }
  });
  
  msg += `\n🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL`;
  if (tournamentActive) msg += `\n🏆 *TOURNAMENT ACTIVE*`;
  return msg;
}

function buildPollMessage() {
  const priceStr = formatPrice();
  const timeLeft = getTimeRemaining();
  
  let msg = `🎰 *DEGEN ECHO HOURLY POLL*\n\n`;
  msg += `💰 SOL Price: *$${priceStr}*\n`;
  msg += `⏰ Time Left: *${timeLeft}*\n\n`;
  
  if (currentPoll.stakes.length === 0) {
    msg += `No stakes yet – be first!\n\n`;
  } else {
    const pump = currentPoll.stakes.filter(s => s.choice === 'pump').reduce((a,s) => a + s.amount, 0);
    const dump = currentPoll.stakes.filter(s => s.choice === 'dump').reduce((a,s) => a + s.amount, 0);
    const flat = currentPoll.stakes.filter(s => s.choice === 'stagnate').reduce((a,s) => a + s.amount, 0);
    
    const pumpCount = currentPoll.stakes.filter(s => s.choice === 'pump').length;
    const dumpCount = currentPoll.stakes.filter(s => s.choice === 'dump').length;
    const flatCount = currentPoll.stakes.filter(s => s.choice === 'stagnate').length;
    
    msg += `💰 *Pot:* ${currentPoll.pot.toFixed(6)} SOL\n`;
    msg += `🚀 PUMP: ${pump.toFixed(6)} (${pumpCount})\n`;
    msg += `📉 DUMP: ${dump.toFixed(6)} (${dumpCount})\n`;
    msg += `🟡 FLAT: ${flat.toFixed(6)} (${flatCount})\n\n`;
  }
  
  msg += `🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL\n`;
  msg += `💎 Min Stake: ${MIN_STAKE} SOL\n`;
  msg += `💰 *19% rake | 80% pot | 1% jackpot*`;
  
  return msg;
}

function getPollKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🚀 Pump", callback_data: "vote_pump" },
      { text: "📉 Dump", callback_data: "vote_dump" },
      { text: "🟡 Flat", callback_data: "vote_stagnate" },
    ]]
  };
}

async function updatePoll() {
  try {
    const msg = buildPollMessage();
    
    if (pollMessageId && pollChatId) {
      try {
        await bot.telegram.editMessageText(
          pollChatId,
          pollMessageId,
          undefined,
          msg,
          { parse_mode: 'Markdown', reply_markup: getPollKeyboard() }
        );
        return;
      } catch (editErr) {
        pollMessageId = null;
        pollChatId = null;
      }
    }
    
    const sent = await bot.telegram.sendMessage(
      LIVE_CHANNEL,
      msg,
      { parse_mode: 'Markdown', reply_markup: getPollKeyboard() }
    );
    pollMessageId = sent.message_id;
    pollChatId = sent.chat.id;
    
  } catch (err) {
    log.error('Poll error:', err.message);
  }
}

async function updateLeaderboard() {
  try {
    const msg = buildLeaderboardMessage();
    
    if (leaderboardMessageId && leaderboardChatId) {
      try {
        await bot.telegram.editMessageText(
          leaderboardChatId,
          leaderboardMessageId,
          undefined,
          msg,
          { parse_mode: 'Markdown' }
        );
        return;
      } catch (editErr) {
        leaderboardMessageId = null;
        leaderboardChatId = null;
      }
    }
    
    const sent = await bot.telegram.sendMessage(
      COMMUNITY_GROUP,
      msg,
      { parse_mode: 'Markdown' }
    );
    leaderboardMessageId = sent.message_id;
    leaderboardChatId = sent.chat.id;
    
  } catch (err) {
    log.error('Leaderboard error:', err.message);
  }
}

// ============================================
// PAYMENT PROCESSING
// ============================================

async function sendToRakeWallet(amount) {
  if (amount <= 0) return;
  
  try {
    const toPubkey = new PublicKey(RAKE_WALLET);
    const fromPubkey = botWallet.publicKey;
    
    const { blockhash } = await connection.getLatestBlockhash();
    
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );
    
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromPubkey;
    tx.sign(botWallet);
    
    await connection.sendRawTransaction(tx.serialize());
    log.ok(`💰 Sent ${amount.toFixed(6)} SOL to rake wallet`);
  } catch (err) {
    log.error("Send to rake wallet failed:", err);
  }
}

async function sendPayout(userId, amountSOL, reason) {
  const session = phantom.getSessionByUserId(userId);
  if (!session || !session.walletAddress) {
    log.warn(`Cannot payout user ${userId}: no wallet connected`);
    return null;
  }
  
  try {
    const toPubkey = new PublicKey(session.walletAddress);
    const fromPubkey = botWallet.publicKey;
    
    const { blockhash } = await connection.getLatestBlockhash();
    
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
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    log.ok(`💸 Paid ${amountSOL.toFixed(6)} SOL to user for ${reason}`);
    return signature;
  } catch (err) {
    log.error("Send payout failed:", err);
    return null;
  }
}

async function processBet(userId, amount, choice, signature) {
  const session = phantom.getSessionByUserId(userId);
  if (!session) return;
  
  const username = session.username || 'Anonymous';
  
  const rakeAmount = amount * RAKE_PERCENT;
  const potAmount = amount * POT_PERCENT;
  const jackpotAmount = amount * JACKPOT_PERCENT;
  
  currentPoll.pot += potAmount;
  currentPoll.stakes.push({
    userId, username, choice,
    amount: potAmount,
    timestamp: Date.now(),
    signature
  });
  currentPoll.totalBets++;
  
  addToJackpot(jackpotAmount);
  
  let stats = userStats.get(userId) || {
    username, totalBets: 0, totalWon: 0, totalStaked: 0, winStreak: 0, bestStreak: 0, xp: 0, badges: []
  };
  stats.username = username;
  stats.totalBets++;
  stats.totalStaked += amount;
  stats.xp += 10;
  userStats.set(userId, stats);
  
  if (stats.totalBets === 1) awardAchievement(userId, 'FIRST_BET');
  
  await sendToRakeWallet(rakeAmount);
  
  const jackpotWin = await tryWinJackpot(userId, username, amount);
  if (jackpotWin) {
    awardAchievement(userId, 'JACKPOT');
    await sendPayout(userId, jackpotWin, 'Jackpot Win');
  }
  
  if (tournamentActive) {
    const current = tournamentLeaderboard.get(userId) || 0;
    tournamentLeaderboard.set(userId, current + potAmount);
  }
  
  log.ok(`✅ Bet processed: ${amount} SOL from ${username}`);
}

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});

bot.catch((err, ctx) => {
  log.error("Bot error:", err.message);
});

// Rate limiting
bot.use((ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) return next();
  
  const now = Date.now();
  const entry = rateLimitMap.get(userId) || { count: 0, windowStart: now };
  
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  
  rateLimitMap.set(userId, entry);
  
  if (entry.count > RATE_LIMIT) {
    return ctx.reply("⏳ Slow down!").catch(()=>{});
  }
  
  return next();
});

// ============================================
// COMMANDS
// ============================================

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const name = ctx.from.first_name || "User";
  
  const args = ctx.message.text.split(' ');
  if (args.length > 1 && args[1].startsWith('ref_')) {
    const refCode = args[1].substring(4);
    const referrerId = referralCodes.get(refCode);
    if (referrerId && referrerId !== userId) {
      userReferrals.set(userId, { referredBy: referrerId, referrals: [] });
      const referrerStats = userStats.get(referrerId);
      if (referrerStats) {
        referrerStats.xp = (referrerStats.xp || 0) + 50;
        userStats.set(referrerId, referrerStats);
      }
    }
  }
  
  const session = phantom.getSessionByUserId(userId);
  
  let walletStatus = session?.walletAddress 
    ? `✅ Wallet connected: ${session.walletAddress.slice(0,6)}...${session.walletAddress.slice(-4)}`
    : "❌ Wallet not connected";
  
  ctx.reply(
    `🎰 *Welcome to Degen Echo, ${name}!*\n\n` +
    `${walletStatus}\n\n` +
    `*Commands:*\n` +
    `/connect - Connect Phantom wallet\n` +
    `/balance - Check balance\n` +
    `/leaderboard - View top players\n` +
    `/poll - Show current poll\n` +
    `/jackpot - Check jackpot\n` +
    `/daily - Claim daily reward\n` +
    `/ref - Get referral link\n` +
    `/stats - Your stats\n` +
    `/achievements - Your badges\n` +
    `/tournament - Tournament info\n` +
    `/help - Show all commands`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('connect', async (ctx) => {
  const userId = ctx.from.id.toString();
  const connectLink = phantom.generateConnectLink(userId);
  
  await ctx.reply(
    `🔌 *Connect Phantom Wallet*\n\n` +
    `Click the button below to open Phantom:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: "🔌 Connect Phantom", url: connectLink }
        ]]
      }
    }
  );
});

bot.command('balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = phantom.getSessionByUserId(userId);
  
  if (!session?.walletAddress) {
    return ctx.reply("❌ Wallet not connected. Use /connect first.");
  }
  
  const balance = await checkBalance(session.walletAddress);
  ctx.reply(
    `💰 *Wallet Balance*\n\n` +
    `Address: \`${session.walletAddress.slice(0,6)}...${session.walletAddress.slice(-4)}\`\n` +
    `Balance: ${balance.toFixed(6)} SOL`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('leaderboard', async (ctx) => {
  ctx.reply(buildLeaderboardMessage(), { parse_mode: 'Markdown' });
});

bot.command('poll', async (ctx) => {
  ctx.reply(buildPollMessage(), { 
    parse_mode: 'Markdown', 
    reply_markup: getPollKeyboard() 
  });
});

bot.command('jackpot', (ctx) => {
  let msg = `🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL\n`;
  if (lastJackpotWin) {
    const timeAgo = Math.floor((Date.now() - lastJackpotWin.timestamp) / 60000);
    msg += `\nLast winner: ${lastJackpotWin.username} (${timeAgo}m ago)`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('daily', async (ctx) => {
  const userId = ctx.from.id.toString();
  const result = await claimDailyReward(userId);
  
  if (result.success) {
    ctx.reply(`✅ *Daily Reward:* ${result.reward} SOL (Streak: ${result.streak})`, { parse_mode: 'Markdown' });
    await sendPayout(userId, result.reward, 'Daily reward');
  } else {
    ctx.reply(`⏳ Next daily in ${Math.ceil(result.hoursLeft)} hours`, { parse_mode: 'Markdown' });
  }
});

bot.command('ref', (ctx) => {
  const userId = ctx.from.id.toString();
  const code = generateReferralCode(userId);
  referralCodes.set(code, userId);
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${code}`;
  
  const referralData = userReferrals.get(userId);
  const referralCount = referralData?.referrals?.length || 0;
  
  ctx.reply(
    `🤝 *Your Referral Link*\n\n${link}\n\n` +
    `Referrals: ${referralCount}\n` +
    `Bonus: 50 XP per referral!`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', (ctx) => {
  const userId = ctx.from.id.toString();
  const stats = userStats.get(userId);
  
  if (!stats) return ctx.reply("No stats yet");
  
  const winRate = stats.totalBets ? ((stats.totalWon / stats.totalStaked) * 100).toFixed(1) : 0;
  ctx.reply(
    `📊 *Your Stats*\n\n` +
    `Bets: ${stats.totalBets}\n` +
    `Staked: ${stats.totalStaked.toFixed(4)} SOL\n` +
    `Won: ${stats.totalWon.toFixed(4)} SOL\n` +
    `Win Rate: ${winRate}%\n` +
    `Streak: ${stats.winStreak} (Best: ${stats.bestStreak})\n` +
    `XP: ${stats.xp || 0}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('achievements', (ctx) => {
  const userId = ctx.from.id.toString();
  const stats = userStats.get(userId);
  
  if (!stats || !stats.badges || stats.badges.length === 0) {
    return ctx.reply("No achievements yet. Place bets to earn badges!");
  }
  
  let msg = "🏅 *Your Achievements*\n\n";
  stats.badges.forEach(badgeId => {
    const badge = ACHIEVEMENTS[badgeId];
    if (badge) {
      msg += `${badge.name} (+${badge.xp} XP)\n`;
    }
  });
  
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('tournament', (ctx) => {
  if (tournamentActive) {
    const remaining = tournamentEndTime - Date.now();
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    ctx.reply(
      `🏆 *Tournament Active!*\n\n` +
      `Time left: ${hours}h ${minutes}m\n` +
      `Double jackpot chance!\n` +
      `Top winners will be announced at the end.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply("No tournament active currently.", { parse_mode: 'Markdown' });
  }
});

bot.command('help', (ctx) => {
  ctx.reply(
    `📋 *Commands*\n\n` +
    `/connect - Connect Phantom wallet\n` +
    `/balance - Check wallet balance\n` +
    `/leaderboard - View top players\n` +
    `/poll - Show current poll\n` +
    `/jackpot - Check jackpot\n` +
    `/daily - Claim daily reward\n` +
    `/ref - Get referral link\n` +
    `/stats - Your betting stats\n` +
    `/achievements - Your badges\n` +
    `/tournament - Tournament info\n` +
    `/cancel - Cancel pending bet`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancel', (ctx) => {
  const userId = ctx.from.id.toString();
  pendingAmountInput.delete(userId);
  pendingBets.delete(userId);
  ctx.reply("✅ Cancelled");
});

bot.command('debug', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id.toString())) return;
  
  const botBal = await checkBalance(botWallet.publicKey.toString());
  ctx.reply(
    `🔧 *Debug Info*\n\n` +
    `Bot balance: ${botBal.toFixed(6)} SOL\n` +
    `Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL\n` +
    `Users: ${userStats.size}\n` +
    `Price: $${formatPrice()}\n` +
    `Connected wallets: ${[...phantom.userSessions.values()].length}\n` +
    `Tournament: ${tournamentActive ? 'Active' : 'Inactive'}`,
    { parse_mode: 'Markdown' }
  );
});

// ============================================
// BUTTON HANDLER
// ============================================

bot.action(/^vote_(pump|dump|stagnate)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || 'Anonymous';
  const choice = ctx.match[1];
  
  const session = phantom.getSessionByUserId(userId);
  
  if (!session?.walletAddress) {
    const connectLink = phantom.generateConnectLink(userId);
    return ctx.reply(
      `🔌 *Connect Wallet First*\n\n` +
      `Click below to connect:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: "🔌 Connect", url: connectLink }
          ]]
        }
      }
    );
  }
  
  if (pendingAmountInput.has(userId) || pendingBets.has(userId)) {
    return ctx.reply("⚠️ You have a pending bet. Use /cancel first.");
  }
  
  const timeout = setTimeout(() => {
    pendingAmountInput.delete(userId);
    ctx.reply("⏱️ Timed out").catch(() => {});
  }, 60000);
  
  pendingAmountInput.set(userId, { choice, username, timeout });
  
  const emoji = { pump: '🚀', dump: '📉', stagnate: '🟡' }[choice];
  await ctx.reply(`${emoji} *${choice.toUpperCase()}*\n\nEnter amount in SOL (min ${MIN_STAKE}):`, { parse_mode: 'Markdown' });
});

// ============================================
// TEXT HANDLER
// ============================================

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  
  const userId = ctx.from.id.toString();
  const pending = pendingAmountInput.get(userId);
  
  if (!pending) return;
  
  const validation = validateStakeAmount(text);
  if (!validation.valid) {
    return ctx.reply(`❌ ${validation.error}. Try again:`);
  }
  
  const amount = validation.amount;
  clearTimeout(pending.timeout);
  pendingAmountInput.delete(userId);
  
  const session = phantom.getSessionByUserId(userId);
  if (!session?.walletAddress) {
    return ctx.reply("❌ Wallet not connected. Use /connect first.");
  }
  
  pendingBets.set(userId, { 
    amount, 
    choice: pending.choice,
    username: pending.username 
  });
  
  try {
    const txLink = await phantom.generateTransactionLink(
      userId,
      amount,
      pending.choice,
      session.walletAddress
    );
    
    const rakeAmount = amount * RAKE_PERCENT;
    const potAmount = amount * POT_PERCENT;
    const jackpotAmount = amount * JACKPOT_PERCENT;
    
    await ctx.reply(
      `💳 *Approve Transaction*\n\n` +
      `Amount: ${amount} SOL\n` +
      `Choice: ${pending.choice.toUpperCase()}\n\n` +
      `Breakdown:\n` +
      `Rake (19%): ${rakeAmount.toFixed(6)} SOL\n` +
      `Pot (80%): ${potAmount.toFixed(6)} SOL\n` +
      `Jackpot (1%): ${jackpotAmount.toFixed(6)} SOL\n\n` +
      `Click below to approve in Phantom:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: "💎 Approve", url: txLink }
          ]]
        }
      }
    );
    
  } catch (err) {
    log.error("Transaction error:", err);
    pendingBets.delete(userId);
    ctx.reply("❌ Error creating transaction");
  }
});

// ============================================
// HOURLY SETTLEMENT
// ============================================

async function settleHour() {
  log.info('⏰ Hourly settlement started');
  
  if (currentPoll.stakes.length === 0) {
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, '⏰ No bets this hour').catch(()=>{});
  } else {
    let winnerChoice;
    if (currentPrice > openPrice * 1.001) winnerChoice = 'pump';
    else if (currentPrice < openPrice * 0.999) winnerChoice = 'dump';
    else winnerChoice = 'stagnate';
    
    const winners = currentPoll.stakes.filter(s => s.choice === winnerChoice);
    const totalPot = currentPoll.pot;
    const totalWinningAmount = winners.reduce((a,s) => a + s.amount, 0);
    
    let paidCount = 0;
    let paidAmount = 0;
    
    for (const w of winners) {
      const share = w.amount / totalWinningAmount;
      const payout = totalPot * share;
      const multiplier = getStreakMultiplier(w.userId);
      const finalPayout = payout * multiplier;
      
      const sig = await sendPayout(w.userId, finalPayout, 'Hourly win');
      if (sig) {
        paidCount++;
        paidAmount += finalPayout;
        
        const stats = userStats.get(w.userId);
        if (stats) {
          stats.totalWon += finalPayout;
          stats.winStreak = (stats.winStreak || 0) + 1;
          if (stats.winStreak > (stats.bestStreak || 0)) stats.bestStreak = stats.winStreak;
          stats.xp += 50;
          userStats.set(w.userId, stats);
        }
        
        if (stats?.winStreak >= 5) awardAchievement(w.userId, 'HOT_STREAK_5');
        if (stats?.winStreak >= 10) awardAchievement(w.userId, 'HOT_STREAK_10');
        
        if (tournamentActive) {
          const curr = tournamentLeaderboard.get(w.userId) || 0;
          tournamentLeaderboard.set(w.userId, curr + finalPayout);
        }
      }
    }
    
    const losers = currentPoll.stakes.filter(s => s.choice !== winnerChoice);
    for (const l of losers) {
      const stats = userStats.get(l.userId);
      if (stats) stats.winStreak = 0;
    }
    
    const resultMsg = 
      `⏰ *Hourly Results*\n\n` +
      `Winner: *${winnerChoice.toUpperCase()}*\n` +
      `Pot: ${totalPot.toFixed(6)} SOL\n` +
      `Winners: ${paidCount}\n` +
      `Paid: ${paidAmount.toFixed(6)} SOL\n` +
      `🎰 Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL`;
    
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, resultMsg, { parse_mode: 'Markdown' }).catch(()=>{});
    log.ok(`Hourly settlement complete: ${paidCount} winners, ${paidAmount.toFixed(6)} SOL paid`);
  }
  
  currentPoll = {
    pot: 0,
    stakes: [],
    startTime: Date.now(),
    endTime: Date.now() + 3600000,
    totalBets: 0,
  };
  openPrice = currentPrice;
  
  await updatePoll();
  await updateLeaderboard();
  
  if (tournamentActive && Date.now() >= tournamentEndTime) {
    endTournament();
  }
}

// ============================================
// EXPRESS SERVER
// ============================================

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Degen Echo Bot Running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    users: userStats.size,
    jackpot: jackpotAmountSOL,
    price: currentPrice,
    connectedWallets: [...phantom.userSessions.values()].length,
    tournament: tournamentActive
  });
});

app.get('/phantom/callback', async (req, res) => {
  const { session: sessionId, public_key, transaction_signature, error } = req.query;
  
  log.info('Phantom callback:', { sessionId, public_key, transaction_signature, error });
  
  if (public_key) {
    const session = phantom.validateSession(sessionId);
    if (session) {
      phantom.updateSessionWithWallet(sessionId, public_key, session.userId);
      log.ok(`✅ Wallet connected for user ${session.userId}`);
    }
  }
  
  if (transaction_signature && sessionId) {
    const session = phantom.validateSession(sessionId);
    if (session) {
      const bet = pendingBets.get(session.userId);
      if (bet) {
        await processBet(session.userId, bet.amount, bet.choice, transaction_signature);
        pendingBets.delete(session.userId);
        
        try {
          const emoji = { pump: '🚀', dump: '📉', stagnate: '🟡' }[bet.choice];
          await bot.telegram.sendMessage(
            session.userId,
            `${emoji} *Bet Confirmed!*\n\n` +
            `Amount: ${bet.amount} SOL\n` +
            `Choice: ${bet.choice.toUpperCase()}\n` +
            `TX: \`${transaction_signature.slice(0,8)}...\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          log.error('Failed to send confirmation:', err);
        }
        
        log.ok(`✅ Bet confirmed for user ${session.userId}`);
      }
    }
  }
  
  res.send(`
    <html>
      <body>
        <script>
          window.close();
          window.location.href = 'tg://resolve?domain=${bot.botInfo.username}';
        </script>
        <p>Success! You can close this window.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  log.ok(`🚀 Server running on port ${PORT}`);
});

// ============================================
// CRON JOBS
// ============================================

cron.schedule('0 * * * *', settleHour);
cron.schedule('*/30 * * * * *', updatePoll);
cron.schedule('*/5 * * * *', updateLeaderboard);

cron.schedule('* * * * *', () => {
  if (tournamentActive && Date.now() >= tournamentEndTime) {
    endTournament();
  }
});

cron.schedule('0 0 * * *', () => {
  if (processedTxSignatures.size > 1000) {
    const toDelete = Array.from(processedTxSignatures).slice(0, 500);
    toDelete.forEach(sig => processedTxSignatures.delete(sig));
  }
});

// ============================================
// STARTUP
// ============================================

async function startup() {
  log.info("Starting up...");
  
  connectPriceWebSocket();
  
  for (let i = 0; i < 15; i++) {
    if (currentPrice > 0) {
      log.ok(`✅ Price received: $${currentPrice.toFixed(4)}`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  
  if (currentPrice <= 0) {
    currentPrice = 20;
    log.warn("Using fallback price: $20");
  }
  
  openPrice = currentPrice;
  await updatePoll();
  await updateLeaderboard();
  
  log.ok("✅ Bot startup complete!");
}

// ============================================
// LAUNCH
// ============================================

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    log.ok("🤖 Bot is live!");
    startup();
  })
  .catch(err => {
    log.error("Launch failed:", err);
    process.exit(1);
  });

["SIGINT", "SIGTERM"].forEach(sig => {
  process.once(sig, () => {
    log.info("Shutting down...");
    bot.stop(sig);
    if (ws) ws.close();
    process.exit(0);
  });
});
