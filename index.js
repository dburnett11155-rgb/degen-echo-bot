const { Telegraf } = require("telegraf");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction, SystemProgram } = require("@solana/web3.js");
const WebSocket = require("ws");
const express = require("express");
const cron = require('node-cron');
const { createCanvas } = require('canvas');
const fs = require('fs');

// ============================================
// CONFIGURATION - YOUR MONEY MAKER
// ============================================
const BOT_TOKEN = "8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o";
const RAKE_WALLET = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK"; // YOUR WALLET - money flows here automatically
const RAKE_RATE = 0.2; // 20% to you automatically
const STAKE_TIMEOUT = 180000; // 3 minutes
const MIN_STAKE = 0.001; // Minimum SOL stake
const MIN_PLAYERS_PER_POLL = 2;
const MAX_PAYOUT_MULTIPLIER = 10;
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 0.05; // 5% bonus for referrals
const JACKPOT_PERCENT = 0.01; // 1% of rake to jackpot
const XP_PER_BET = 10;
const XP_PER_WIN = 50;
const XP_PER_REFERRAL = 100;

// Telegram Channels (CREATE THESE AND ADD BOT AS ADMIN)
const LIVE_CHANNEL = "@DegenEchoLive"; // Live bets feed
const COMMUNITY_GROUP = "@DegenEchoChat"; // Community chat
const ANNOUNCEMENTS_CHANNEL = "@DegenEchoNews"; // Updates

// Admin IDs (add your Telegram ID)
const ADMIN_IDS = ["YOUR_TELEGRAM_ID_HERE", "1087968824"];

// 🔐 AUTO-PAYOUT SETUP (ONE-TIME)
// Get this from Phantom: Settings → Export Private Key → Copy array
const PAYOUT_PRIVATE_KEY = []; // PASTE YOUR PRIVATE KEY ARRAY HERE
const AUTO_PAYOUT_ENABLED = true; // Set to true to enable automatic payments

// ============================================
// SOLANA SETUP
// ============================================
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
let connection;
try {
  connection = new Connection(SOLANA_RPC, "confirmed");
  console.log("✅ Solana connection established");
} catch (error) {
  console.error("❌ Failed to connect to Solana:", error.message);
}

// Setup payout keypair
let payoutKeypair = null;
if (AUTO_PAYOUT_ENABLED && PAYOUT_PRIVATE_KEY.length > 0) {
  try {
    payoutKeypair = Keypair.fromSecretKey(new Uint8Array(PAYOUT_PRIVATE_KEY));
    console.log("✅ Auto-payout system enabled");
    console.log(`💰 Payout wallet: ${payoutKeypair.publicKey.toString()}`);
  } catch (error) {
    console.error("❌ Failed to setup payout keypair:", error.message);
  }
}

// ============================================
// CONSTANTS
// ============================================
const ANONYMOUS_ADMIN_ID = "1087968824";
const COINS = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// ============================================
// DATA STORES (ALL FEATURES)
// ============================================
const activePolls = new Map();
const pendingStakes = new Map();
const userWallets = new Map();
const settledPolls = new Map();
const disputeCases = new Map();
const processedTransactions = new Set();

// ADDICTIVE FEATURES STORES
const userStats = new Map(); // userId -> { wins, losses, totalBets, totalWon, totalStaked, xp, level, rank }
const referrals = new Map(); // referrerId -> [refereeIds]
const referralBonuses = new Map(); // userId -> { earned, claimed }
const jackpot = { amount: 0, lastWinner: null, lastWin: 0, lastTx: null };
const streakTracker = new Map(); // userId -> { current: 0, best: 0, lastBet: timestamp }
const quests = new Map(); // Active quests
const userQuests = new Map(); // userId -> [quest completions]
const badges = new Map(); // userId -> [badges]
const notifications = new Map(); // userId -> settings
const leaderboard = []; // Sorted array for rankings
const pendingPayouts = new Map(); // Track payouts to be sent
const dailyBonuses = new Map(); // Last daily bonus claim
const lootBoxes = new Map(); // Unopened loot boxes

// ============================================
// INITIALIZE BOT
// ============================================
console.log("🤖 Initializing ULTIMATE Degen Echo Bot...");
const bot = new Telegraf(BOT_TOKEN);

// Clear webhooks
bot.telegram.deleteWebhook({ drop_pending_updates: true })
  .then(() => console.log("✅ Cleared webhooks"))
  .catch(() => {});

// Error handler
bot.catch((err, ctx) => {
  console.error('❌ Telegram Error:', err);
});

