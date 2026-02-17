"use strict";

/**
 * Degen Echo Bot - Fully Automated
 * Everything runs automatically - polls, payouts, leaderboard, pot updates
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

const RAKE_PERCENT = 0.19;
const HOURLY_POT_PERCENT = 0.80;
const JACKPOT_PERCENT = 0.01;

const MIN_STAKE = 0.001;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const PORT = Number(process.env.PORT) || 3000;

const LIVE_CHANNEL = process.env.LIVE_CHANNEL || "@degenecholive";
const ANNOUNCEMENTS_CHANNEL = process.env.ANNOUNCEMENTS_CHANNEL || "@degenechochamber";
const COMMUNITY_GROUP = process.env.COMMUNITY_GROUP || "@degenechochat";

const COINS = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const ANONYMOUS_ADMIN_ID = "1087968824";

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

const prices = new Map(COINS.map((c) => [c, 0]));
const activePolls = new Map();
const pendingPayments = new Map();
const userWallets = new Map();
const hourlyBets = new Map();
const processedTxSignatures = new Set();

// Leaderboard: userId → { username, totalBets, totalWon, totalStaked, winStreak, bestStreak }
const leaderboard = new Map();

let jackpotAmountUSDC = 0;
let pollCounter = 0;
let totalVolumeSOL = 0;
let totalPayoutsSOL = 0;

// Pinned message IDs for live updates
let pinnedLeaderboardMsgId = null;
let pinnedPotMsgId = null;

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
// PRICE FEED
// ============================================

let wsReconnectDelay = 2000;

function connectPriceWebSocket() {
  let ws;
  try {
    ws = new WebSocket("wss://ws.kraken.com");
  } catch (err) {
    log.error("WebSocket creation failed:", err.message);
    setTimeout(connectPriceWebSocket, wsReconnectDelay);
    return;
  }

  const heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on("open", () => {
    log.ok("Kraken WebSocket connected");
    wsReconnectDelay = 2000;
    ws.send(JSON.stringify({
      event: "subscribe",
      pair: COINS,
      subscription: { name: "ticker" },
    }));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (Array.isArray(msg) && msg[1]?.c) {
        const pair = msg[3];
        const price = parseFloat(msg[1].c[0]);
        if (COINS.includes(pair) && !isNaN(price)) prices.set(pair, price);
      }
    } catch (_) {}
  });

  ws.on("error", (err) => log.error("WebSocket error:", err.message));

  ws.on("close", () => {
    clearInterval(heartbeatTimer);
    log.warn(`WebSocket closed – reconnecting in ${wsReconnectDelay}ms`);
    setTimeout(connectPriceWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  });
}

connectPriceWebSocket();

// ============================================
// HELPERS
// ============================================

function getUserIdentifier(ctx) {
  const userId = ctx.from?.id?.toString();
  if (userId === ANONYMOUS_ADMIN_ID) {
    return ctx.from?.username ? `anon_${ctx.from.username}` : `anon_${userId}`;
  }
  return userId;
}

function isValidSolanaAddress(address) {
  try { new PublicKey(address); return true; } catch { return false; }
}

async function checkBalance(address) {
  try {
    const lamports = await connection.getBalance(new PublicKey(address));
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    log.error("checkBalance:", err.message);
    return 0;
  }
}

function validateStakeAmount(input) {
  const cleaned = input.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(cleaned)) return { valid: false, error: "Please enter a valid number" };
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount < MIN_STAKE) return { valid: false, error: `Minimum stake is ${MIN_STAKE} SOL` };
  if (amount > 1000) return { valid: false, error: "Maximum single stake is 1000 SOL" };
  return { valid: true, amount: Math.round(amount * 1e6) / 1e6 };
}

async function getSolUsdPrice() {
  try {
    const resp = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: 5000 }
    );
    const price = resp.data?.solana?.usd;
    if (typeof price === "number" && price > 0) return price;
  } catch (err) {
    log.warn("CoinGecko price fetch failed:", err.message);
  }
  const krakenSol = prices.get("SOL/USD");
  if (krakenSol > 0) return krakenSol;
  return 20;
}

function formatPrice(pair) {
  const p = prices.get(pair);
  if (!p || p === 0) return "loading…";
  return p < 0.0001 ? p.toExponential(4) : p.toFixed(p < 1 ? 8 : 4);
}

function generateMemoId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// ============================================
// LEADERBOARD HELPERS
// ============================================

function updateLeaderboard(userId, username, staked, won) {
  const entry = leaderboard.get(userId) || {
    username,
    totalBets: 0,
    totalWon: 0,
    totalStaked: 0,
    winStreak: 0,
    bestStreak: 0,
  };

  entry.username = username;
  entry.totalBets++;
  entry.totalStaked += staked;

  if (won > 0) {
    entry.totalWon += won;
    entry.winStreak++;
    if (entry.winStreak > entry.bestStreak) entry.bestStreak = entry.winStreak;
  } else {
    entry.winStreak = 0;
  }

  leaderboard.set(userId, entry);
}

function buildLeaderboardMessage() {
  if (leaderboard.size === 0) {
    return `🏆 *Degen Echo Leaderboard*\n\n_No bets yet – be the first!_`;
  }

  const sorted = [...leaderboard.entries()]
    .sort((a, b) => b[1].totalWon - a[1].totalWon)
    .slice(0, 10);

  const medals = ["🥇", "🥈", "🥉"];
  let msg = `🏆 *Degen Echo Leaderboard*\n\n`;

  sorted.forEach(([, entry], i) => {
    const medal = medals[i] || `${i + 1}.`;
    const winRate = entry.totalBets > 0
      ? ((entry.totalWon / entry.totalStaked) * 100).toFixed(1)
      : "0.0";
    msg += `${medal} *${entry.username}*\n`;
    msg += `   💰 Won: ${entry.totalWon.toFixed(4)} SOL\n`;
    msg += `   🎯 Bets: ${entry.totalBets} | Win rate: ${winRate}%\n`;
    if (entry.winStreak > 1) msg += `   🔥 Streak: ${entry.winStreak}\n`;
    msg += `\n`;
  });

  msg += `📊 *All Time Stats*\n`;
  msg += `💹 Total Volume: ${totalVolumeSOL.toFixed(4)} SOL\n`;
  msg += `💸 Total Paid Out: ${totalPayoutsSOL.toFixed(4)} SOL\n`;
  msg += `🎰 Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC`;

  return msg;
}

function buildPotMessage() {
  let totalPot = 0;
  const potLines = [];

  for (const [, poll] of activePolls.entries()) {
    if (poll.pot > 0) {
      totalPot += poll.pot;
      const pumpTotal = poll.stakes
        .filter(s => s.choice === "pump")
        .reduce((sum, s) => sum + s.amount, 0);
      const dumpTotal = poll.stakes
        .filter(s => s.choice === "dump")
        .reduce((sum, s) => sum + s.amount, 0);
      const flatTotal = poll.stakes
        .filter(s => s.choice === "stagnate")
        .reduce((sum, s) => sum + s.amount, 0);

      potLines.push(
        `$${poll.coin}: *${poll.pot.toFixed(4)} SOL*\n` +
        `   🚀 ${pumpTotal.toFixed(4)} | 📉 ${dumpTotal.toFixed(4)} | 🟡 ${flatTotal.toFixed(4)}`
      );
    }
  }

  let msg = `💰 *Live Pot Update*\n\n`;

  if (potLines.length === 0) {
    msg += `_No active bets yet this hour_\n\n`;
  } else {
    msg += potLines.join("\n\n") + "\n\n";
  }

  msg += `📦 *Total Pot: ${totalPot.toFixed(4)} SOL*\n`;
  msg += `🏆 Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC\n`;
  msg += `⏰ Pays out at the top of the hour`;

  return msg;
}

// ============================================
// AUTO UPDATE LEADERBOARD & POT
// ============================================

async function updateLiveLeaderboard() {
  try {
    const msg = buildLeaderboardMessage();

    if (pinnedLeaderboardMsgId) {
      await bot.telegram.editMessageText(
        COMMUNITY_GROUP,
        pinnedLeaderboardMsgId,
        undefined,
        msg,
        { parse_mode: "Markdown" }
      ).catch(async () => {
        // Message too old to edit, post a new one
        const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, msg, { parse_mode: "Markdown" });
        pinnedLeaderboardMsgId = sent.message_id;
        await bot.telegram.pinChatMessage(COMMUNITY_GROUP, sent.message_id).catch(() => {});
      });
    } else {
      const sent = await bot.telegram.sendMessage(COMMUNITY_GROUP, msg, { parse_mode: "Markdown" });
      pinnedLeaderboardMsgId = sent.message_id;
      await bot.telegram.pinChatMessage(COMMUNITY_GROUP, sent.message_id).catch(() => {});
    }
  } catch (err) {
    log.warn("updateLiveLeaderboard error:", err.message);
  }
}

async function updateLivePot() {
  try {
    const msg = buildPotMessage();

    if (pinnedPotMsgId) {
      await bot.telegram.editMessageText(
        LIVE_CHANNEL,
        pinnedPotMsgId,
        undefined,
        msg,
        { parse_mode: "Markdown" }
      ).catch(async () => {
        const sent = await bot.telegram.sendMessage(LIVE_CHANNEL, msg, { parse_mode: "Markdown" });
        pinnedPotMsgId = sent.message_id;
        await bot.telegram.pinChatMessage(LIVE_CHANNEL, sent.message_id).catch(() => {});
      });
    } else {
      const sent = await bot.telegram.sendMessage(LIVE_CHANNEL, msg, { parse_mode: "Markdown" });
      pinnedPotMsgId = sent.message_id;
      await bot.telegram.pinChatMessage(LIVE_CHANNEL, sent.message_id).catch(() => {});
    }
  } catch (err) {
    log.warn("updateLivePot error:", err.message);
  }
}

// ============================================
// BLOCKCHAIN PAYMENT WATCHER
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

      if (!tx) continue;

      const logMessages = tx.meta?.logMessages || [];
      const hasMemo = logMessages.some((msg) => msg.includes(memoId));
      if (!hasMemo) continue;

      const accountKeys = tx.transaction.message.accountKeys;
      const botIndex = accountKeys.findIndex(
        (k) => k.pubkey.toString() === botPubkey.toString()
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

async function handlePaymentReceived(memoId, signature, receivedAmount) {
  const payment = pendingPayments.get(memoId);
  if (!payment) return;

  clearTimeout(payment.timeoutHandle);
  pendingPayments.delete(memoId);

  const { userId, username, chatId, poll, choice } = payment;
  const amount = Math.round(receivedAmount * 1e6) / 1e6;
  const potContribution = parseFloat((amount * HOURLY_POT_PERCENT).toFixed(6));
  const jackpotSOL = parseFloat((amount * JACKPOT_PERCENT).toFixed(6));
  const solPrice = await getSolUsdPrice();
  const jackpotUsdcValue = parseFloat((jackpotSOL * solPrice).toFixed(4));

  poll.pot += potContribution;
  poll.stakes.push({
    userIdentifier: userId,
    amount: potContribution,
    choice,
    username,
    timestamp: Date.now(),
    confirmed: true,
    signature,
    hour: Math.floor(Date.now() / 3600000),
  });

  const currentHour = Math.floor(Date.now() / 3600000);
  if (!hourlyBets.has(currentHour)) hourlyBets.set(currentHour, []);
  hourlyBets.get(currentHour).push({
    userId,
    address: userWallets.get(userId)?.address,
    amount: potContribution,
    choice,
    username,
    coin: poll.coin,
    pollId: payment.pollId,
  });

  jackpotAmountUSDC += jackpotUsdcValue;
  totalVolumeSOL += amount;

  // Update leaderboard entry (won = 0 until payout)
  updateLeaderboard(userId, username, amount, 0);

  await refreshPollMessage(poll);

  // Update live displays
  await updateLivePot();
  await updateLiveLeaderboard();

  const emojiMap = { pump: "🚀", dump: "📉", stagnate: "🟡" };
  await bot.telegram.sendMessage(
    chatId,
    `${emojiMap[choice]} *Payment confirmed on-chain!*\n\n` +
    `✅ Bet registered automatically\n` +
    `🎯 ${choice.toUpperCase()} on $${poll.coin}\n` +
    `💰 ${amount} SOL staked\n` +
    `🏆 Jackpot: +$${jackpotUsdcValue.toFixed(2)} USDC\n\n` +
    `Good luck! 🍀\n` +
    `_TX: ${signature.slice(0, 8)}…${signature.slice(-8)}_`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  bot.telegram.sendMessage(
    LIVE_CHANNEL,
    `🎯 *New Bet!*\n👤 ${username}\n💰 ${amount} SOL → *${choice.toUpperCase()}* $${poll.coin}\n💰 Pot now: ${poll.pot.toFixed(4)} SOL`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  log.ok(`Payment confirmed: ${amount} SOL from ${username} | memo: ${memoId}`);
}

async function handlePaymentTimeout(memoId) {
  const payment = pendingPayments.get(memoId);
  if (!payment) return;
  pendingPayments.delete(memoId);
  await bot.telegram.sendMessage(
    payment.chatId,
    `⏱️ *Payment window expired*\n\nNo SOL detected for memo \`${memoId}\`.\nClick a poll button again to start a new bet.`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ============================================
// PAYOUT FUNCTION
// ============================================

async function sendPayout(toAddress, amountSOL, description) {
  if (!botWallet || !connection) return null;

  try {
    const toPubkey = new PublicKey(toAddress);
    const fromPubkey = botWallet.publicKey;
    const balanceLamports = await connection.getBalance(fromPubkey);
    const neededLamports = Math.ceil(amountSOL * LAMPORTS_PER_SOL) + 5000;

    if (balanceLamports < neededLamports) {
      const have = (balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
      for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(
          adminId,
          `⚠️ *Bot wallet low!*\nNeeded: ${amountSOL.toFixed(6)} SOL\nAvailable: ${have} SOL`,
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

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    log.ok(`Payout: ${amountSOL} SOL → ${toAddress} | ${description}`);
    return signature;
  } catch (err) {
    log.error("sendPayout failed:", err.message);
    return null;
  }
}

// ============================================
// POLL HELPERS
// ============================================

function buildPollMessage(pollNum, coin, priceStr, pot, stakes = []) {
  const header =
    `🎰 *Degen Echo #${pollNum}* – $${coin} @ $${priceStr}\n` +
    `💰 Pot: *${pot.toFixed(6)} SOL*\n` +
    `🏆 Jackpot: *$${jackpotAmountUSDC.toFixed(2)} USDC*\n`;

  if (stakes.length === 0) return header + "\n_No stakes yet – be first!_";

  const grouped = { pump: [], dump: [], stagnate: [] };
  for (const s of stakes) (grouped[s.choice] || []).push(s);

  let body = "\n📊 *Current Stakes:*\n";
  const labels = { pump: "🚀 PUMP", dump: "📉 DUMP", stagnate: "🟡 FLAT" };
  for (const [choice, list] of Object.entries(grouped)) {
    if (list.length === 0) continue;
    const total = list.reduce((sum, s) => sum + s.amount, 0);
    body += `${labels[choice]}: ${total.toFixed(6)} SOL (${list.length} bet${list.length > 1 ? "s" : ""})\n`;
  }

  return header + body;
}

function getPollKeyboard(pollNum) {
  return {
    inline_keyboard: [[
      { text: "🚀 Pump", callback_data: `vote_${pollNum}_pump` },
      { text: "📉 Dump", callback_data: `vote_${pollNum}_dump` },
      { text: "🟡 Flat", callback_data: `vote_${pollNum}_stagnate` },
    ]],
  };
}

async function refreshPollMessage(poll) {
  const priceStr = formatPrice(`${poll.coin}/USD`);
  const text = buildPollMessage(poll.pollNum, poll.coin, priceStr, poll.pot, poll.stakes);
  try {
    await bot.telegram.editMessageText(
      poll.chatId, poll.messageId, undefined, text,
      { parse_mode: "Markdown", reply_markup: getPollKeyboard(poll.pollNum) }
    );
  } catch (err) {
    if (!err.message?.includes("not modified")) log.warn("refreshPollMessage:", err.message);
  }
}

// ============================================
// CREATE POLLS
// ============================================

async function createPolls(chatId) {
  const results = [];
  for (let i = 0; i < COINS.length; i++) {
    const pair = COINS[i];
    const coin = pair.replace("/USD", "");
    pollCounter++;
    const priceStr = formatPrice(pair);
    const text = buildPollMessage(pollCounter, coin, priceStr, 0);

    try {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: getPollKeyboard(pollCounter),
      });

      if (sent) {
        const pollData = {
          coin,
          pollNum: pollCounter,
          pot: 0,
          stakes: [],
          chatId: sent.chat.id,
          messageId: sent.message_id,
          hour: Math.floor(Date.now() / 3600000),
          openPrice: prices.get(pair) || 0,
        };
        activePolls.set(sent.message_id.toString(), pollData);
        results.push(pollData);
      }

      if (i < COINS.length - 1) await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      log.error(`Failed to create poll for ${coin}:`, err.message);
    }
  }
  return results;
}

// ============================================
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  log.error("Telegraf error:", err.message, "| update:", ctx?.updateType);
});

const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

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
    return ctx.reply("⏳ Slow down! Too many messages.").catch(() => {});
  }
  return next();
});

// ============================================
// COMMANDS
// ============================================

bot.start((ctx) => {
  const name = ctx.from.first_name || "Degen";
  return ctx.reply(
    `🎰 *Welcome to Degen Echo, ${name}!*\n\n` +
    `Predict crypto price moves and win SOL.\n\n` +
    `*Commands:*\n` +
    `/register <wallet> – Link your Solana wallet\n` +
    `/balance – Check your wallet balance\n` +
    `/leaderboard – View top players\n` +
    `/jackpot – Check jackpot size\n` +
    `/stats – Your personal stats\n` +
    `/cancel – Cancel a pending bet\n` +
    `/help – Show all commands`,
    { parse_mode: "Markdown" }
  );
});

bot.help((ctx) => {
  return ctx.reply(
    `📋 *Degen Echo Commands*\n\n` +
    `/register <address> – Register your Solana wallet\n` +
    `/balance – Check your on-chain balance\n` +
    `/leaderboard – View top players\n` +
    `/jackpot – View current USDC jackpot\n` +
    `/stats – Your personal stats\n` +
    `/cancel – Cancel your pending bet\n` +
    `/debug – Bot status (admins only)\n\n` +
    `*How to play:*\n` +
    `1. Register your Solana wallet\n` +
    `2. Click Pump / Dump / Flat on a poll\n` +
    `3. Enter your stake amount\n` +
    `4. Send SOL with the memo shown\n` +
    `5. Bot detects payment automatically ✅\n` +
    `6. Hourly payouts to winners! 🎉`,
    { parse_mode: "Markdown" }
  );
});

bot.command("register", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.trim().split(/\s+/);

  if (args.length !== 2) {
    return ctx.reply("Usage: `/register <solana_wallet_address>`", { parse_mode: "Markdown" });
  }

  const walletAddress = args[1].trim();
  if (!isValidSolanaAddress(walletAddress)) {
    return ctx.reply("❌ Invalid Solana address. Please check and try again.");
  }
  if (walletAddress === botWallet.publicKey.toString() || walletAddress === RAKE_WALLET) {
    return ctx.reply("❌ You cannot register a system wallet.");
  }

  const balance = await checkBalance(walletAddress);
  userWallets.set(userId, { address: walletAddress, username, registeredAt: Date.now() });

  return ctx.reply(
    `✅ *Wallet Registered!*\n\n` +
    `👤 ${username}\n` +
    `💳 \`${walletAddress}\`\n` +
    `💰 Balance: ${balance.toFixed(6)} SOL`,
    { parse_mode: "Markdown" }
  );
});

bot.command("balance", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  if (!userWallets.has(userId)) {
    return ctx.reply("❌ No wallet registered. Use `/register <address>` first.", { parse_mode: "Markdown" });
  }
  const { address } = userWallets.get(userId);
  const balance = await checkBalance(address);
  return ctx.reply(
    `💰 *Wallet Balance*\n\n\`${address}\`\nBalance: *${balance.toFixed(6)} SOL*`,
    { parse_mode: "Markdown" }
  );
});

bot.command("leaderboard", async (ctx) => {
  return ctx.reply(buildLeaderboardMessage(), { parse_mode: "Markdown" });
});

bot.command("stats", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  const entry = leaderboard.get(userId);

  if (!entry) {
    return ctx.reply("❌ No stats yet. Place a bet first!");
  }

  const winRate = entry.totalBets > 0
    ? ((entry.totalWon / entry.totalStaked) * 100).toFixed(1)
    : "0.0";

  return ctx.reply(
    `📊 *Your Stats*\n\n` +
    `👤 ${entry.username}\n` +
    `🎯 Total Bets: ${entry.totalBets}\n` +
    `💰 Total Staked: ${entry.totalStaked.toFixed(4)} SOL\n` +
    `🏆 Total Won: ${entry.totalWon.toFixed(4)} SOL\n` +
    `📈 Win Rate: ${winRate}%\n` +
    `🔥 Current Streak: ${entry.winStreak}\n` +
    `⭐ Best Streak: ${entry.bestStreak}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("jackpot", async (ctx) => {
  const solPrice = await getSolUsdPrice();
  const botBalSOL = botWallet
    ? (await checkBalance(botWallet.publicKey.toString())).toFixed(4)
    : "N/A";
  return ctx.reply(
    `🏆 *Jackpot Status*\n\n` +
    `💵 Jackpot: *$${jackpotAmountUSDC.toFixed(2)} USDC*\n` +
    `💲 SOL Price: $${solPrice.toFixed(2)}\n` +
    `🤖 Bot Wallet: ${botBalSOL} SOL`,
    { parse_mode: "Markdown" }
  );
});

bot.command("cancel", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  let found = null;
  for (const [memoId, payment] of pendingPayments.entries()) {
    if (payment.userId === userId) { found = memoId; break; }
  }
  if (!found) return ctx.reply("❌ No pending bet to cancel.");
  const payment = pendingPayments.get(found);
  clearTimeout(payment.timeoutHandle);
  pendingPayments.delete(found);
  return ctx.reply(
    `✅ Pending bet cancelled.\n\n⚠️ If you already sent SOL with memo \`${found}\`, contact an admin for a refund.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("debug", async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!ADMIN_IDS.includes(userId)) return;
  const botBal = botWallet ? await checkBalance(botWallet.publicKey.toString()) : 0;
  const priceLines = COINS.map((c) => `${c}: $${formatPrice(c)}`).join("\n");
  return ctx.reply(
    `🔧 *Debug Info*\n\n` +
    `Bot Balance: ${botBal.toFixed(6)} SOL\n` +
    `Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC\n` +
    `Total Volume: ${totalVolumeSOL.toFixed(4)} SOL\n` +
    `Total Payouts: ${totalPayoutsSOL.toFixed(4)} SOL\n` +
    `Active Polls: ${activePolls.size}\n` +
    `Pending Payments: ${pendingPayments.size}\n` +
    `Registered Users: ${userWallets.size}\n` +
    `Leaderboard Entries: ${leaderboard.size}\n` +
    `Uptime: ${Math.floor(process.uptime())}s\n\n` +
    `*Prices:*\n${priceLines}`,
    { parse_mode: "Markdown" }
  );
});

// ============================================
// BUTTON HANDLER
// ============================================

bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const userId = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";

  if (!userWallets.has(userId) && !ADMIN_IDS.includes(ctx.from?.id?.toString())) {
    return ctx.answerCbQuery("❌ Register your wallet first with /register", { show_alert: true }).catch(() => {});
  }

  const choice = ctx.match[2];
  const pollId = ctx.callbackQuery.message.message_id.toString();
  const poll = activePolls.get(pollId);

  if (!poll) {
    return ctx.answerCbQuery("❌ This poll has expired.", { show_alert: true }).catch(() => {});
  }

  for (const [, payment] of pendingPayments.entries()) {
    if (payment.userId === userId) {
      return ctx.answerCbQuery("⚠️ You have a pending payment. Use /cancel to cancel it.", { show_alert: true }).catch(() => {});
    }
  }

  const emojiMap = { pump: "🚀", dump: "📉", stagnate: "🟡" };
  await ctx.reply(
    `${emojiMap[choice]} You picked *${choice.toUpperCase()}* on $${poll.coin}!\n\nHow much SOL? _(min ${MIN_STAKE} SOL)_`,
    { parse_mode: "Markdown" }
  );

  const tempKey = `temp_${userId}`;
  pendingPayments.set(tempKey, {
    userId, username, chatId: ctx.chat.id,
    pollId, poll, choice, awaitingAmount: true,
  });

  setTimeout(() => {
    if (pendingPayments.has(tempKey)) {
      pendingPayments.delete(tempKey);
      bot.telegram.sendMessage(ctx.chat.id, `⏱️ Timed out. Click a button again to retry.`).catch(() => {});
    }
  }, PAYMENT_TIMEOUT_MS);
});

// ============================================
// TEXT HANDLER
// ============================================

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const userId = getUserIdentifier(ctx);
  const tempKey = `temp_${userId}`;
  if (!pendingPayments.has(tempKey)) return;

  const partial = pendingPayments.get(tempKey);
  if (!partial.awaitingAmount) return;

  const validation = validateStakeAmount(text);
  if (!validation.valid) return ctx.reply(`❌ ${validation.error}. Please try again:`);

  const amount = validation.amount;
  const rakeAmount = parseFloat((amount * RAKE_PERCENT).toFixed(6));
  const botAmount = parseFloat((amount * (HOURLY_POT_PERCENT + JACKPOT_PERCENT)).toFixed(6));
  const memoId = generateMemoId();
  const expiresAt = Date.now() + PAYMENT_TIMEOUT_MS;

  pendingPayments.delete(tempKey);

  const timeoutHandle = setTimeout(() => handlePaymentTimeout(memoId), PAYMENT_TIMEOUT_MS);

  pendingPayments.set(memoId, {
    userId,
    username: partial.username,
    chatId: partial.chatId,
    pollId: partial.pollId,
    poll: partial.poll,
    choice: partial.choice,
    minAmount: amount,
    expiresAt,
    timeoutHandle,
  });

  await ctx.reply(
    `📋 *Payment Instructions*\n\n` +
    `💰 Total: *${amount} SOL*\n` +
    `📈 Bet: *${partial.choice.toUpperCase()}* on $${partial.poll.coin}\n\n` +
    `*Send to two addresses with memo* \`${memoId}\`*:*\n\n` +
    `🏦 *Rake (${(RAKE_PERCENT * 100).toFixed(0)}%):* ${rakeAmount} SOL\n` +
    `\`${RAKE_WALLET}\`\n\n` +
    `🤖 *Bot wallet (${((HOURLY_POT_PERCENT + JACKPOT_PERCENT) * 100).toFixed(0)}%):* ${botAmount} SOL\n` +
    `\`${botWallet.publicKey.toString()}\`\n\n` +
    `🔑 *Memo ID:* \`${memoId}\`\n` +
    `_(Must include memo or bet won't be detected)_\n\n` +
    `⏱️ You have *5 minutes* to send.\n` +
    `Bot confirms automatically once on-chain. ✅`,
    { parse_mode: "Markdown" }
  );

  setTimeout(() => watchForPayment(memoId), POLL_INTERVAL_MS);
});

// ============================================
// HOURLY CRON — payouts + fresh polls
// ============================================

cron.schedule("0 * * * *", async () => {
  const lastHour = Math.floor(Date.now() / 3600000) - 1;
  const hourBets = hourlyBets.get(lastHour) || [];

  log.info(`Hourly cron – hour ${lastHour}, ${hourBets.length} bets`);

  // ── PAYOUTS ──
  if (hourBets.length >= 2) {
    const byCoins = new Map();
    for (const bet of hourBets) {
      if (!byCoins.has(bet.coin)) byCoins.set(bet.coin, []);
      byCoins.get(bet.coin).push(bet);
    }

    let totalPaidOut = 0;
    let totalWinners = 0;
    const resultLines = [];

    for (const [coin, bets] of byCoins.entries()) {
      const pair = `${coin}/USD`;
      const currentPrice = prices.get(pair);
      if (!currentPrice || currentPrice === 0) continue;

      let openPrice = 0;
      for (const [, poll] of activePolls.entries()) {
        if (poll.coin === coin && poll.hour === lastHour) {
          openPrice = poll.openPrice || 0;
          break;
        }
      }
      if (openPrice === 0) continue;

      let winnerChoice;
      if (currentPrice > openPrice * 1.001) winnerChoice = "pump";
      else if (currentPrice < openPrice * 0.999) winnerChoice = "dump";
      else winnerChoice = "stagnate";

      const emojiMap = { pump: "🚀", dump: "📉", stagnate: "🟡" };
      resultLines.push(`$${coin}: ${emojiMap[winnerChoice]} ${winnerChoice.toUpperCase()} (open: $${openPrice.toFixed(4)} → close: $${currentPrice.toFixed(4)})`);

      const totalPot = bets.reduce((s, b) => s + b.amount, 0);
      const choices = { pump: [], dump: [], stagnate: [] };
      for (const b of bets) {
        if (choices[b.choice]) choices[b.choice].push(b);
      }

      const winners = choices[winnerChoice];
      if (!winners || winners.length === 0) continue;

      const winnerPot = winners.reduce((s, w) => s + w.amount, 0);

      for (const winner of winners) {
        if (!winner.address) continue;
        const share = winner.amount / winnerPot;
        const payout = parseFloat((totalPot * share).toFixed(6));
        const sig = await sendPayout(winner.address, payout, `Hourly – ${coin} ${winnerChoice}`);

        if (sig) {
          totalPaidOut += payout;
          totalWinners++;
          totalPayoutsSOL += payout;

          // Update leaderboard with winnings
          updateLeaderboard(winner.userId, winner.username, 0, payout);

          await bot.telegram.sendMessage(
            winner.userId,
            `🏆 *You won!*\n\n` +
            `$${coin} went *${winnerChoice.toUpperCase()}*\n` +
            `💰 You received *${payout.toFixed(6)} SOL*\n` +
            `_TX: ${sig.slice(0, 8)}…${sig.slice(-8)}_`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }
    }

    hourlyBets.delete(lastHour);
    for (const [msgId, poll] of activePolls.entries()) {
      if (poll.hour === lastHour) activePolls.delete(msgId);
    }

    // Post results
    await bot.telegram.sendMessage(
      ANNOUNCEMENTS_CHANNEL,
      `⏰ *Hourly Results*\n\n` +
      resultLines.join("\n") + "\n\n" +
      `🏆 Winners: ${totalWinners}\n` +
      `💰 Paid out: ${totalPaidOut.toFixed(6)} SOL\n` +
      `🎰 Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    log.ok(`Payouts done: ${totalWinners} winners, ${totalPaidOut.toFixed(6)} SOL`);
  } else {
    hourlyBets.delete(lastHour);
    for (const [msgId, poll] of activePolls.entries()) {
      if (poll.hour === lastHour) activePolls.delete(msgId);
    }
  }

  // ── CREATE NEW POLLS ──
  await createPolls(LIVE_CHANNEL);

  // ── UPDATE LEADERBOARD ──
  await updateLiveLeaderboard();

  // Reset pot display for new hour
  pinnedPotMsgId = null;
  await updateLivePot();

  log.ok("New polls created and displays updated");
});

// ── Update pot display every 5 minutes ──
cron.schedule("*/5 * * * *", async () => {
  await updateLivePot();
});

