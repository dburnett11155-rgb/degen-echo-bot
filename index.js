"use strict";

/**
 * DEGEN ECHO – COMPLETE PRODUCTION BOT
 * One global poll per hour
 * 19% Rake | 80% Pot | 1% Jackpot
 * Phantom wallet integration - FULL VERSION
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
const axios = require("axios");
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
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 5000;
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
  console.log("✅ Solana connection established:", SOLANA_RPC);
} catch (err) {
  console.error("❌ Failed to connect to Solana:", err.message);
  process.exit(1);
}

let botWallet;
try {
  const secretKey = bs58.decode(BOT_PRIVATE_KEY);
  botWallet = Keypair.fromSecretKey(secretKey);
  console.log("✅ Bot wallet loaded:", botWallet.publicKey.toString());
  
  connection.getBalance(botWallet.publicKey).then(balance => {
    const solBalance = balance / LAMPORTS_PER_SOL;
    console.log(`💰 Bot wallet balance: ${solBalance.toFixed(6)} SOL`);
    if (solBalance < 0.1) {
      console.warn("⚠️ Bot wallet balance low - add SOL for transaction fees");
    }
  });
} catch (err) {
  console.error("❌ Failed to load bot wallet:", err.message);
  process.exit(1);
}

// ============================================
// PHANTOM WALLET CONNECTOR - FIXED VERSION
// ============================================

class PhantomConnector {
  constructor(config) {
    this.appUrl = config.appUrl;
    this.dappKey = 'degen-echo-bot';
    this.sessionSecret = config.sessionSecret;
    this.sessions = new Map(); // sessionId -> session data
    this.userSessions = new Map(); // userId -> session
    console.log("✅ Phantom connector initialized with URL:", this.appUrl);
  }

  generateConnectLink(userId) {
    const sessionId = this.createSession(userId);
    const redirectUrl = encodeURIComponent(`${this.appUrl}/phantom/callback`);
    
    // Fixed: Added all required parameters
    return `https://phantom.app/ul/v1/connect?app_url=${redirectUrl}&dapp_key=${this.dappKey}&session=${sessionId}&redirect_url=${redirectUrl}&cluster=mainnet-beta`;
  }

  async generateTransactionLink(userId, amount, choice, walletAddress) {
    const session = this.userSessions.get(userId);
    if (!session || !session.walletAddress) {
      throw new Error('Wallet not connected');
    }

    // Create Solana transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(session.walletAddress),
        toPubkey: new PublicKey(RAKE_WALLET),
        lamports: Math.floor(amount * LAMPORTS_PER_SOL)
      })
    );

    // Add memo with bet choice
    const memoInstruction = {
      keys: [{ pubkey: new PublicKey(session.walletAddress), isSigner: true, isWritable: true }],
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      data: Buffer.from(`bet:${choice}:${userId}:${Date.now()}`)
    };
    transaction.add(memoInstruction);

    // Serialize transaction
    const serializedTx = bs58.encode(transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    }));

    const redirectUrl = encodeURIComponent(`${this.appUrl}/phantom/callback`);
    
    // Fixed: Added cluster parameter
    return `https://phantom.app/ul/v1/signAndSendTransaction?transaction=${serializedTx}&session=${session.id}&app_url=${redirectUrl}&dapp_key=${this.dappKey}&redirect_url=${redirectUrl}&cluster=mainnet-beta`;
  }

  createSession(userId) {
    const sessionId = bs58.encode(Buffer.from(`${userId}-${Date.now()}-${Math.random()}`)).substring(0, 20);
    const session = {
      id: sessionId,
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
    };
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  validateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) {
      return null;
    }
    return session;
  }

  updateSessionWithWallet(sessionId, walletAddress, userId) {
    const session = this.sessions.get(sessionId) || { id: sessionId, userId };
    session.walletAddress = walletAddress;
    session.connectedAt = Date.now();
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    this.sessions.set(sessionId, session);
    this.userSessions.set(userId, session);
    return session;
  }

  getSessionByUserId(userId) {
    return this.userSessions.get(userId);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(key);
        if (session.userId) {
          this.userSessions.delete(session.userId);
        }
      }
    }
  }
}

// Initialize Phantom connector
const phantom = new PhantomConnector({
  appUrl: APP_URL,
  sessionSecret: SESSION_SECRET
});

// ============================================
// IN-MEMORY STATE
// ============================================

let currentPrice = 0;
let openPrice = 0;
let currentPoll = {
  pot: 0,
  stakes: [],
  startTime: Date.now(),
  endTime: Date.now() + 3600000, // 1 hour
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

// We'll store message IDs but handle errors gracefully
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
// KRAKEN WEBSOCKET - FIXED PRICE DISPLAY
// ============================================

let ws = null;
let wsReconnectDelay = 2000;

function connectPriceWebSocket() {
  try {
    if (ws) ws.terminate();
    ws = new WebSocket("wss://ws.kraken.com");

    ws.on("open", () => {
      log.ok("Kraken WebSocket connected - REAL-TIME PRICES ACTIVE");
      wsReconnectDelay = 2000;
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: [CURRENT_COIN],
        subscription: { name: "ticker" },
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[1]?.c) {
          const pair = msg[3];
          const price = parseFloat(msg[1].c[0]);
          if (pair === CURRENT_COIN && !isNaN(price) && price > 0) {
            currentPrice = price;
          }
        }
      } catch (_) {}
    });

    ws.on("error", (err) => log.error("WebSocket error:", err.message));
    
    ws.on("close", () => {
      log.warn(`WebSocket closed – reconnecting in ${wsReconnectDelay}ms`);
      setTimeout(connectPriceWebSocket, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
    });
  } catch (err) {
    log.error("WebSocket creation failed:", err.message);
    setTimeout(connectPriceWebSocket, wsReconnectDelay);
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

// FIXED: Price formatter that shows actual number
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
    if (stats.badges && stats.badges.length) {
      msg += `   Badges: ${stats.badges.map(b => ACHIEVEMENTS[b]?.name || b).join(' ')}\n`;
    }
  });
  
  msg += `\n🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL`;
  if (tournamentActive) msg += `\n🏆 *TOURNAMENT ACTIVE*`;
  return msg;
}

// FIXED: Shows actual price, not "kraken" text
function buildPollMessage() {
  const coin = CURRENT_COIN.replace("/USD", "");
  const priceStr = formatPrice();
  const timeLeft = getTimeRemaining();
  
  let msg = `🎰 *DEGEN ECHO HOURLY POLL* – $${coin}\n`;
  msg += `💰 *Current Price:* $${priceStr}\n`;
  msg += `⏰ *Time Left:* ${timeLeft}\n\n`;
  
  if (currentPoll.stakes.length === 0) {
    msg += `_No stakes yet – be first!_\n\n`;
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
  msg += `💎 *Min Stake:* ${MIN_STAKE} SOL\n`;
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

// FIXED: Handle chat not found errors gracefully
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
        if (editErr.message.includes('chat not found') || editErr.message.includes('message to edit not found')) {
          // Message or chat doesn't exist anymore - will send new one
          pollMessageId = null;
          pollChatId = null;
        } else if (!editErr.message.includes('message is not modified')) {
          log.debug('Poll edit error:', editErr.message);
        }
      }
    }
    
    // Send new message
    const sent = await bot.telegram.sendMessage(
      LIVE_CHANNEL,
      msg,
      { parse_mode: 'Markdown', reply_markup: getPollKeyboard() }
    );
    pollMessageId = sent.message_id;
    pollChatId = sent.chat.id;
    
  } catch (err) {
    log.error('updatePoll error:', err.message);
    
    // Try community group as fallback
    if (err.message.includes('chat not found')) {
      try {
        const sent = await bot.telegram.sendMessage(
          COMMUNITY_GROUP,
          msg,
          { parse_mode: 'Markdown', reply_markup: getPollKeyboard() }
        );
        pollMessageId = sent.message_id;
        pollChatId = sent.chat.id;
      } catch (fallbackErr) {
        log.error('Fallback also failed:', fallbackErr.message);
      }
    }
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
        if (editErr.message.includes('chat not found') || editErr.message.includes('message to edit not found')) {
          leaderboardMessageId = null;
          leaderboardChatId = null;
        }
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
    log.error('updateLeaderboard error:', err.message);
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
    
    const balance = await connection.getBalance(fromPubkey);
    if (balance < amount * LAMPORTS_PER_SOL + 5000) {
      log.warn(`Insufficient balance to send ${amount} SOL to rake wallet`);
      return;
    }
    
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    
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
    
    const signature = await connection.sendRawTransaction(tx.serialize());
    log.ok(`💰 Sent ${amount.toFixed(6)} SOL to rake wallet: ${signature.slice(0,8)}...`);
  } catch (err) {
    log.error('sendToRakeWallet failed:', err.message);
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
    
    const balance = await connection.getBalance(fromPubkey);
    if (balance < amountSOL * LAMPORTS_PER_SOL + 5000) {
      log.warn(`Insufficient balance to pay ${amountSOL} SOL`);
      return null;
    }
    
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    
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
    log.error('sendPayout failed:', err.message);
    return null;
  }
}

async function processBet(userId, amount, choice, signature) {
  const session = phantom.getSessionByUserId(userId);
  if (!session) {
    log.error(`No session for user ${userId}`);
    return;
  }
  
  const username = session.username || 'Anonymous';
  
  // Calculate splits
  const rakeAmount = amount * RAKE_PERCENT;
  const potAmount = amount * POT_PERCENT;
  const jackpotAmount = amount * JACKPOT_PERCENT;
  
  // Update poll
  currentPoll.pot += potAmount;
  currentPoll.stakes.push({
    userId, username, choice,
    amount: potAmount,
    timestamp: Date.now(),
    signature
  });
  currentPoll.totalBets++;
  
  // Add to jackpot
  addToJackpot(jackpotAmount);
  
  // Update user stats
  let stats = userStats.get(userId) || {
    username, totalBets: 0, totalWon: 0, totalStaked: 0, winStreak: 0, bestStreak: 0, xp: 0, badges: []
  };
  stats.username = username;
  stats.totalBets++;
  stats.totalStaked += amount;
  stats.xp += 10;
  userStats.set(userId, stats);
  
  // Check for first bet achievement
  if (stats.totalBets === 1) awardAchievement(userId, 'FIRST_BET');
  
  // Send rake to your wallet
  await sendToRakeWallet(rakeAmount);
  
  // Check for jackpot win
  const jackpotWin = await tryWinJackpot(userId, username, amount);
  if (jackpotWin) {
    awardAchievement(userId, 'JACKPOT');
    await sendPayout(userId, jackpotWin, 'Jackpot Win');
  }
  
  // Update tournament leaderboard
  if (tournamentActive) {
    const current = tournamentLeaderboard.get(userId) || 0;
    tournamentLeaderboard.set(userId, current + potAmount);
  }
  
  log.ok(`✅ Bet processed: ${amount} SOL from ${username}`);
  
  return { potAmount, jackpotWin };
}

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});

bot.catch((err, ctx) => {
  log.error('Telegraf error:', err.message);
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
    return ctx.reply('⏳ Slow down!').catch(()=>{});
  }
  
  return next();
});

// ============================================
// COMMANDS
// ============================================

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const name = ctx.from.first_name || 'User';
  
  // Check for referral
  const args = ctx.message.text.split(' ');
  if (args.length > 1 && args[1].startsWith('ref_')) {
    const refCode = args[1].substring(4);
    referralCodes.set(refCode, userId);
  }
  
  const session = phantom.getSessionByUserId(userId);
  
  let walletStatus = session?.walletAddress 
    ? `✅ Wallet connected: ${session.walletAddress.slice(0,6)}...${session.walletAddress.slice(-4)}`
    : '❌ Wallet not connected';
  
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
    `/help - Show all commands`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('connect', async (ctx) => {
  const userId = ctx.from.id.toString();
  const connectLink = phantom.generateConnectLink(userId);
  
  await ctx.reply(
    `🔌 *Connect Your Phantom Wallet*\n\n` +
    `Click the button below to open Phantom and connect:\n\n` +
    `[Open Phantom](${connectLink})`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔌 Connect Phantom', url: connectLink }
        ]]
      }
    }
  );
});

bot.command('balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = phantom.getSessionByUserId(userId);
  
  if (!session?.walletAddress) {
    return ctx.reply('❌ Wallet not connected. Use /connect first.');
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
  ctx.reply(`🎰 *Jackpot:* ${jackpotAmountSOL.toFixed(4)} SOL`, { parse_mode: 'Markdown' });
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
  ctx.reply(
    `🤝 *Your Referral Link*\n\n${link}\n\n` +
    `Share this with friends!`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', (ctx) => {
  const userId = ctx.from.id.toString();
  const stats = userStats.get(userId);
  
  if (!stats) return ctx.reply('No stats yet');
  
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
    `/cancel - Cancel pending bet`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id.toString();
  
  // Check for pending amount input
  if (pendingAmountInput.has(userId)) {
    clearTimeout(pendingAmountInput.get(userId).timeout);
    pendingAmountInput.delete(userId);
  }
  
  // Check for pending bet
  if (pendingBets.has(userId)) {
    pendingBets.delete(userId);
  }
  
  ctx.reply('✅ Pending bet cancelled');
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
    `Connected wallets: ${[...phantom.userSessions.values()].length}`,
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
  
  // Check if wallet is connected
  const session = phantom.getSessionByUserId(userId);
  
  if (!session?.walletAddress) {
    const connectLink = phantom.generateConnectLink(userId);
    return ctx.reply(
      `🔌 *Connect Wallet First*\n\n` +
      `[Click here to connect](${connectLink})`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔌 Connect Phantom', url: connectLink }
          ]]
        }
      }
    );
  }
  
  // Check for existing pending
  if (pendingBets.has(userId) || pendingAmountInput.has(userId)) {
    return ctx.reply('⚠️ You have a pending bet. Use /cancel first.');
  }
  
  // Set timeout for amount input
  const timeout = setTimeout(() => {
    if (pendingAmountInput.has(userId)) {
      pendingAmountInput.delete(userId);
      ctx.reply('⏱️ Timed out').catch(() => {});
    }
  }, 60000);
  
  pendingAmountInput.set(userId, {
    userId,
    username,
    choice,
    timeout
  });
  
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
    return ctx.reply('❌ Wallet not connected. Use /connect first.');
  }
  
  // Store bet for processing after confirmation
  pendingBets.set(userId, {
    userId,
    username: pending.username,
    choice: pending.choice,
    amount,
    timestamp: Date.now()
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
      `💳 *Approve Transaction in Phantom*\n\n` +
      `Amount: ${amount} SOL\n` +
      `Choice: ${pending.choice.toUpperCase()}\n\n` +
      `Breakdown:\n` +
      `Rake (19%): ${rakeAmount.toFixed(6)} SOL\n` +
      `Pot (80%): ${potAmount.toFixed(6)} SOL\n` +
      `Jackpot (1%): ${jackpotAmount.toFixed(6)} SOL\n\n` +
      `Click below to open Phantom:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '💎 Approve', url: txLink }
          ]]
        }
      }
    );
    
  } catch (err) {
    log.error('Transaction error:', err);
    pendingBets.delete(userId);
    ctx.reply('❌ Error creating transaction');
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
    // Determine winner based on price movement
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
    
    // Reset losers' streaks
    const losers = currentPoll.stakes.filter(s => s.choice !== winnerChoice);
    for (const l of losers) {
      const stats = userStats.get(l.userId);
      if (stats) {
        stats.winStreak = 0;
        userStats.set(l.userId, stats);
      }
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
  
  // Reset for next hour
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
  
  // Check tournament end
  if (tournamentActive && Date.now() >= tournamentEndTime) {
    endTournament();
  }
}

// ============================================
// EXPRESS SERVER WITH PHANTOM CALLBACK
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
    connectedWallets: [...phantom.userSessions.values()].length
  });
});

app.get('/phantom/callback', async (req, res) => {
  const { session: sessionId, public_key, transaction_signature, error } = req.query;
  
  log.debug('Phantom callback received:', { sessionId, public_key, transaction_signature, error });
  
  if (error) {
    log.warn(`Phantom callback error: ${error}`);
    return res.send(`
      <html>
        <head><title>Degen Echo</title></head>
        <body>
          <script>
            window.close();
            window.location.href = 'tg://resolve?domain=${bot.botInfo.username}';
          </script>
          <p>Transaction cancelled. You can close this window.</p>
        </body>
      </html>
    `);
  }
  
  // Handle wallet connection
  if (public_key) {
    const session = phantom.validateSession(sessionId);
    if (session) {
      phantom.updateSessionWithWallet(sessionId, public_key, session.userId);
      
      try {
        await bot.telegram.sendMessage(
          session.userId,
          `✅ *Wallet Connected Successfully!*\n\n` +
          `Address: \`${public_key.slice(0,6)}...${public_key.slice(-4)}\`\n` +
          `You can now place bets with one tap! 🚀`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        log.error('Failed to notify user:', err);
      }
      
      log.ok(`Wallet connected for user ${session.userId}`);
    }
  }
  
  // Handle transaction confirmation
  if (transaction_signature) {
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
            `TX: \`${transaction_signature.slice(0,8)}...\`\n\n` +
            `Good luck! 🍀`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          log.error('Failed to send confirmation:', err);
        }
        
        log.ok(`Transaction confirmed for user ${session.userId}`);
      }
    }
  }
  
  res.send(`
    <html>
      <head><title>Degen Echo</title></head>
      <body>
        <script>
          window.close();
          window.location.href = 'tg://resolve?domain=${bot.botInfo.username}';
        </script>
        <p>Success! You can close this window and return to Telegram.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  log.ok(`🚀 Server running on port ${PORT}`);
  log.ok(`📱 Phantom callback URL: ${APP_URL}/phantom/callback`);
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

cron.schedule('0 * * * *', () => {
  phantom.cleanup();
  log.debug('Cleaned up expired sessions');
});

cron.schedule('0 0 * * *', () => {
  if (processedTxSignatures.size > 1000) {
    const toDelete = Array.from(processedTxSignatures).slice(0, 500);
    toDelete.forEach(sig => processedTxSignatures.delete(sig));
    log.debug(`Cleaned ${toDelete.length} old transaction signatures`);
  }
});

// ============================================
// STARTUP
// ============================================

async function startup() {
  log.info('🚀 Starting up Degen Echo Bot...');
  
  // Wait for price feed
  for (let i = 0; i < 30; i++) {
    if (currentPrice > 0) break;
    await new Promise(r => setTimeout(r, 2000));
    log.info(`Waiting for price feed... (${i+1}/30)`);
  }
  
  if (currentPrice <= 0) {
    currentPrice = 20;
    log.warn('Using fallback price: $20');
  }
  
  openPrice = currentPrice;
  log.ok(`✅ Current price: $${currentPrice.toFixed(4)}`);
  
  // Start WebSocket
  connectPriceWebSocket();
  
  // Create initial poll
  await updatePoll();
  await updateLeaderboard();
  
  // Start weekend tournament if applicable
  const now = new Date();
  if (now.getDay() === 5 && now.getHours() === 20) {
    startTournament(48);
    log.ok('🏆 Weekend tournament started');
  }
  
  log.ok('✅ Bot startup complete!');
  log.ok(`💰 Rake wallet: ${RAKE_WALLET.slice(0,8)}...${RAKE_WALLET.slice(-8)}`);
  log.ok(`🤖 Bot wallet: ${botWallet.publicKey.toString().slice(0,8)}...${botWallet.publicKey.toString().slice(-8)}`);
}

// ============================================
// LAUNCH BOT
// ============================================

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    log.ok('🤖 Telegram bot connected!');
    startup();
  })
  .catch((err) => {
    log.error('❌ Bot launch failed:', err);
    process.exit(1);
  });

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.once(sig, () => {
    log.info(`🛑 Shutting down on ${sig}...`);
    bot.stop(sig);
    if (ws) ws.close();
    setTimeout(() => process.exit(0), 2000);
  });
});