// ============================================
// EXPRESS HEALTH CHECK
// ============================================
const app = express();
app.get('/', (req, res) => res.send('ULTIMATE Degen Echo Bot Running'));
app.get('/health', (req, res) => {
  res.json({
    status: 'godly',
    users: userWallets.size,
    activePolls: activePolls.size,
    jackpot: jackpot.amount,
    autoPayout: AUTO_PAYOUT_ENABLED ? 'enabled' : 'disabled',
    totalBets: Array.from(userStats.values()).reduce((a, b) => a + b.totalBets, 0),
    uptime: process.uptime()
  });
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check on port ${PORT}`);
});

// ============================================
// WEBSOCKET FOR PRICES
// ============================================
function connectPriceWebSocket() {
  try {
    const ws = new WebSocket("wss://ws.kraken.com");
    ws.on("open", () => {
      console.log("✅ Kraken WebSocket connected");
      ws.send(JSON.stringify({
        event: "subscribe",
        pair: COINS,
        subscription: { name: "ticker" }
      }));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (Array.isArray(msg) && msg[1] && msg[1].c) {
          const pair = msg[3];
          const price = msg[1].c[0];
          if (COINS.includes(pair)) {
            prices[pair] = Number(price).toFixed(6);
          }
        }
      } catch (e) {}
    });
    ws.on("close", () => setTimeout(connectPriceWebSocket, 5000));
    return ws;
  } catch (error) {
    setTimeout(connectPriceWebSocket, 5000);
  }
}
connectPriceWebSocket();

// ============================================
// HELPER FUNCTIONS
// ============================================
function getUserIdentifier(ctx) {
  const userId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id?.toString();
  if (userId === ANONYMOUS_ADMIN_ID) {
    return ctx.from?.username ? `anon_${ctx.from.username}` : `anon_${chatId}_${Date.now()}`;
  }
  return userId;
}

function isValidSolanaAddress(address) {
  try { new PublicKey(address); return true; } catch { return false; }
}

async function checkBalance(address) {
  try {
    if (!connection) return 0;
    const publicKey = new PublicKey(address);
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

function validateStakeAmount(input) {
  const cleaned = input.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(cleaned)) {
    return { valid: false, error: "❌ Invalid number format" };
  }
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount <= 0) {
    return { valid: false, error: "❌ Amount must be greater than 0" };
  }
  if (amount < MIN_STAKE) {
    return { valid: false, error: `❌ Minimum stake is ${MIN_STAKE} SOL` };
  }
  return { valid: true, amount: Math.round(amount * 1000000) / 1000000 };
}

// ============================================
// USER STATS & LEVELING SYSTEM
// ============================================
function getUserLevel(xp) {
  if (xp < 100) return { level: 1, next: 100 - xp, title: "🐣 Baby Degenerate" };
  if (xp < 250) return { level: 2, next: 250 - xp, title: "🦐 Shrimp Trader" };
  if (xp < 500) return { level: 3, next: 500 - xp, title: "🐟 Fish" };
  if (xp < 1000) return { level: 4, next: 1000 - xp, title: "🐬 Dolphin" };
  if (xp < 2500) return { level: 5, next: 2500 - xp, title: "🦈 Shark" };
  if (xp < 5000) return { level: 6, next: 5000 - xp, title: "🐋 Whale" };
  if (xp < 10000) return { level: 7, next: 10000 - xp, title: "🦑 Kraken" };
  return { level: 8, next: 0, title: "👑 Degen Lord" };
}

function initUserStats(userId, username) {
  if (!userStats.has(userId)) {
    userStats.set(userId, {
      username,
      wins: 0,
      losses: 0,
      totalBets: 0,
      totalWon: 0,
      totalStaked: 0,
      xp: 0,
      biggestWin: 0,
      biggestBet: 0,
      joined: Date.now()
    });
  }
  return userStats.get(userId);
}

// ============================================
// STREAK SYSTEM
// ============================================
function updateStreak(userId, won) {
  let streak = streakTracker.get(userId) || { current: 0, best: 0, lastBet: 0 };
  
  if (won) {
    streak.current++;
    if (streak.current > streak.best) streak.best = streak.current;
  } else {
    streak.current = 0;
  }
  
  streak.lastBet = Date.now();
  streakTracker.set(userId, streak);
  return streak;
}

function getStreakBonus(streak) {
  const bonuses = [0, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
  return bonuses[Math.min(streak, bonuses.length - 1)] || 5;
}

// ============================================
// BADGE SYSTEM
// ============================================
const BADGES = {
  FIRST_BET: { emoji: "🎯", name: "First Bet", desc: "Placed your first bet" },
  FIRST_WIN: { emoji: "🏆", name: "First Blood", desc: "Won your first bet" },
  WHALE: { emoji: "🐋", name: "Whale", desc: "Staked over 100 SOL total" },
  DEGEN: { emoji: "🤪", name: "Degen", desc: "Placed 100 bets" },
  STREAK_5: { emoji: "🔥", name: "On Fire", desc: "5 wins in a row" },
  STREAK_10: { emoji: "⚡", name: "Unstoppable", desc: "10 wins in a row" },
  BIG_WIN: { emoji: "💎", name: "Diamond Hands", desc: "Won 10+ SOL in one bet" },
  REFERRER: { emoji: "🤝", name: "Influencer", desc: "Referred 5 friends" },
  VETERAN: { emoji: "⚔️", name: "Veteran", desc: "Member for 30 days" },
  JACKPOT: { emoji: "🎰", name: "Jackpot Winner", desc: "Won the jackpot" }
};

function awardBadge(userId, badgeKey) {
  if (!badges.has(userId)) badges.set(userId, []);
  const userBadges = badges.get(userId);
  
  if (!userBadges.includes(badgeKey)) {
    userBadges.push(badgeKey);
    badges.set(userId, userBadges);
    return true;
  }
  return false;
}

// ============================================
// REFERRAL SYSTEM
// ============================================
function generateReferralCode(userId) {
  return Buffer.from(userId).toString('base64').substring(0, 8);
}

async function processReferral(refereeId, referrerCode) {
  // Find referrer by code
  let referrerId = null;
  for (const [uid, stats] of userStats.entries()) {
    if (generateReferralCode(uid) === referrerCode) {
      referrerId = uid;
      break;
    }
  }
  
  if (!referrerId || referrerId === refereeId) return false;
  
  // Store referral
  if (!referrals.has(referrerId)) referrals.set(referrerId, []);
  referrals.get(referrerId).push(refereeId);
  
  // Award XP
  const referrerStats = userStats.get(referrerId);
  if (referrerStats) {
    referrerStats.xp += XP_PER_REFERRAL;
    userStats.set(referrerId, referrerStats);
  }
  
  // Check for referrer badge
  if (referrals.get(referrerId).length >= 5) {
    awardBadge(referrerId, 'REFERRER');
  }
  
  return true;
}

// ============================================
// JACKPOT SYSTEM
// ============================================
function addToJackpot(amount) {
  jackpot.amount += amount;
}

async function tryWinJackpot(userId, betAmount) {
  if (jackpot.amount < 1) return false; // Jackpot too small
  
  // 0.1% chance to win jackpot per bet
  if (Math.random() < 0.001) {
    const winAmount = jackpot.amount;
    jackpot.amount = 0;
    jackpot.lastWinner = userId;
    jackpot.lastWin = Date.now();
    
    awardBadge(userId, 'JACKPOT');
    return winAmount;
  }
  return 0;
}

// ============================================
// DAILY REWARDS
// ============================================
async function claimDailyReward(userId) {
  const lastClaim = dailyBonuses.get(userId) || 0;
  const now = Date.now();
  
  if (now - lastClaim < 86400000) { // 24 hours
    const hoursLeft = Math.ceil((86400000 - (now - lastClaim)) / 3600000);
    return { success: false, hoursLeft };
  }
  
  // Calculate reward based on level
  const stats = userStats.get(userId);
  const level = getUserLevel(stats?.xp || 0).level;
  const reward = 0.001 * level; // 0.001 SOL per level
  
  dailyBonuses.set(userId, now);
  return { success: true, reward };
}

// ============================================
// LOOT BOX SYSTEM
// ============================================
function generateLootBox(userId) {
  const box = {
    id: Date.now().toString(),
    rarity: Math.random(),
    contents: null
  };
  
  // Determine rarity
  if (box.rarity < 0.01) { // 1% - Legendary
    box.rarity = "LEGENDARY 🔥";
    box.contents = { sol: 0.5 + Math.random() * 1, xp: 500 };
  } else if (box.rarity < 0.05) { // 4% - Epic
    box.rarity = "EPIC 💫";
    box.contents = { sol: 0.2 + Math.random() * 0.5, xp: 200 };
  } else if (box.rarity < 0.15) { // 10% - Rare
    box.rarity = "RARE ✨";
    box.contents = { sol: 0.05 + Math.random() * 0.2, xp: 100 };
  } else { // 85% - Common
    box.rarity = "COMMON 📦";
    box.contents = { sol: 0.001 + Math.random() * 0.05, xp: 25 };
  }
  
  if (!lootBoxes.has(userId)) lootBoxes.set(userId, []);
  lootBoxes.get(userId).push(box);
  
  return box;
}

async function openLootBox(userId, boxId) {
  const userBoxes = lootBoxes.get(userId) || [];
  const boxIndex = userBoxes.findIndex(b => b.id === boxId);
  
  if (boxIndex === -1) return null;
  
  const box = userBoxes[boxIndex];
  userBoxes.splice(boxIndex, 1);
  
  // Award contents
  const stats = userStats.get(userId);
  if (stats) {
    stats.xp += box.contents.xp;
    userStats.set(userId, stats);
  }
  
  return box;
}

// ============================================
// AUTO TRANSACTION MONITORING
// ============================================
async function monitorTransactions() {
  if (!connection) return;
  
  try {
    const publicKey = new PublicKey(RAKE_WALLET);
    const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 20 });
    
    for (const sig of signatures) {
      if (processedTransactions.has(sig.signature)) continue;
      
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0
      });
      
      if (tx && tx.meta && tx.meta.postBalances && tx.meta.preBalances) {
        const amount = (tx.meta.postBalances[1] - tx.meta.preBalances[1]) / LAMPORTS_PER_SOL;
        const fromAddress = tx.transaction.message.accountKeys[0].toString();
        
        // Find matching pending stake
        for (const [userId, stakeData] of pendingStakes.entries()) {
          if (stakeData.awaitingConfirmation && 
              Math.abs(stakeData.amount - amount) < 0.000001 &&
              (Date.now() - stakeData.timestamp) < 600000) {
            
            console.log(`✅ Auto-confirmed stake: ${amount} SOL from ${fromAddress}`);
            await confirmStake(userId, stakeData, sig.signature);
            processedTransactions.add(sig.signature);
            
            // Post to live channel
            await bot.telegram.sendMessage(
              LIVE_CHANNEL,
              `🎯 *NEW BET PLACED!*\n\n` +
              `👤 *Player:* ${stakeData.username}\n` +
              `💰 *Amount:* ${amount} SOL\n` +
              `📈 *Choice:* ${stakeData.choice.toUpperCase()}\n` +
              `🎲 *Poll:* #${stakeData.pollNum}\n` +
              `🔥 *Streak:* ${streakTracker.get(userId)?.current || 0} wins`,
              { parse_mode: "Markdown" }
            ).catch(() => {});
            
            break;
          }
        }
      }
    }
  } catch (error) {
    console.error("Error monitoring transactions:", error);
  }
}