// ── Update leaderboard every 15 minutes ──
cron.schedule("*/15 * * * *", async () => {
  await updateLiveLeaderboard();
});

// ============================================
// CLEANUP
// ============================================

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_WINDOW_MS * 2) rateLimitMap.delete(userId);
  }
  if (processedTxSignatures.size > 10000) {
    [...processedTxSignatures].slice(0, 5000).forEach((s) => processedTxSignatures.delete(s));
  }
}, 10 * 60 * 1000);

// ============================================
// EXPRESS HEALTH CHECK
// ============================================

const app = express();

app.get("/", (_req, res) => res.send("Degen Echo Bot — Running"));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    users: userWallets.size,
    activePolls: activePolls.size,
    pendingPayments: pendingPayments.size,
    jackpotUSDC: jackpotAmountUSDC,
    totalVolumeSOL,
    totalPayoutsSOL,
    leaderboardSize: leaderboard.size,
    botWallet: botWallet?.publicKey.toString(),
    prices: Object.fromEntries(prices),
  });
});

app.get("/ready", (_req, res) => {
  if (botWallet && connection) res.sendStatus(200);
  else res.sendStatus(503);
});

app.listen(PORT, "0.0.0.0", () => log.ok(`Health check server on port ${PORT}`));

// ============================================
// LAUNCH
// ============================================

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    log.ok("Bot is LIVE!");
    log.ok("Rake wallet:", RAKE_WALLET);
    log.ok("Bot wallet:", botWallet.publicKey.toString());
    // Wait 5 seconds for prices to load then create startup polls
    setTimeout(async () => {
      await createPolls(LIVE_CHANNEL);
      await updateLiveLeaderboard();
      await updateLivePot();
    }, 5000);
  })
  .catch((err) => {
    log.error("Bot launch failed:", err.message);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log.info(`Received ${signal} – shutting down…`);
    bot.stop(signal);
    setTimeout(() => process.exit(0), 2000);
  });
}
