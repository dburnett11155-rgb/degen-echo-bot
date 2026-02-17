"use strict";

/**
 * Degen Echo Bot - Production Ready
 * Telegram prediction market bot on Solana
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
const JACKPOT_USDC_WALLET = process.env.JACKPOT_USDC_WALLET || RAKE_WALLET;
const ADMIN_IDS = [
  process.env.ADMIN_TELEGRAM_ID,
  "1087968824",
].filter(Boolean);

const RAKE_PERCENT = 0.19;
const HOURLY_POT_PERCENT = 0.80;
const JACKPOT_PERCENT = 0.01;

const MIN_STAKE = 0.001;
const STAKE_TIMEOUT_MS = 3 * 60 * 1000;
const PORT = Number(process.env.PORT) || 3000;

const LIVE_CHANNEL = process.env.LIVE_CHANNEL || "@degenecholive";
const COMMUNITY_GROUP = process.env.COMMUNITY_GROUP || "@degenechochat";
const ANNOUNCEMENTS_CHANNEL = process.env.ANNOUNCEMENTS_CHANNEL || "@degenechochamber";

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
const pendingStakes = new Map();
const userWallets = new Map();
const hourlyBets = new Map();
const processedTxSignatures = new Set();
let jackpotAmountUSDC = 0;
let pollCounter = 0;

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
        if (COINS.includes(pair) && !isNaN(price)) {
          prices.set(pair, price);
        }
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

// ============================================
// SOLANA PAYOUT
// ============================================

async function sendPayout(toAddress, amountSOL, description) {
  if (!botWallet || !connection) {
    log.error("Payout skipped – bot wallet not configured");
    return null;
  }

  try {
    const toPubkey = new PublicKey(toAddress);
    const fromPubkey = botWallet.publicKey;

    const balanceLamports = await connection.getBalance(fromPubkey);
    const neededLamports = Math.ceil(amountSOL * LAMPORTS_PER_SOL) + 5000;
    if (balanceLamports < neededLamports) {
      const have = (balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
      log.warn(`Payout failed – insufficient balance. Have ${have} SOL, need ${amountSOL} SOL`);
      for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(
          adminId,
          `⚠️ *Bot wallet low balance!*\nNeeded: ${amountSOL.toFixed(6)} SOL\nAvailable: ${have} SOL\nFor: ${description}`,
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

    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    log.ok(`Payout sent: ${amountSOL} SOL → ${toAddress} | tx: ${signature}`);
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
  for (const s of stakes) {
    (grouped[s.choice] || []).push(s);
  }

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
  const coinPair = `${poll.coin}/USD`;
  const priceStr = formatPrice(coinPair);
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
// BOT SETUP
// ============================================

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  log.error("Telegraf error:", err.message, "| update:", ctx?.updateType);
});

// Rate limiting
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
    return ctx.reply("⏳ Slow down! You're sending too many messages.").catch(() => {});
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
    `/poll – Create prediction polls\n` +
    `/jackpot – Check jackpot size\n` +
    `/cancel – Cancel a pending stake\n` +
    `/help – Show all commands`,
    { parse_mode: "Markdown" }
  );
});

bot.help((ctx) => {
  return ctx.reply(
    `📋 *Degen Echo Commands*\n\n` +
    `/register <address> – Register your Solana wallet\n` +
    `/balance – Check your on-chain balance\n` +
    `/poll – Spin up prediction polls\n` +
    `/jackpot – View current USDC jackpot\n` +
    `/cancel – Cancel your pending stake\n` +
    `/debug – Bot status (admins only)\n\n` +
    `*How to play:*\n` +
    `1. Register your Solana wallet\n` +
    `2. Click Pump / Dump / Flat on a poll\n` +
    `3. Enter your stake amount in SOL\n` +
    `4. Send SOL to the displayed addresses\n` +
    `5. Type /confirm to lock in your bet\n` +
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
    return ctx.reply("❌ That doesn't look like a valid Solana address. Please double-check and try again.");
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

bot.command("cancel", (ctx) => {
  const userId = getUserIdentifier(ctx);
  const stake = pendingStakes.get(userId);
  if (!stake) return ctx.reply("❌ No pending stake to cancel.");
  clearTimeout(stake.timeoutHandle);
  pendingStakes.delete(userId);
  return ctx.reply("✅ Your pending stake has been cancelled.");
});

bot.command("debug", async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!ADMIN_IDS.includes(userId)) return;
  const botBal = botWallet ? await checkBalance(botWallet.publicKey.toString()) : 0;
  const priceLines = COINS.map((c) => `${c}: $${formatPrice(c)}`).join("\n");
  return ctx.reply(
    `🔧 *Debug Info*\n\n` +
    `Bot Wallet: \`${botWallet?.publicKey.toString() ?? "none"}\`\n` +
    `Bot Balance: ${botBal.toFixed(6)} SOL\n` +
    `Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC\n` +
    `Active Polls: ${activePolls.size}\n` +
    `Pending Stakes: ${pendingStakes.size}\n` +
    `Registered Users: ${userWallets.size}\n` +
    `Uptime: ${Math.floor(process.uptime())}s\n\n` +
    `*Prices:*\n${priceLines}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("poll", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  if (!userWallets.has(userId) && !ADMIN_IDS.includes(ctx.from?.id?.toString())) {
    return ctx.reply("❌ You need to register a wallet first. Use `/register <address>`.", { parse_mode: "Markdown" });
  }

  try {
    await ctx.reply("🚀 Creating prediction polls…");
    for (let i = 0; i < COINS.length; i++) {
      const pair = COINS[i];
      const coin = pair.replace("/USD", "");
      pollCounter++;
      const priceStr = formatPrice(pair);
      const text = buildPollMessage(pollCounter, coin, priceStr, 0);
      const sent = await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: getPollKeyboard(pollCounter),
      });
      if (sent) {
        activePolls.set(sent.message_id.toString(), {
          coin, pollNum: pollCounter, pot: 0, stakes: [],
          chatId: ctx.chat.id, messageId: sent.message_id,
          hour: Math.floor(Date.now() / 3600000),
        });
      }
      if (i < COINS.length - 1) await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    log.error("/poll error:", err.message);
    return ctx.reply("❌ Failed to create polls. Please try again.");
  }
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

  const pollNum = parseInt(ctx.match[1], 10);
  const choice = ctx.match[2];
  const pollId = ctx.callbackQuery.message.message_id.toString();
  const poll = activePolls.get(pollId);

  if (!poll) {
    return ctx.answerCbQuery("❌ This poll has expired.", { show_alert: true }).catch(() => {});
  }

  if (pendingStakes.has(userId)) {
    return ctx.answerCbQuery("⚠️ You have a pending stake. Use /cancel to cancel it.", { show_alert: true }).catch(() => {});
  }

  const timeoutHandle = setTimeout(async () => {
    if (pendingStakes.has(userId)) {
      pendingStakes.delete(userId);
      await bot.telegram.sendMessage(ctx.chat.id, `⏱️ @${username} – your stake timed out. Click a button again to retry.`).catch(() => {});
    }
  }, STAKE_TIMEOUT_MS);

  pendingStakes.set(userId, {
    pollId, poll, choice, pollNum,
    chatId: ctx.chat.id, username, userId,
    timestamp: Date.now(), timeoutHandle,
  });

  const emojiMap = { pump: "🚀", dump: "📉", stagnate: "🟡" };
  await ctx.reply(
    `${emojiMap[choice]} You picked *${choice.toUpperCase()}* on $${poll.coin}!\n\n` +
    `How much SOL do you want to stake? (min ${MIN_STAKE} SOL)\n` +
    `_You have 3 minutes to reply._`,
    { parse_mode: "Markdown" }
  );
});

// ============================================
// TEXT HANDLER
// ============================================

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const userId = getUserIdentifier(ctx);
  if (!pendingStakes.has(userId)) return;

  const stakeData = pendingStakes.get(userId);
  if (stakeData.awaitingConfirmation) return;

  const validation = validateStakeAmount(text);
  if (!validation.valid) return ctx.reply(`❌ ${validation.error}. Please try again:`);

  const amount = validation.amount;
  const rakeAmount = parseFloat((amount * RAKE_PERCENT).toFixed(6));
  const botAmount = parseFloat((amount * (HOURLY_POT_PERCENT + JACKPOT_PERCENT)).toFixed(6));
  const jackpotSOL = parseFloat((amount * JACKPOT_PERCENT).toFixed(6));
  const solPrice = await getSolUsdPrice();
  const jackpotUsdcValue = parseFloat((jackpotSOL * solPrice).toFixed(4));

  clearTimeout(stakeData.timeoutHandle);
  const newTimeoutHandle = setTimeout(async () => {
    if (pendingStakes.has(userId)) {
      pendingStakes.delete(userId);
      await bot.telegram.sendMessage(ctx.chat.id, "⏱️ Confirmation timed out. Please start over.").catch(() => {});
    }
  }, STAKE_TIMEOUT_MS);

  pendingStakes.set(userId, {
    ...stakeData, amount, rakeAmount, botAmount,
    jackpotUsdcValue, awaitingConfirmation: true, timeoutHandle: newTimeoutHandle,
  });

  return ctx.reply(
    `📋 *Stake Summary*\n\n` +
    `💰 Total: *${amount} SOL*\n` +
    `📈 Choice: *${stakeData.choice.toUpperCase()}* on $${stakeData.poll.coin}\n\n` +
    `*Send SOL to these addresses:*\n\n` +
    `🏦 Rake (${(RAKE_PERCENT * 100).toFixed(0)}%): *${rakeAmount} SOL*\n` +
    `\`${RAKE_WALLET}\`\n\n` +
    `🤖 Bot wallet (${((HOURLY_POT_PERCENT + JACKPOT_PERCENT) * 100).toFixed(0)}%): *${botAmount} SOL*\n` +
    `\`${botWallet.publicKey.toString()}\`\n\n` +
    `🏆 Jackpot contribution: +$${jackpotUsdcValue.toFixed(2)} USDC\n\n` +
    `After sending, type /confirm to lock in your bet.\n` +
    `Type /cancel to abort.`,
    { parse_mode: "Markdown" }
  );
});

// ============================================
// CONFIRM COMMAND
// ============================================

bot.command("confirm", async (ctx) => {
  const userId = getUserIdentifier(ctx);
  if (!pendingStakes.has(userId)) return ctx.reply("❌ No pending stake to confirm.");

  const stakeData = pendingStakes.get(userId);
  if (!stakeData.awaitingConfirmation) return ctx.reply("❌ Please enter a stake amount first.");

  clearTimeout(stakeData.timeoutHandle);

  const poll = activePolls.get(stakeData.pollId);
  if (!poll) {
    pendingStakes.delete(userId);
    return ctx.reply("❌ That poll has expired. Please start a new one.");
  }

  const alreadyBet = poll.stakes.some(
    (s) => s.userIdentifier === userId && s.choice === stakeData.choice
  );
  if (alreadyBet) {
    pendingStakes.delete(userId);
    return ctx.reply("⚠️ You already have a stake on this poll for that choice.");
  }

  const potContribution = parseFloat((stakeData.amount * HOURLY_POT_PERCENT).toFixed(6));

  poll.pot += potContribution;
  poll.stakes.push({
    userIdentifier: userId,
    amount: potContribution,
    choice: stakeData.choice,
    username: stakeData.username,
    timestamp: Date.now(),
    confirmed: true,
    hour: Math.floor(Date.now() / 3600000),
  });

  const currentHour = Math.floor(Date.now() / 3600000);
  if (!hourlyBets.has(currentHour)) hourlyBets.set(currentHour, []);
  hourlyBets.get(currentHour).push({
    userId,
    address: userWallets.get(userId)?.address,
    amount: potContribution,
    choice: stakeData.choice,
    username: stakeData.username,
    coin: poll.coin,
    pollId: stakeData.pollId,
  });

  jackpotAmountUSDC += stakeData.jackpotUsdcValue;
  pendingStakes.delete(userId);

  await refreshPollMessage(poll);

  await ctx.reply(
    `✅ *Bet Confirmed!*\n\n` +
    `🎯 ${stakeData.choice.toUpperCase()} on $${poll.coin}\n` +
    `💰 ${stakeData.amount} SOL staked\n` +
    `🏆 Jackpot: +$${stakeData.jackpotUsdcValue.toFixed(2)} USDC\n` +
    `Total Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC\n\n` +
    `Good luck! 🍀`,
    { parse_mode: "Markdown" }
  );

  bot.telegram.sendMessage(
    LIVE_CHANNEL,
    `🎯 *New Bet!*\n👤 ${stakeData.username}\n💰 ${stakeData.amount} SOL → *${stakeData.choice.toUpperCase()}* $${poll.coin}`,
    { parse_mode: "Markdown" }
  ).catch((err) => log.warn("Live channel post failed:", err.message));
});

// ============================================
// HOURLY PAYOUT CRON
// ============================================

cron.schedule("0 * * * *", async () => {
  const lastHour = Math.floor(Date.now() / 3600000) - 1;
  const hourBets = hourlyBets.get(lastHour) || [];

  log.info(`Hourly payout – hour ${lastHour}, ${hourBets.length} bets`);

  if (hourBets.length < 2) {
    log.info("Not enough bets for hourly payout, skipping.");
    hourlyBets.delete(lastHour);
    return;
  }

  const byCoins = new Map();
  for (const bet of hourBets) {
    if (!byCoins.has(bet.coin)) byCoins.set(bet.coin, []);
    byCoins.get(bet.coin).push(bet);
  }

  let totalPaidOut = 0;
  let totalWinners = 0;

  for (const [coin, bets] of byCoins.entries()) {
    const pair = `${coin}/USD`;
    const currentPrice = prices.get(pair);
    if (!currentPrice || currentPrice === 0) {
      log.warn(`No price for ${pair}, skipping payout`);
      continue;
    }

    const totalPot = bets.reduce((s, b) => s + b.amount, 0);
    const choices = { pump: [], dump: [], stagnate: [] };
    for (const b of bets) {
      if (choices[b.choice]) choices[b.choice].push(b);
    }

    // TODO: Replace with actual open/close price comparison
    const winnerChoice = "pump";
    const winners = choices[winnerChoice];
    if (!winners || winners.length === 0) continue;

    const winnerPot = winners.reduce((s, w) => s + w.amount, 0);

    for (const winner of winners) {
      if (!winner.address) continue;
      const share = winner.amount / winnerPot;
      const payout = parseFloat((totalPot * share).toFixed(6));
      const sig = await sendPayout(winner.address, payout, `Hourly – ${coin} ${winnerChoice}`);
      if (sig) { totalPaidOut += payout; totalWinners++; }
    }
  }

  hourlyBets.delete(lastHour);
  for (const [msgId, poll] of activePolls.entries()) {
    if (poll.hour === lastHour) activePolls.delete(msgId);
  }

  await bot.telegram.sendMessage(
    ANNOUNCEMENTS_CHANNEL,
    `⏰ *Hourly Payout Complete!*\n\n` +
    `🏆 Winners paid: ${totalWinners}\n` +
    `💰 Total distributed: ${totalPaidOut.toFixed(6)} SOL\n` +
    `🎰 Jackpot: $${jackpotAmountUSDC.toFixed(2)} USDC`,
    { parse_mode: "Markdown" }
  ).catch((err) => log.warn("Announcement failed:", err.message));

  log.ok(`Hourly payout complete: ${totalWinners} winners, ${totalPaidOut.toFixed(6)} SOL`);
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
    pendingStakes: pendingStakes.size,
    jackpotUSDC: jackpotAmountUSDC,
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
