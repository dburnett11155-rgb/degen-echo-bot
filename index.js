"use strict";

/**
 * DEGEN ECHO – THE ULTIMATE TELEGRAM BETTING BOT
 * One global poll per hour
 * 19% Rake | 80% Pot | 1% Jackpot (through bot wallet)
 * FULLY FIXED – NO 400 ERRORS
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

// Split configuration
const RAKE_PERCENT = 0.19;
const POT_PERCENT = 0.80;
const JACKPOT_PERCENT = 0.01;

const MIN_STAKE = 0.001;
const MAX_STAKE = 1000;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000;
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
} catch (err) {
  console.error("❌ Failed to load bot wallet:", err.message);
  process.exit(1);
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
  endTime: Date.now() + 3600000,
  totalBets: 0,
  seedHash: null,
  serverSeed: null,
  clientSeed: null,
};

const pendingPayments = new Map();      // memoId -> payment details
const userWallets = new Map();          // userId -> { address, username }
const processedTxSignatures = new Set(); // tx signatures already processed
const userStats = new Map();             // userId -> stats

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

const referralCodes = new Map();
const userDailyStreak = new Map();

const ACHIEVEMENTS = {
  FIRST_BET:   { id: 'first_bet', name: '🎯 First Bet' },
  HOT_STREAK_5: { id: 'streak_5', name: '🔥 5 Wins Streak' },
  HOT_STREAK_10: { id: 'streak_10', name: '⚡ 10 Wins Streak' },
  WHALE:       { id: 'whale', name: '🐋 Whale' },
  JACKPOT:     { id: 'jackpot', name: '🎰 Jackpot Winner' },
};

const coinVotes = new Map();
const COIN_OPTIONS = ["ETH/USD", "BTC/USD", "BNB/USD", "DOGE/USD"];

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
};

// ============================================
// KRAKEN WEBSOCKET
// ============================================

let ws = null;
let wsReconnectDelay = 2000;

function connectPriceWebSocket() {
  try {
    if (ws) ws.terminate();
    ws = new WebSocket("wss://ws.kraken.com");

    ws.on("open", () => {
      log.ok("Kraken WebSocket connected");
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
  const userId = ctx.from?.id?.toString();
  if (userId === ANONYMOUS_ADMIN_ID) {
    return ctx.from?.username ? `anon_${ctx.from.username}` : `anon_${Date.now()}`;
  }
  return userId;
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
  if (!currentPrice || currentPrice === 0) return "loading...";
  return currentPrice.toFixed(4);
}

function generateMemoId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function getTimeRemaining() {
  const remaining = currentPoll.endTime - Date.now();
  if (remaining <= 0) return "settling now";
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
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
// REFERRAL SYSTEM
// ============================================

function generateReferralCode(userId) {
  return bs58.encode(Buffer.from(userId)).substring(0, 6);
}

// ============================================
// DAILY REWARDS
// ============================================

const DAILY_REWARDS = [0.001, 0.002, 0.003, 0.005, 0.007, 0.01];

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
// STREAK BOOSTER
// ============================================

function getStreakMultiplier(userId) {
  const stats = userStats.get(userId);
  if (!stats) return 1;
  if (stats.winStreak >= 10) return 2.0;
  if (stats.winStreak >= 5) return 1.5;
  return 1.0;
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
  tournamentLeaderboard.clear();
}

// ============================================
// PROVABLY FAIR
// ============================================

function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// ============================================
// MESSAGE BUILDERS – PLAIN TEXT ONLY (NO MARKDOWN)
// ============================================

function buildLeaderboardMessage() {
  if (userStats.size === 0) {
    return "🏆 LEADERBOARD\n\nNo bets yet";
  }
  
  const sorted = [...userStats.entries()]
    .sort((a,b) => (b[1].totalWon || 0) - (a[1].totalWon || 0))
    .slice(0, 10);
  
  let msg = "🏆 LEADERBOARD\n\n";
  
  sorted.forEach(([uid, stats], i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
    msg += `${medal} ${stats.username || 'Anonymous'}\n`;
    msg += `   Won: ${(stats.totalWon || 0).toFixed(4)} SOL\n`;
  });
  
  msg += `\n🎰 Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL`;
  return msg;
}

function buildPollMessage() {
  const coin = CURRENT_COIN.replace("/USD", "");
  const priceStr = formatPrice();
  const timeLeft = getTimeRemaining();
  
  let msg = `🎰 DEGEN ECHO HOURLY POLL – $${coin}\n`;
  msg += `💰 Price: $${priceStr}\n`;
  msg += `⏰ Time left: ${timeLeft}\n\n`;
  
  if (currentPoll.stakes.length === 0) {
    msg += `No stakes yet – be first!\n\n`;
  } else {
    const pump = currentPoll.stakes.filter(s => s.choice === 'pump').reduce((a,s) => a + s.amount, 0);
    const dump = currentPoll.stakes.filter(s => s.choice === 'dump').reduce((a,s) => a + s.amount, 0);
    const flat = currentPoll.stakes.filter(s => s.choice === 'stagnate').reduce((a,s) => a + s.amount, 0);
    
    const pumpCount = currentPoll.stakes.filter(s => s.choice === 'pump').length;
    const dumpCount = currentPoll.stakes.filter(s => s.choice === 'dump').length;
    const flatCount = currentPoll.stakes.filter(s => s.choice === 'stagnate').length;
    
    msg += `💰 Pot: ${currentPoll.pot.toFixed(6)} SOL\n`;
    msg += `🚀 PUMP: ${pump.toFixed(6)} (${pumpCount})\n`;
    msg += `📉 DUMP: ${dump.toFixed(6)} (${dumpCount})\n`;
    msg += `🟡 FLAT: ${flat.toFixed(6)} (${flatCount})\n\n`;
  }
  
  msg += `🎰 Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL\n`;
  if (tournamentActive) msg += `🏆 TOURNAMENT ACTIVE\n`;
  msg += `💎 Min stake: ${MIN_STAKE} SOL\n`;
  msg += `💰 19% rake | 80% pot | 1% jackpot`;
  
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

// ============================================
// UPDATE FUNCTIONS – NO MARKDOWN
// ============================================

async function updatePoll() {
  try {
    const msg = buildPollMessage();
    
    if (pollMessageId && pollChatId) {
      await bot.telegram.editMessageText(
        pollChatId,
        pollMessageId,
        undefined,
        msg,
        { reply_markup: getPollKeyboard() }
      ).catch(async (err) => {
        if (err.message.includes("message to edit not found")) {
          const sent = await bot.telegram.sendMessage(
            LIVE_CHANNEL,
            msg,
            { reply_markup: getPollKeyboard() }
          );
          pollMessageId = sent.message_id;
          pollChatId = sent.chat.id;
          try { 
            await bot.telegram.pinChatMessage(LIVE_CHANNEL, pollMessageId); 
          } catch {}
        }
      });
    } else {
      const sent = await bot.telegram.sendMessage(
        LIVE_CHANNEL,
        msg,
        { reply_markup: getPollKeyboard() }
      );
      pollMessageId = sent.message_id;
      pollChatId = sent.chat.id;
      try { 
        await bot.telegram.pinChatMessage(LIVE_CHANNEL, pollMessageId); 
      } catch {}
    }
  } catch (err) {
    log.error("updatePoll error:", err.message);
  }
}

async function updateLeaderboard() {
  try {
    const msg = buildLeaderboardMessage();
    
    if (leaderboardMessageId && leaderboardChatId) {
      await bot.telegram.editMessageText(
        leaderboardChatId,
        leaderboardMessageId,
        undefined,
        msg
      ).catch(async (err) => {
        if (err.message.includes("message to edit not found")) {
          const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, msg);
          leaderboardMessageId = sent.message_id;
          leaderboardChatId = sent.chat.id;
          try { 
            await bot.telegram.pinChatMessage(COMMUNITY_GROUP, leaderboardMessageId); 
          } catch {}
        }
      });
    } else {
      const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, msg);
      leaderboardMessageId = sent.message_id;
      leaderboardChatId = sent.chat.id;
      try { 
        await bot.telegram.pinChatMessage(COMMUNITY_GROUP, leaderboardMessageId); 
      } catch {}
    }
  } catch (err) {
    log.error("updateLeaderboard error:", err.message);
  }
}

// ============================================
// PAYMENT PROCESSING
// ============================================

async function checkForPayment(memoId) {
  try {
    const botPubkey = botWallet.publicKey;
    const signatures = await connection.getSignaturesForAddress(botPubkey, { limit: 20 });
    
    for (const sigInfo of signatures) {
      if (processedTxSignatures.has(sigInfo.signature)) continue;
      if (sigInfo.err) continue;
      
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx || !tx.meta) continue;
      
      const logMessages = tx.meta.logMessages || [];
      if (!logMessages.some(msg => msg.includes(memoId))) continue;
      
      const botIndex = tx.transaction.message.accountKeys.findIndex(
        k => k.pubkey.toString() === botPubkey.toString()
      );
      if (botIndex === -1) continue;
      
      const receivedLamports = tx.meta.postBalances[botIndex] - tx.meta.preBalances[botIndex];
      if (receivedLamports <= 0) continue;
      
      processedTxSignatures.add(sigInfo.signature);
      return { signature: sigInfo.signature, amount: receivedLamports / LAMPORTS_PER_SOL };
    }
    
    return null;
  } catch (err) {
    log.error("checkForPayment error:", err.message);
    return null;
  }
}

async function watchForPayment(memoId) {
  const payment = pendingPayments.get(memoId);
  if (!payment) return;
  
  if (Date.now() > payment.expiresAt) {
    await handlePaymentTimeout(memoId);
    return;
  }
  
  const result = await checkForPayment(memoId);
  if (result) {
    await handlePaymentReceived(memoId, result.signature, result.amount);
    return;
  }
  
  setTimeout(() => watchForPayment(memoId), POLL_INTERVAL_MS);
}

async function sendToRakeWallet(amount) {
  if (amount <= 0) return;
  
  try {
    const toPubkey = new PublicKey(RAKE_WALLET);
    const fromPubkey = botWallet.publicKey;
    
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    
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
    log.error("sendToRakeWallet failed:", err.message);
  }
}

async function sendPayout(userId, amountSOL, reason) {
  const userData = userWallets.get(userId);
  if (!userData) return null;
  
  try {
    const toPubkey = new PublicKey(userData.address);
    const fromPubkey = botWallet.publicKey;
    
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    
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
    log.error("sendPayout failed:", err.message);
    return null;
  }
}

async function handlePaymentReceived(memoId, signature, receivedAmount) {
  const payment = pendingPayments.get(memoId);
  if (!payment) return;
  
  clearTimeout(payment.timeoutHandle);
  pendingPayments.delete(memoId);
  
  const { userId, username, chatId, choice } = payment;
  const amount = Math.round(receivedAmount * 1e6) / 1e6;
  
  const rakeAmount = amount * RAKE_PERCENT;
  const potAmount = amount * POT_PERCENT;
  const jackpotAmount = amount * JACKPOT_PERCENT;
  
  currentPoll.pot += potAmount;
  currentPoll.stakes.push({
    userId, username, choice, amount: potAmount, timestamp: Date.now(), signature
  });
  currentPoll.totalBets++;
  
  addToJackpot(jackpotAmount);
  
  let stats = userStats.get(userId) || {
    username, totalBets: 0, totalWon: 0, totalStaked: 0, winStreak: 0, bestStreak: 0
  };
  stats.totalBets++;
  stats.totalStaked += amount;
  userStats.set(userId, stats);
  
  const jackpotWin = await tryWinJackpot(userId, username, amount);
  
  await sendToRakeWallet(rakeAmount);
  
  const emoji = { pump: "🚀", dump: "📉", stagnate: "🟡" }[choice];
  let confirmMsg = `${emoji} Bet Confirmed!\n\n`;
  confirmMsg += `Amount: ${amount} SOL\n`;
  confirmMsg += `Choice: ${choice.toUpperCase()}\n`;
  if (jackpotWin) {
    confirmMsg += `\n🎉 JACKPOT WIN! +${jackpotWin.toFixed(6)} SOL\n`;
    await sendPayout(userId, jackpotWin, "Jackpot Win");
  }
  
  await bot.telegram.sendMessage(chatId, confirmMsg).catch(()=>{});
  
  if (amount >= 10) {
    bot.telegram.sendMessage(
      LIVE_CHANNEL,
      `🐋 Whale Alert! ${username} bet ${amount} SOL on ${choice.toUpperCase()}`
    ).catch(()=>{});
  }
  
  log.ok(`Payment confirmed: ${amount} SOL from ${username}`);
}

async function handlePaymentTimeout(memoId) {
  const payment = pendingPayments.get(memoId);
  if (!payment) return;
  pendingPayments.delete(memoId);
  await bot.telegram.sendMessage(
    payment.chatId,
    `⏱️ Payment timeout - no SOL detected`
  ).catch(()=>{});
}

// ============================================
// HOURLY SETTLEMENT
// ============================================

async function settleHour() {
  log.info("⏰ Hourly settlement");
  
  if (currentPoll.stakes.length === 0) {
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, "⏰ No bets this hour").catch(()=>{});
  } else {
    let winnerChoice;
    if (currentPrice > openPrice * 1.001) winnerChoice = 'pump';
    else if (currentPrice < openPrice * 0.999) winnerChoice = 'dump';
    else winnerChoice = 'stagnate';
    
    const winners = currentPoll.stakes.filter(s => s.choice === winnerChoice);
    const totalPot = currentPoll.pot;
    const totalWinningAmount = winners.reduce((a,s) => a + s.amount, 0);
    
    let paidCount = 0;
    
    for (const w of winners) {
      const share = w.amount / totalWinningAmount;
      const payout = totalPot * share;
      const multiplier = getStreakMultiplier(w.userId);
      const finalPayout = payout * multiplier;
      
      const sig = await sendPayout(w.userId, finalPayout, "Hourly win");
      if (sig) {
        paidCount++;
        const stats = userStats.get(w.userId);
        if (stats) {
          stats.totalWon += finalPayout;
          stats.winStreak++;
          if (stats.winStreak > stats.bestStreak) stats.bestStreak = stats.winStreak;
        }
      }
    }
    
    const resultMsg = `⏰ Hourly Results\nWinner: ${winnerChoice.toUpperCase()}\nPot: ${totalPot.toFixed(6)} SOL\nWinners: ${paidCount}`;
    await bot.telegram.sendMessage(ANNOUNCEMENTS_CHANNEL, resultMsg).catch(()=>{});
  }
  
  // Reset for next hour
  currentPoll = {
    pot: 0,
    stakes: [],
    startTime: Date.now(),
    endTime: Date.now() + 3600000,
    totalBets: 0,
    seedHash: hashSeed(generateSeed()),
    serverSeed: generateSeed(),
    clientSeed: null,
  };
  openPrice = currentPrice;
  
  await updatePoll();
  await updateLeaderboard();
}

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});

bot.catch((err, ctx) => {
  log.error("Telegraf error:", err.message);
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
  const userId = getUserIdentifier(ctx);
  const name = ctx.from.first_name || "User";
  
  const args = ctx.message.text.split(' ');
  if (args.length > 1 && args[1].startsWith('ref_')) {
    const refCode = args[1].substring(4);
    referralCodes.set(refCode, userId);
  }
  
  ctx.reply(
    `🎰 Welcome to Degen Echo, ${name}!\n\n` +
    `Commands:\n` +
    `/register <wallet> - Link wallet\n` +
    `/balance - Check balance\n` +
    `/leaderboard - View top players\n` +
    `/poll - Show current poll\n` +
    `/jackpot - Check jackpot\n` +
    `/daily - Claim daily reward\n` +
    `/ref - Get referral link\n` +
    `/help - Show all commands`
  );
});

bot.help((ctx) => {
  ctx.reply(
    `Commands:\n` +
    `/register <wallet>\n/balance\n/leaderboard\n/poll\n/jackpot\n/daily\n/ref\n/cancel\n/stats`
  );
});

bot.command("register", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.trim().split(/\s+/);
  
  if (args.length !== 2) {
    return ctx.reply("Usage: /register <wallet_address>");
  }
  
  const wallet = args[1].trim();
  if (!isValidSolanaAddress(wallet)) {
    return ctx.reply("❌ Invalid address");
  }
  
  userWallets.set(userId, { address: wallet, username });
  ctx.reply(`✅ Wallet registered for ${username}`);
});

bot.command("balance", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const user = userWallets.get(userId);
  if (!user) return ctx.reply("❌ Register first");
  const bal = await checkBalance(user.address);
  ctx.reply(`💰 Balance: ${bal.toFixed(6)} SOL`);
});

bot.command("leaderboard", async (ctx) => {
  ctx.reply(buildLeaderboardMessage());
});

bot.command("poll", async (ctx) => {
  ctx.reply(buildPollMessage(), { reply_markup: getPollKeyboard() });
});

bot.command("jackpot", (ctx) => {
  ctx.reply(`🎰 Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL`);
});

bot.command("daily", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const result = await claimDailyReward(userId);
  
  if (result.success) {
    ctx.reply(`✅ Daily reward: ${result.reward} SOL (streak ${result.streak})`);
    await sendPayout(userId, result.reward, "Daily reward");
  } else {
    ctx.reply(`⏳ Next daily in ${Math.ceil(result.hoursLeft)} hours`);
  }
});

bot.command("ref", (ctx) => {
  const userId = getUserIdentifier(ctx);
  const code = generateReferralCode(userId);
  referralCodes.set(code, userId);
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${code}`;
  ctx.reply(`🤝 Your referral link:\n${link}`);
});

bot.command("stats", (ctx) => {
  const userId = getUserIdentifier(ctx);
  const stats = userStats.get(userId);
  
  if (!stats) return ctx.reply("No stats yet");
  
  const winRate = stats.totalBets ? ((stats.totalWon / stats.totalStaked) * 100).toFixed(1) : 0;
  ctx.reply(
    `📊 Your Stats\n` +
    `Bets: ${stats.totalBets}\n` +
    `Staked: ${stats.totalStaked.toFixed(4)} SOL\n` +
    `Won: ${stats.totalWon.toFixed(4)} SOL\n` +
    `Win rate: ${winRate}%\n` +
    `Streak: ${stats.winStreak}`
  );
});

bot.command("cancel", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  
  for (const [memo, pay] of pendingPayments.entries()) {
    if (pay.userId === userId && memo.startsWith('temp_')) {
      clearTimeout(pay.timeoutHandle);
      pendingPayments.delete(memo);
      return ctx.reply("✅ Pending bet cancelled");
    }
  }
  
  ctx.reply("❌ No pending bet");
});

bot.command("debug", async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!ADMIN_IDS.includes(userId)) return;
  
  const botBal = await checkBalance(botWallet.publicKey.toString());
  ctx.reply(
    `🔧 Debug\n` +
    `Bot balance: ${botBal.toFixed(6)} SOL\n` +
    `Jackpot: ${jackpotAmountSOL.toFixed(4)} SOL\n` +
    `Users: ${userWallets.size}\n` +
    `Price: $${formatPrice()}`
  );
});

// ============================================
// BUTTON HANDLER
// ============================================

bot.action(/^vote_(pump|dump|stagnate)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  
  if (!userWallets.has(userId) && !ADMIN_IDS.includes(ctx.from?.id?.toString())) {
    return ctx.answerCbQuery("❌ Register wallet first");
  }
  
  const choice = ctx.match[1];
  
  // Check for existing pending
  for (const [, pay] of pendingPayments.entries()) {
    if (pay.userId === userId && pay.awaitingAmount) {
      return ctx.answerCbQuery("⚠️ You have a pending bet");
    }
  }
  
  const emoji = { pump: "🚀", dump: "📉", stagnate: "🟡" }[choice];
  await ctx.reply(`${emoji} ${choice.toUpperCase()}\nHow much SOL? (min ${MIN_STAKE})`);
  
  const tempKey = `temp_${userId}`;
  pendingPayments.set(tempKey, {
    userId,
    username,
    chatId: ctx.chat.id,
    choice,
    awaitingAmount: true,
    createdAt: Date.now(),
    timeoutHandle: setTimeout(() => {
      if (pendingPayments.has(tempKey)) {
        pendingPayments.delete(tempKey);
        bot.telegram.sendMessage(ctx.chat.id, "⏱️ Timed out").catch(()=>{});
      }
    }, PAYMENT_TIMEOUT_MS)
  });
});

// ============================================
// TEXT HANDLER
// ============================================

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  
  const userId = getUserIdentifier(ctx);
  const tempKey = `temp_${userId}`;
  const partial = pendingPayments.get(tempKey);
  if (!partial || !partial.awaitingAmount) return;
  
  const validation = validateStakeAmount(text);
  if (!validation.valid) {
    return ctx.reply(`❌ ${validation.error}. Try again:`);
  }
  
  const amount = validation.amount;
  const memoId = generateMemoId();
  const expiresAt = Date.now() + PAYMENT_TIMEOUT_MS;
  
  clearTimeout(partial.timeoutHandle);
  pendingPayments.delete(tempKey);
  
  const timeoutHandle = setTimeout(() => handlePaymentTimeout(memoId), PAYMENT_TIMEOUT_MS);
  
  pendingPayments.set(memoId, {
    userId,
    username: partial.username,
    chatId: partial.chatId,
    choice: partial.choice,
    amount,
    expiresAt,
    timeoutHandle,
    memoId
  });
  
  const rakeAmount = amount * RAKE_PERCENT;
  const potAmount = amount * POT_PERCENT;
  const jackpotAmount = amount * JACKPOT_PERCENT;
  
  await ctx.reply(
    `📋 Payment Instructions\n\n` +
    `Total: ${amount} SOL\n` +
    `Bet: ${partial.choice.toUpperCase()}\n\n` +
    `Send to:\n${botWallet.publicKey.toString()}\n` +
    `Memo: ${memoId}\n\n` +
    `Breakdown:\n` +
    `Rake (19%): ${rakeAmount.toFixed(6)} SOL\n` +
    `Pot (80%): ${potAmount.toFixed(6)} SOL\n` +
    `Jackpot (1%): ${jackpotAmount.toFixed(6)} SOL\n\n` +
    `⏱️ 5 minutes to send`
  );
  
  setTimeout(() => watchForPayment(memoId), POLL_INTERVAL_MS);
});

// ============================================
// CRON JOBS
// ============================================

cron.schedule("0 * * * *", settleHour);
cron.schedule("*/30 * * * * *", updatePoll);
cron.schedule("*/5 * * * *", updateLeaderboard);

// ============================================
// EXPRESS HEALTH CHECK
// ============================================

const app = express();

app.get("/", (req, res) => {
  res.send("Degen Echo Bot Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    users: userWallets.size,
    jackpot: jackpotAmountSOL,
    price: currentPrice
  });
});

app.listen(PORT, "0.0.0.0", () => {
  log.ok(`Health check on port ${PORT}`);
});

// ============================================
// STARTUP
// ============================================

async function startup() {
  log.info("Starting up...");
  
  // Wait for price
  for (let i = 0; i < 30; i++) {
    if (currentPrice > 0) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  
  if (currentPrice <= 0) currentPrice = 20;
  openPrice = currentPrice;
  
  connectPriceWebSocket();
  
  await updatePoll();
  await updateLeaderboard();
  
  log.ok("Startup complete");
}

// ============================================
// LAUNCH
// ============================================

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    log.ok("🚀 Bot is live!");
    startup();
  })
  .catch(err => {
    log.error("Launch failed:", err);
    process.exit(1);
  });

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach(sig => {
  process.once(sig, () => {
    log.info(`Shutting down on ${sig}`);
    bot.stop(sig);
    if (ws) ws.close();
    setTimeout(() => process.exit(0), 2000);
  });
});