// Run monitor every 20 seconds
setInterval(monitorTransactions, 20000);

// ============================================
// AUTO PAYOUT FUNCTION
// ============================================
async function sendPayout(toAddress, amount, pollNum, username, userId) {
  if (!AUTO_PAYOUT_ENABLED || !payoutKeypair || !connection) {
    pendingPayouts.set(`${userId}_${Date.now()}`, { toAddress, amount, pollNum, username });
    return false;
  }
  
  try {
    const toPublicKey = new PublicKey(toAddress);
    const fromPublicKey = payoutKeypair.publicKey;
    
    const { blockhash } = await connection.getLatestBlockhash();
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromPublicKey,
        toPubkey: toPublicKey,
        lamports: amount * LAMPORTS_PER_SOL
      })
    );
    
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPublicKey;
    transaction.sign(payoutKeypair);
    
    const signature = await connection.sendRawTransaction(transaction.serialize());
    
    console.log(`✅ Auto-paid ${amount} SOL to ${username}`);
    
    // Announce big wins
    if (amount >= 1) {
      await bot.telegram.sendMessage(
        ANNOUNCEMENTS_CHANNEL,
        `🐋 *WHALE WIN ALERT!*\n\n` +
        `👤 *Player:* ${username}\n` +
        `💰 *Won:* ${amount.toFixed(6)} SOL\n` +
        `🎯 *Poll:* #${pollNum}\n` +
        `🔗 [View Transaction](https://solscan.io/tx/${signature})`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    
    return true;
  } catch (error) {
    console.error("❌ Auto-payout failed:", error);
    pendingPayouts.set(`${userId}_${Date.now()}`, { toAddress, amount, pollNum, username });
    return false;
  }
}

// ============================================
// CONFIRM STAKE FUNCTION
// ============================================
async function confirmStake(userId, stakeData, txId) {
  // Calculate streak bonus
  const streak = streakTracker.get(userId)?.current || 0;
  const streakBonus = getStreakBonus(streak);
  const bonusAmount = stakeData.netAmount * streakBonus;
  const totalNetAmount = stakeData.netAmount + bonusAmount;
  
  // Add to poll
  stakeData.poll.pot += totalNetAmount;
  stakeData.poll.stakes.push({
    userIdentifier: userId,
    amount: totalNetAmount,
    choice: stakeData.choice,
    username: stakeData.username,
    timestamp: Date.now(),
    confirmed: true,
    txId: txId,
    streakBonus: streakBonus > 0 ? streakBonus : null
  });
  
  // Update stats
  const stats = initUserStats(userId, stakeData.username);
  stats.totalBets++;
  stats.totalStaked += stakeData.amount;
  stats.xp += XP_PER_BET;
  if (stakeData.amount > stats.biggestBet) stats.biggestBet = stakeData.amount;
  userStats.set(userId, stats);
  
  // Check for first bet badge
  if (stats.totalBets === 1) awardBadge(userId, 'FIRST_BET');
  
  // Add to jackpot
  const jackpotContribution = stakeData.rake * JACKPOT_PERCENT;
  addToJackpot(jackpotContribution);
  
  // Check for jackpot win
  const jackpotWin = await tryWinJackpot(userId, stakeData.amount);
  if (jackpotWin > 0) {
    // Award jackpot
    await sendPayout(
      userWallets.get(userId).address,
      jackpotWin,
      stakeData.pollNum,
      stakeData.username,
      userId
    );
  }
  
  // Remove from pending
  pendingStakes.delete(userId);
}

// ============================================
// BUILD POLL MESSAGE
// ============================================
function buildPollMessage(pollNum, coin, price, pot, stakes = []) {
  let msg = `🎰 *Degen Echo #${pollNum}* – *$${coin}* at *$${price}*\n`;
  msg += `💰 *Pot:* ${pot.toFixed(6)} SOL\n`;
  
  if (stakes.length > 0) {
    msg += `\n📊 *Stakes:*\n`;
    const grouped = {};
    stakes.forEach(s => {
      if (!grouped[s.choice]) grouped[s.choice] = [];
      grouped[s.choice].push(s);
    });
    
    for (const [choice, stakeList] of Object.entries(grouped)) {
      const emoji = choice === 'pump' ? '🚀' : choice === 'dump' ? '📉' : '🟡';
      const total = stakeList.reduce((sum, s) => sum + s.amount, 0);
      msg += `${emoji} *${choice.toUpperCase()}*: ${total.toFixed(6)} SOL (${stakeList.length} players)\n`;
      
      stakeList.forEach(s => {
        const streakBonus = s.streakBonus ? ` (+${(s.streakBonus*100).toFixed(0)}% streak!)` : '';
        msg += `  → ${s.username}: ${s.amount.toFixed(6)} SOL${streakBonus}\n`;
      });
    }
  } else {
    msg += `\n❌ No stakes yet - Be the first to bet!\n`;
    msg += `🔥 *First bet bonus:* Double XP!`;
  }
  
  // Add jackpot info
  if (jackpot.amount > 0) {
    msg += `\n🎰 *Jackpot:* ${jackpot.amount.toFixed(6)} SOL`;
  }
  
  return msg;
}

// ============================================
// POLL KEYBOARD
// ============================================
function getPollKeyboard(pollNum) {
  return {
    inline_keyboard: [[
      { text: "🚀 Pump", callback_data: `vote_${pollNum}_pump` },
      { text: "📉 Dump", callback_data: `vote_${pollNum}_dump` },
      { text: "🟡 Stagnate", callback_data: `vote_${pollNum}_stagnate` }
    ]]
  };
}

// ============================================
// COMMAND: /start
// ============================================
bot.start(ctx => {
  const username = ctx.from.username || ctx.from.first_name || "User";
  const userId = getUserIdentifier(ctx);
  
  initUserStats(userId, username);
  
  const refCode = ctx.message.text.split(' ')[1]; // Check for referral code
  
  ctx.reply(
    `🎰 *WELCOME TO DEGEN ECHO, ${username}!*\n\n` +
    `🔥 *THE MOST ADDICTIVE BETTING BOT ON SOLANA*\n\n` +
    `📌 *HOW TO PLAY:*\n` +
    `1️⃣ /register - Link your Solana wallet\n` +
    `2️⃣ /poll - Create betting polls\n` +
    `3️⃣ Click a button, send stake, win BIG\n\n` +
    `💰 *RAKE:* 20% (goes to house)\n` +
    `💎 *MIN STAKE:* ${MIN_STAKE} SOL\n` +
    `👥 *MIN PLAYERS:* ${MIN_PLAYERS_PER_POLL}\n` +
    `🔥 *STREAK BONUSES:* Up to 500%\n` +
    `🎰 *JACKPOT:* 1% of all bets\n\n` +
    `📋 *COMMANDS:*\n` +
    `/register <wallet> - Link your wallet\n` +
    `/profile - View your stats\n` +
    `/balance - Check balance\n` +
    `/referral - Get your referral link\n` +
    `/daily - Claim daily reward\n` +
    `/quests - View active quests\n` +
    `/leaderboard - Top players\n` +
    `/lootboxes - Your unopened boxes\n` +
    `/poll - Create polls\n` +
    `/rules - Fair play rules\n` +
    `/help - All commands`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
  
  // Process referral if present
  if (refCode && refCode.startsWith('ref_')) {
    processReferral(userId, refCode.replace('ref_', ''));
  }
});

// ============================================
// COMMAND: /register
// ============================================
bot.command("register", async ctx => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.split(' ');
  
  if (args.length !== 2) {
    return ctx.reply(
      `❌ *Usage:* /register <wallet_address>\n` +
      `Example: /register ${RAKE_WALLET}`,
      { parse_mode: "Markdown" }
    );
  }
  
  const walletAddress = args[1].trim();
  
  if (!isValidSolanaAddress(walletAddress)) {
    return ctx.reply("❌ *Invalid Solana address*", { parse_mode: "Markdown" });
  }
  
  const balance = await checkBalance(walletAddress);
  
  userWallets.set(userId, {
    address: walletAddress,
    username,
    registeredAt: Date.now()
  });
  
  initUserStats(userId, username);
  
  ctx.reply(
    `✅ *WALLET REGISTERED!*\n\n` +
    `👤 *User:* ${username}\n` +
    `💳 *Wallet:* \`${walletAddress}\`\n` +
    `💰 *Balance:* ${balance.toFixed(6)} SOL\n\n` +
    `🔥 *Bonus:* +100 XP for registering!`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /profile
// ============================================
bot.command("profile", async ctx => {
  const userId = getUserIdentifier(ctx);
  const stats = userStats.get(userId);
  
  if (!stats) {
    return ctx.reply("❌ No stats yet. Place a bet first!", { parse_mode: "Markdown" });
  }
  
  const level = getUserLevel(stats.xp);
  const streak = streakTracker.get(userId) || { current: 0, best: 0 };
  const winRate = stats.totalBets > 0 ? ((stats.wins / stats.totalBets) * 100).toFixed(1) : 0;
  const roi = stats.totalStaked > 0 ? ((stats.totalWon / stats.totalStaked) * 100).toFixed(1) : 0;
  
  let msg = `👤 *PROFILE: ${stats.username}*\n\n`;
  msg += `📊 *Level ${level.level}:* ${level.title}\n`;
  msg += `✨ *XP:* ${stats.xp} / ${level.next > 0 ? `+${level.next} to next level` : 'MAX'}\n\n`;
  msg += `🎯 *Stats:*\n`;
  msg += `• Bets: ${stats.totalBets}\n`;
  msg += `• Wins: ${stats.wins} / Losses: ${stats.losses}\n`;
  msg += `• Win Rate: ${winRate}%\n`;
  msg += `• ROI: ${roi}%\n`;
  msg += `• Total Staked: ${stats.totalStaked.toFixed(6)} SOL\n`;
  msg += `• Total Won: ${stats.totalWon.toFixed(6)} SOL\n\n`;
  msg += `🔥 *Streak:* ${streak.current} (Best: ${streak.best})\n\n`;
  
  // Badges
  if (badges.has(userId) && badges.get(userId).length > 0) {
    msg += `🏅 *Badges:* `;
    badges.get(userId).forEach(b => {
      msg += `${BADGES[b]?.emoji || '🏅'} `;
    });
    msg += `\n`;
  }
  
  ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
});

// ============================================
// COMMAND: /referral
// ============================================
bot.command("referral", ctx => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  const refCode = generateReferralCode(userId);
  const refLink = `https://t.me/${bot.botInfo.username}?start=ref_${refCode}`;
  
  let msg = `🤝 *YOUR REFERRAL LINK*\n\n`;
  msg += `Share this link with friends:\n`;
  msg += `${refLink}\n\n`;
  msg += `💰 *Rewards:*\n`;
  msg += `• You get 5% of their first bet\n`;
  msg += `• They get 5% bonus on first bet\n`;
  msg += `• +100 XP per referral\n`;
  msg += `• 🤝 Influencer badge at 5 referrals\n\n`;
  
  if (referrals.has(userId)) {
    msg += `📊 *Referrals:* ${referrals.get(userId).length}`;
  } else {
    msg += `📊 *Referrals:* 0`;
  }
  
  ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
});

// ============================================
// COMMAND: /daily
// ============================================
bot.command("daily", async ctx => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  if (!userWallets.has(userId)) {
    return ctx.reply("❌ Register wallet first with /register", { parse_mode: "Markdown" });
  }
  
  const result = await claimDailyReward(userId);
  
  if (!result.success) {
    return ctx.reply(
      `⏳ *Daily reward already claimed!*\n` +
      `Come back in ${result.hoursLeft} hours`,
      { parse_mode: "Markdown" }
    );
  }
  
  // Send reward
  await sendPayout(
    userWallets.get(userId).address,
    result.reward,
    'daily',
    username,
    userId
  );
  
  // Generate loot box
  const box = generateLootBox(userId);
  
  ctx.reply(
    `✅ *DAILY REWARD CLAIMED!*\n\n` +
    `💰 *Received:* ${result.reward.toFixed(6)} SOL\n` +
    `📦 *Bonus:* You got a ${box.rarity} loot box!\n` +
    `Use /lootboxes to open it`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /lootboxes
// ============================================
bot.command("lootboxes", async ctx => {
  const userId = getUserIdentifier(ctx);
  const userBoxes = lootBoxes.get(userId) || [];
  
  if (userBoxes.length === 0) {
    return ctx.reply("📦 *No loot boxes* - Play more to earn boxes!", { parse_mode: "Markdown" });
  }
  
  let msg = `📦 *YOUR LOOT BOXES:*\n\n`;
  
  userBoxes.forEach((box, i) => {
    msg += `${i+1}. ${box.rarity}\n`;
    msg += `   /open_${box.id} to open\n\n`;
  });
  
  ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
});

// Handle loot box opening
bot.hears(/\/open_(.+)/, async ctx => {
  const userId = getUserIdentifier(ctx);
  const boxId = ctx.match[1];
  
  const box = await openLootBox(userId, boxId);
  
  if (!box) {
    return ctx.reply("❌ Loot box not found", { parse_mode: "Markdown" });
  }
  
  // Send SOL reward
  if (box.contents.sol > 0 && userWallets.has(userId)) {
    await sendPayout(
      userWallets.get(userId).address,
      box.contents.sol,
      'lootbox',
      ctx.from.username || "User",
      userId
    );
  }
  
  ctx.reply(
    `🎁 *LOOT BOX OPENED!*\n\n` +
    `Rarity: ${box.rarity}\n` +
    `💰 SOL: ${box.contents.sol.toFixed(6)} SOL\n` +
    `✨ XP: +${box.contents.xp}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /leaderboard
// ============================================
bot.command("leaderboard", ctx => {
  // Sort users by total won
  const sorted = Array.from(userStats.entries())
    .sort((a, b) => b[1].totalWon - a[1].totalWon)
    .slice(0, 10);
  
  let msg = `🏆 *DEGEN LEADERBOARD*\n\n`;
  
  sorted.forEach(([id, stats], index) => {
    const medal = index === 0 ? "👑" : index === 1 ? "🥈" : index === 2 ? "🥉" : "▫️";
    msg += `${medal} ${index+1}. *${stats.username}*\n`;
    msg += `   Won: ${stats.totalWon.toFixed(6)} SOL | ROI: ${stats.totalStaked > 0 ? ((stats.totalWon/stats.totalStaked)*100).toFixed(1) : 0}%\n`;
  });
  
  msg += `\n🎰 *Jackpot:* ${jackpot.amount.toFixed(6)} SOL`;
  
  ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
});

// ============================================
// COMMAND: /balance
// ============================================
bot.command("balance", async ctx => {
  const userId = getUserIdentifier(ctx);
  
  if (!userWallets.has(userId)) {
    return ctx.reply("❌ Register wallet first with /register", { parse_mode: "Markdown" });
  }
  
  const walletData = userWallets.get(userId);
  const balance = await checkBalance(walletData.address);
  
  ctx.reply(
    `💰 *BALANCE*\n\n` +
    `💳 *Wallet:* \`${walletData.address}\`\n` +
    `💎 *Balance:* ${balance.toFixed(6)} SOL\n\n` +
    `🎯 *Minimum stake:* ${MIN_STAKE} SOL`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /rules
// ============================================
bot.command("rules", ctx => {
  ctx.reply(
    `📜 *FAIR PLAY RULES*\n\n` +
    `1️⃣ *Staking*\n` +
    `   • Min: ${MIN_STAKE} SOL | Max: No limit\n` +
    `   • 20% rake to house\n` +
    `   • 1% of rake to jackpot\n\n` +
    `2️⃣ *Bonuses*\n` +
    `   • Streak: Up to 500% bonus\n` +
    `   • Referral: 5% for both parties\n` +
    `   • Daily rewards + loot boxes\n\n` +
    `3️⃣ *Payouts*\n` +
    `   • Winners share pot proportionally\n` +
    `   • Max payout: ${MAX_PAYOUT_MULTIPLIER}x stake\n` +
    `   • Auto-paid to your wallet\n\n` +
    `4️⃣ *Fairness*\n` +
    `   • Min ${MIN_PLAYERS_PER_POLL} players required\n` +
    `   • Dispute system available\n` +
    `   • Transparent on-chain verification`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /help
// ============================================
bot.command("help", ctx => {
  ctx.reply(
    `📋 *ALL COMMANDS*\n\n` +
    `*Wallet:*\n` +
    `/register <address> - Link wallet\n` +
    `/balance - Check balance\n` +
    `/profile - View stats\n\n` +
    `*Betting:*\n` +
    `/poll - Create polls\n` +
    `/settle <# <winner>> - Settle poll (admin)\n` +
    `/cancel - Cancel pending stake\n\n` +
    `*Rewards:*\n` +
    `/daily - Claim daily\n` +
    `/lootboxes - Open boxes\n` +
    `/referral - Get referral link\n` +
    `/leaderboard - Top players\n\n` +
    `*Info:*\n` +
    `/rules - Fair play rules\n` +
    `/chaos - Market chaos\n` +
    `/debug - Bot status\n` +
    `/help - This message`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /poll
// ============================================
bot.command("poll", async ctx => {
  const userId = getUserIdentifier(ctx);
  
  if (!userWallets.has(userId) && userId !== ANONYMOUS_ADMIN_ID) {
    return ctx.reply("❌ Register wallet first with /register", { parse_mode: "Markdown" });
  }
  
  try {
    await ctx.reply(
      `🚀 *CREATING 4 POLLS*\n\n` +
      `💰 Min stake: ${MIN_STAKE} SOL\n` +
      `🔥 Streak bonuses active!\n` +
      `🎰 Jackpot: ${jackpot.amount.toFixed(6)} SOL`,
      { parse_mode: "Markdown" }
    );

    for (let i = 0; i < COINS.length; i++) {
      const pair = COINS[i];
      const coin = pair.replace("/USD", "");
      const pollNum = i + 1;
      const price = prices[pair] || "unknown";

      const pollMsg = buildPollMessage(pollNum, coin, price, 0);
      const sent = await ctx.reply(pollMsg, {
        parse_mode: "Markdown",
        reply_markup: getPollKeyboard(pollNum)
      });

      if (sent) {
        activePolls.set(sent.message_id.toString(), {
          coin,
          pollNum,
          pot: 0,
          stakes: [],
          chatId: ctx.chat.id,
          messageId: sent.message_id,
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000
        });
      }
    }
  } catch (error) {
    console.error("Poll error:", error);
    ctx.reply("❌ Error creating polls").catch(() => {});
  }
});

// ============================================
// COMMAND: /chaos
// ============================================
bot.command("chaos", ctx => {
  const score = Math.floor(Math.random() * 100) + 1;
  let vibe, emoji;
  
  if (score > 70) {
    vibe = "bullish";
    emoji = "🔥";
  } else if (score < 30) {
    vibe = "bearish";
    emoji = "💀";
  } else {
    vibe = "neutral";
    emoji = "🤷";
  }
  
  const bonus = score > 80 ? " +50% streak bonus!" : score < 20 ? " +25% risk reward!" : "";
  
  ctx.reply(
    `🎲 *CHAOS SCORE:* ${score}/100\n` +
    `📊 *VIBE:* ${vibe} ${emoji}${bonus}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

// ============================================
// COMMAND: /debug
// ============================================
bot.command("debug", ctx => {
  const totalBets = Array.from(userStats.values()).reduce((a, b) => a + b.totalBets, 0);
  const totalStaked = Array.from(userStats.values()).reduce((a, b) => a + b.totalStaked, 0);
  
  let msg = `📊 *DEBUG INFO*\n\n`;
  msg += `👥 Users: ${userWallets.size}\n`;
  msg += `🎯 Active Polls: ${activePolls.size}\n`;
  msg += `⏳ Pending Stakes: ${pendingStakes.size}\n`;
  msg += `💰 Total Bets: ${totalBets}\n`;
  msg += `💎 Total Staked: ${totalStaked.toFixed(6)} SOL\n`;
  msg += `🎰 Jackpot: ${jackpot.amount.toFixed(6)} SOL\n`;
  msg += `🔥 Active Streaks: ${streakTracker.size}\n`;
  msg += `📦 Loot Boxes: ${Array.from(lootBoxes.values()).reduce((a, b) => a + b.length, 0)}\n`;
  msg += `✅ Auto-Payout: ${AUTO_PAYOUT_ENABLED ? 'ON' : 'OFF'}\n\n`;
  msg += `*Current Prices:*\n`;
  
  for (const [coin, price] of Object.entries(prices)) {
    msg += `• ${coin}: $${price}\n`;
  }
  
  ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
});

// ============================================
// COMMAND: /settle (admin only)
// ============================================
bot.command("settle", async ctx => {
  const userId = ctx.from.id.toString();
  
  if (!ADMIN_IDS.includes(userId)) {
    return ctx.reply("❌ Admin only command", { parse_mode: "Markdown" });
  }
  
  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
    return ctx.reply("Usage: /settle <poll#> <winner>", { parse_mode: "Markdown" });
  }
  
  const pollNum = parseInt(args[1]);
  const winner = args[2].toLowerCase();
  
  if (!['pump', 'dump', 'stagnate'].includes(winner)) {
    return ctx.reply("❌ Winner must be pump, dump, or stagnate");
  }
  
  // Find poll
  let targetPoll, targetPollId;
  for (const [id, poll] of activePolls.entries()) {
    if (poll.pollNum === pollNum && !poll.settled) {
      targetPoll = poll;
      targetPollId = id;
      break;
    }
  }
  
  if (!targetPoll) {
    return ctx.reply("❌ Poll not found");
  }
  
  // Check minimum players
  if (targetPoll.stakes.length < MIN_PLAYERS_PER_POLL) {
    ctx.reply(`⚠️ Insufficient players. Refunding...`, { parse_mode: "Markdown" });
    targetPoll.settled = true;
    settledPolls.set(targetPollId, targetPoll);
    activePolls.delete(targetPollId);
    return;
  }
  
  // Calculate winners
  targetPoll.winningChoice = winner;
  const winners = targetPoll.stakes.filter(s => s.choice === winner);
  const losers = targetPoll.stakes.filter(s => s.choice !== winner);
  
  if (winners.length === 0) {
    return ctx.reply("❌ No winners - something's wrong");
  }
  
  // Calculate payouts
  const totalPot = targetPoll.pot;
  const totalWinningAmount = winners.reduce((sum, s) => sum + s.amount, 0);
  
  let resultMsg = `🎯 *POLL #${pollNum} RESULTS*\n\n`;
  resultMsg += `Winner: ${winner.toUpperCase()}\n`;
  resultMsg += `Total Pot: ${totalPot.toFixed(6)} SOL\n`;
  resultMsg += `Winners: ${winners.length}\n\n`;
  resultMsg += `💰 *PAYOUTS:*\n`;
  
  // Process each winner
  for (const winner of winners) {
    const share = winner.amount / totalWinningAmount;
    const payout = totalPot * share;
    
    resultMsg += `• ${winner.username}: ${payout.toFixed(6)} SOL (${(share*100).toFixed(1)}%)\n`;
    
    // Update stats
    const stats = userStats.get(winner.userIdentifier);
    if (stats) {
      stats.wins++;
      stats.totalWon += payout;
      stats.xp += XP_PER_WIN;
      if (payout > stats.biggestWin) stats.biggestWin = payout;
      userStats.set(winner.userIdentifier, stats);
    }
    
    // Update streak
    updateStreak(winner.userIdentifier, true);
    
    // Check for badges
    if (stats?.wins === 1) awardBadge(winner.userIdentifier, 'FIRST_WIN');
    if (stats?.totalBets >= 100) awardBadge(winner.userIdentifier, 'DEGEN');
    if (stats?.totalStaked >= 100) awardBadge(winner.userIdentifier, 'WHALE');
    if (payout >= 10) awardBadge(winner.userIdentifier, 'BIG_WIN');
    
    // Send payout
    if (userWallets.has(winner.userIdentifier)) {
      await sendPayout(
        userWallets.get(winner.userIdentifier).address,
        payout,
        pollNum,
        winner.username,
        winner.userIdentifier
      );
    }
  }
  
  // Process losers
  for (const loser of losers) {
    const stats = userStats.get(loser.userIdentifier);
    if (stats) {
      stats.losses++;
      userStats.set(loser.userIdentifier, stats);
    }
    updateStreak(loser.userIdentifier, false);
  }
  
  // Check streak badges
  for (const winner of winners) {
    const streak = streakTracker.get(winner.userIdentifier);
    if (streak && streak.current >= 5) awardBadge(winner.userIdentifier, 'STREAK_5');
    if (streak && streak.current >= 10) awardBadge(winner.userIdentifier, 'STREAK_10');
  }
  
  ctx.reply(resultMsg, { parse_mode: "Markdown" });
  
  // Archive poll
  targetPoll.settled = true;
  targetPoll.settledAt = Date.now();
  settledPolls.set(targetPollId, targetPoll);
  activePolls.delete(targetPollId);
});

// ============================================
// BUTTON HANDLER
// ============================================
bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  const isAnonymous = ctx.from?.id?.toString() === ANONYMOUS_ADMIN_ID;
  
  if (!isAnonymous && !userWallets.has(userId)) {
    return ctx.answerCbQuery("❌ Register wallet first with /register");
  }
  
  const pollNum = parseInt(ctx.match[1]);
  const choice = ctx.match[2];
  
  const pollId = ctx.callbackQuery.message.message_id.toString();
  const poll = activePolls.get(pollId);
  
  if (!poll) return ctx.answerCbQuery("❌ Poll expired");
  
  if (pendingStakes.has(userId)) {
    return ctx.answerCbQuery("⚠️ You have a pending stake! Use /cancel");
  }
  
  await ctx.answerCbQuery(`✅ Selected ${choice}! Send amount.`);
  
  const stats = userStats.get(userId) || { totalBets: 0 };
  const streak = streakTracker.get(userId)?.current || 0;
  const streakBonus = getStreakBonus(streak);
  
  pendingStakes.set(userId, {
    pollId,
    poll,
    choice,
    pollNum,
    chatId: ctx.chat.id,
    username,
    userId,
    timestamp: Date.now(),
    isAnonymous,
    streakBonus
  });
  
  await ctx.reply(
    `💰 *STAKE MODE*\n\n` +
    `Poll #${pollNum}: ${choice.toUpperCase()}\n` +
    `🔥 Current streak: ${streak} (${streakBonus*100}% bonus!)\n` +
    `💎 Min: ${MIN_STAKE} SOL\n\n` +
    `Send amount now (e.g., 0.5):`,
    { parse_mode: "Markdown" }
  );
  
  // Timeout
  setTimeout(() => {
    if (pendingStakes.has(userId)) {
      pendingStakes.delete(userId);
      ctx.telegram.sendMessage(
        ctx.chat.id,
        `⏱️ ${username} - Stake timeout for poll #${pollNum}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }, STAKE_TIMEOUT);
});

// ============================================
// TEXT HANDLER (Stake amounts)
// ============================================
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  
  if (text.startsWith("/")) return;
  if (!pendingStakes.has(userId)) return;
  
  const stakeData = pendingStakes.get(userId);
  
  // Validate amount
  const validation = validateStakeAmount(text);
  if (!validation.valid) {
    await ctx.reply(
      `❌ ${validation.error}\nYour stake is still pending. Try again:`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  
  const amount = validation.amount;
  
  // Calculate with streak bonus
  const streakBonus = stakeData.streakBonus || 0;
  const bonusAmount = amount * streakBonus;
  const totalAmount = amount + bonusAmount;
  const rake = totalAmount * RAKE_RATE;
  const netAmount = totalAmount - rake;
  
  const walletAddress = userWallets.get(userId)?.address || "Anonymous";
  
  const paymentMsg = 
    `📤 *SEND ${amount} SOL*\n\n` +
    `💰 *Breakdown:*\n` +
    `• Base stake: ${amount} SOL\n` +
    `• Streak bonus: +${bonusAmount.toFixed(6)} SOL (${streakBonus*100}%)\n` +
    `• Total stake: ${totalAmount.toFixed(6)} SOL\n` +
    `• Rake (20%): ${rake.toFixed(6)} SOL\n` +
    `• Net to pot: ${netAmount.toFixed(6)} SOL\n\n` +
    `🏦 *Send to:*\n` +
    `\`${RAKE_WALLET}\`\n\n` +
    `✅ Click *I've Sent* after paying`;
  
  const confirmKeyboard = {
    inline_keyboard: [[
      { text: "✅ I've Sent", callback_data: `confirm_${stakeData.pollNum}_${amount}` }
    ]]
  };
  
  await ctx.reply(paymentMsg, {
    parse_mode: "Markdown",
    reply_markup: confirmKeyboard
  });
  
  // Update pending stake
  pendingStakes.set(userId, {
    ...stakeData,
    amount,
    netAmount,
    rake,
    totalAmount,
    bonusAmount,
    awaitingConfirmation: true
  });
});

// ============================================
// CONFIRM HANDLER
// ============================================
bot.action(/^confirm_(\d+)_([\d.]+)$/, async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const pollNum = parseInt(ctx.match[1]);
  const amount = parseFloat(ctx.match[2]);
  
  if (!pendingStakes.has(userId)) {
    return ctx.answerCbQuery("❌ No pending stake");
  }
  
  const stakeData = pendingStakes.get(userId);
  
  if (stakeData.amount !== amount || stakeData.pollNum !== pollNum) {
    return ctx.answerCbQuery("❌ Data mismatch");
  }
  
  // Generate fake tx ID (in production, this would be real)
  const txId = `sim_${Date.now()}_${Math.random().toString(36)}`;
  
  await confirmStake(userId, stakeData, txId);
  
  await ctx.reply(
    `✅ *STAKE CONFIRMED!*\n\n` +
    `💰 Amount: ${stakeData.amount} SOL\n` +
    `🔥 Bonus: +${stakeData.bonusAmount.toFixed(6)} SOL\n` +
    `📈 Choice: ${stakeData.choice.toUpperCase()}\n` +
    `🎯 Poll: #${stakeData.pollNum}\n\n` +
    `🎰 Jackpot chance: 0.1%`,
    { parse_mode: "Markdown" }
  );
  
  ctx.answerCbQuery("✅ Confirmed!");
});

// ============================================
// LAUNCH BOT
// ============================================
console.log("🚀 Launching ULTIMATE Degen Echo Bot...");
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("✅ BOT IS LIVE!");
    console.log("💰 Your wallet:", RAKE_WALLET);
    console.log("🔥 Auto-payout:", AUTO_PAYOUT_ENABLED ? "ON" : "OFF");
    console.log("👥 Users tracking...");
  })
  .catch(error => {
    console.error("❌ Launch failed:", error);
  });

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach(signal => {
  process.once(signal, () => {
    console.log("🛑 Shutting down...");
    bot.stop(signal);
    process.exit(0);
  });
});
