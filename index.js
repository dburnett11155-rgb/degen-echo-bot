const { Telegraf } = require("telegraf");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require("@solana/web3.js");
const WebSocket = require("ws");
const express = require("express");
const bs58 = require('bs58');

// Configuration
const BOT_TOKEN = "8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o";
const RAKE_WALLET = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const RAKE_RATE = 0.2; // 20%
const STAKE_TIMEOUT = 180000; // 3 minutes
const MIN_STAKE = 0.001; // Minimum SOL stake
const PORT = process.env.PORT || 3000;

// Solana connection
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC, "confirmed");

// Special Telegram anonymous admin ID
const ANONYMOUS_ADMIN_ID = "1087968824";

// Solana coins
const COINS = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Price storage
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Active polls and pending stakes
const activePolls = new Map();
const pendingStakes = new Map();
const userWallets = new Map(); // Store user wallet addresses

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize Express app
const app = express();

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Degen Echo Bot is running!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activePolls: activePolls.size,
    pendingStakes: pendingStakes.size,
    registeredUsers: userWallets.size
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// Helper function to validate Solana address
function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Helper function to check SOL balance
async function checkBalance(address) {
  try {
    const publicKey = new PublicKey(address);
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error("Error checking balance:", error);
    return 0;
  }
}

// Helper function to get user identifier
function getUserIdentifier(ctx) {
  const userId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id?.toString();
  
  if (userId === ANONYMOUS_ADMIN_ID) {
    if (ctx.from?.username) {
      return `anon_${ctx.from.username}`;
    }
    return `anon_${chatId}_${ctx.message?.message_id || Date.now()}`;
  }
  
  return userId;
}

// Helper function to validate stake amount
function validateStakeAmount(input) {
  const cleaned = input.trim().replace(',', '.');
  
  if (!/^\d*\.?\d+$/.test(cleaned)) {
    return { valid: false, error: "Invalid number format. Please use numbers only (e.g., 0.5)" };
  }
  
  const amount = parseFloat(cleaned);
  
  if (isNaN(amount)) {
    return { valid: false, error: "Not a valid number" };
  }
  
  if (amount <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }
  
  if (amount < MIN_STAKE) {
    return { valid: false, error: `Minimum stake is ${MIN_STAKE} SOL` };
  }
  
  const roundedAmount = Math.round(amount * 1000000) / 1000000;
  
  return { valid: true, amount: roundedAmount };
}

// WebSocket for price updates
function connectPriceWebSocket() {
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
    } catch (e) {
      console.error("WS parse error:", e.message);
    }
  });

  ws.on("error", (error) => {
    console.error("WS error:", error.message);
  });

  ws.on("close", () => {
    console.log("WS closed - reconnecting in 5s...");
    setTimeout(connectPriceWebSocket, 5000);
  });

  return ws;
}

connectPriceWebSocket();

// Build poll message
function buildPollMessage(pollNum, coin, price, pot, stakes = []) {
  let msg = `🎰 *Degen Echo #${pollNum}* – *$${coin}* at *$${price}* – next 1H vibe?\n`;
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
      msg += `${emoji} *${choice.toUpperCase()}*: ${total.toFixed(6)} SOL (${stakeList.length} ${stakeList.length === 1 ? 'player' : 'players'})\n`;
      
      stakeList.forEach(s => {
        const displayName = s.username === "Anonymous" ? "Anonymous Admin" : s.username;
        const status = s.confirmed ? "✅" : "⏳";
        msg += `  ${status} ${displayName}: ${s.amount.toFixed(6)} SOL\n`;
      });
    }
  } else {
    msg += `\n❌ No stakes yet - Be the first to bet!`;
  }
  
  return msg;
}

// Create poll keyboard
function getPollKeyboard(pollNum) {
  return {
    inline_keyboard: [[
      { text: "🚀 Pump", callback_data: `vote_${pollNum}_pump` },
      { text: "📉 Dump", callback_data: `vote_${pollNum}_dump` },
      { text: "🟡 Stagnate", callback_data: `vote_${pollNum}_stagnate` }
    ]]
  };
}

// Command: /start
bot.start(ctx => {
  const username = ctx.from.username || ctx.from.first_name || "User";
  ctx.reply(
    `🎰 *Welcome to Degen Echo Bot, ${username}!*\n\n` +
    "📌 *How to play:*\n" +
    "1️⃣ First, register your Solana wallet with /register\n" +
    "2️⃣ Use /poll to create prediction polls\n" +
    "3️⃣ Click a button to vote\n" +
    "4️⃣ Send your stake amount\n" +
    "5️⃣ Send your SOL to the provided address\n\n" +
    "💰 *Rake:* 20% goes to the house wallet\n" +
    "💎 *Min stake:* 0.001 SOL\n\n" +
    "📋 *Commands:*\n" +
    "/register <wallet_address> - Register your Solana wallet\n" +
    "/balance - Check your wallet balance\n" +
    "/poll - Create new polls\n" +
    "/cancel - Cancel your pending stake\n" +
    "/chaos - Check market chaos score\n" +
    "/debug - View bot status\n" +
    "/help - Show this message",
    { parse_mode: "Markdown" }
  );
});

// Command: /register
bot.command("register", async ctx => {
  const userIdentifier = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  const args = ctx.message.text.split(' ');
  
  if (args.length !== 2) {
    return ctx.reply(
      "❌ *Invalid format*\n\n" +
      "Usage: `/register <your_solana_wallet_address>`\n" +
      "Example: `/register 9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK`",
      { parse_mode: "Markdown" }
    );
  }
  
  const walletAddress = args[1].trim();
  
  if (!isValidSolanaAddress(walletAddress)) {
    return ctx.reply(
      "❌ *Invalid Solana wallet address*\n\n" +
      "Please check your address and try again.",
      { parse_mode: "Markdown" }
    );
  }
  
  // Check if wallet has minimum balance
  const balance = await checkBalance(walletAddress);
  
  userWallets.set(userIdentifier, {
    address: walletAddress,
    registeredAt: Date.now()
  });
  
  ctx.reply(
    `✅ *Wallet Registered Successfully!*\n\n` +
    `👤 *User:* ${username}\n` +
    `💳 *Wallet:* \`${walletAddress}\`\n` +
    `💰 *Balance:* ${balance.toFixed(6)} SOL\n\n` +
    `You can now place bets using /poll!`,
    { parse_mode: "Markdown" }
  );
});

// Command: /balance
bot.command("balance", async ctx => {
  const userIdentifier = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  if (!userWallets.has(userIdentifier)) {
    return ctx.reply(
      "❌ *No wallet registered*\n\n" +
      "Please register your wallet first with:\n" +
      "`/register <your_solana_wallet_address>`",
      { parse_mode: "Markdown" }
    );
  }
  
  const walletData = userWallets.get(userIdentifier);
  const balance = await checkBalance(walletData.address);
  
  ctx.reply(
    `💰 *Balance Check - ${username}*\n\n` +
    `💳 *Wallet:* \`${walletData.address}\`\n` +
    `💎 *Balance:* ${balance.toFixed(6)} SOL\n\n` +
    `Minimum stake: ${MIN_STAKE} SOL`,
    { parse_mode: "Markdown" }
  );
});

// Command: /help
bot.help(ctx => {
  ctx.reply(
    "📋 *Available Commands:*\n\n" +
    "/register <address> - Register your Solana wallet\n" +
    "/balance - Check your wallet balance\n" +
    "/poll - Create 4 new prediction polls\n" +
    "/cancel - Cancel your pending stake\n" +
    "/chaos - Get random market chaos score\n" +
    "/debug - View current bot status\n" +
    "/start - Welcome message\n" +
    "/help - Show this help",
    { parse_mode: "Markdown" }
  );
});

// Command: /debug
bot.command("debug", ctx => {
  let msg = `📊 *Debug Info:*\n`;
  msg += `Active Polls: ${activePolls.size}\n`;
  msg += `Pending Stakes: ${pendingStakes.size}\n`;
  msg += `Registered Users: ${userWallets.size}\n\n`;
  msg += `*Current Prices:*\n`;
  
  for (const [coin, price] of Object.entries(prices)) {
    msg += `• ${coin}: $${price}\n`;
  }
  
  if (pendingStakes.size > 0) {
    msg += `\n⏳ *Waiting for stakes from:*\n`;
    for (const [userId, value] of pendingStakes.entries()) {
      msg += `• ${value.username} - Poll #${value.pollNum} (${value.choice})\n`;
    }
  }
  
  ctx.reply(msg, { parse_mode: "Markdown" });
});

// Command: /poll
bot.command("poll", async ctx => {
  const userIdentifier = getUserIdentifier(ctx);
  
  // Check if user has registered wallet
  if (!userWallets.has(userIdentifier) && userIdentifier !== ANONYMOUS_ADMIN_ID) {
    return ctx.reply(
      "❌ *Wallet Required*\n\n" +
      "You need to register your Solana wallet first:\n" +
      "`/register <your_solana_wallet_address>`",
      { parse_mode: "Markdown" }
    );
  }
  
  try {
    await ctx.reply(
      "🚀 *Creating 4 polls for SOL, BONK, WIF, JUP!*\n\n" +
      "👥 *Everyone can vote and stake!*\n" +
      "👉 Click a button, then send your stake amount\n" +
      "💰 Minimum stake: 0.001 SOL",
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

      activePolls.set(sent.message_id.toString(), {
        coin,
        pollNum,
        pot: 0,
        stakes: [],
        chatId: ctx.chat.id,
        messageId: sent.message_id,
        createdAt: Date.now()
      });
    }
  } catch (error) {
    console.error("Poll creation error:", error);
    ctx.reply("❌ Error creating polls. Please try again.");
  }
});

// Command: /chaos
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
  
  ctx.reply(
    `🎲 *Chaos Score:* ${score}/100\n` +
    `📊 *Vibe:* ${vibe} ${emoji}`,
    { parse_mode: "Markdown" }
  );
});

// Command: /cancel
bot.command("cancel", ctx => {
  const userIdentifier = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  
  if (pendingStakes.has(userIdentifier)) {
    const stake = pendingStakes.get(userIdentifier);
    pendingStakes.delete(userIdentifier);
    ctx.reply(
      `✅ *Cancelled your pending stake*\n\n` +
      `Poll #${stake.pollNum}\n` +
      `Choice: ${stake.choice.toUpperCase()}`,
      { parse_mode: "Markdown" }
    );
  } else {
    ctx.reply("❌ You don't have any pending stakes");
  }
});

// Handle button clicks
bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  const userIdentifier = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  const isAnonymous = ctx.from?.id?.toString() === ANONYMOUS_ADMIN_ID;
  
  // Check if user has registered wallet (unless anonymous)
  if (!isAnonymous && !userWallets.has(userIdentifier)) {
    return ctx.answerCbQuery("❌ Register your wallet first with /register");
  }
  
  const match = ctx.match;
  const pollNum = parseInt(match[1]);
  const choice = match[2];
  const chatId = ctx.chat.id;
  
  const pollId = ctx.callbackQuery.message.message_id.toString();
  const poll = activePolls.get(pollId);
  
  if (!poll) {
    return ctx.answerCbQuery("❌ Poll not found or expired");
  }

  if (pendingStakes.has(userIdentifier)) {
    const existing = pendingStakes.get(userIdentifier);
    return ctx.answerCbQuery(
      `⚠️ You have a pending stake for poll #${existing.pollNum}! Use /cancel first`
    );
  }

  await ctx.answerCbQuery(`✅ Selected ${choice.toUpperCase()}! Now send your stake amount.`);

  const stakeInfo = {
    pollId,
    poll,
    choice,
    pollNum,
    chatId,
    username: isAnonymous ? "Anonymous Admin" : username,
    userIdentifier,
    timestamp: Date.now(),
    isAnonymous
  };
  
  pendingStakes.set(userIdentifier, stakeInfo);

  const walletNote = isAnonymous ? 
    "" : 
    `\n💳 *Your registered wallet:* \`${userWallets.get(userIdentifier).address}\`\n`;

  await ctx.reply(
    `💰 *STAKE MODE ACTIVE* - ${isAnonymous ? 'Anonymous Admin' : '@' + username}\n\n` +
    `📌 *Poll #${pollNum}:* ${choice.toUpperCase()}\n` +
    `💎 *Minimum stake:* ${MIN_STAKE} SOL\n` +
    walletNote +
    `\n✍️ *Send your stake amount now*\n` +
    `Example: \`0.5\` or \`1.23\`\n\n` +
    `⏱️ You have 3 minutes\n` +
    `❌ Use /cancel to abort`,
    { parse_mode: "Markdown" }
  );

  // Auto-timeout
  setTimeout(() => {
    if (pendingStakes.has(userIdentifier)) {
      pendingStakes.delete(userIdentifier);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ ${isAnonymous ? 'Anonymous Admin' : '@' + username} - *Stake timeout* for poll #${pollNum}. Click button to try again.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }, STAKE_TIMEOUT);
});

// Handle text messages (stake amounts)
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userIdentifier = getUserIdentifier(ctx);
  const username = ctx.from.username || ctx.from.first_name || "Anonymous";
  const isAnonymous = ctx.from?.id?.toString() === ANONYMOUS_ADMIN_ID;
  
  // Skip commands
  if (text.startsWith("/")) return;

  if (!pendingStakes.has(userIdentifier)) return;

  const stakeData = pendingStakes.get(userIdentifier);
  
  // Validate amount
  const validation = validateStakeAmount(text);
  
  if (!validation.valid) {
    await ctx.reply(
      `❌ ${stakeData.isAnonymous ? 'Anonymous Admin' : '@' + username} - *${validation.error}*\n\n` +
      `You sent: \`${text}\`\n` +
      `Please send a valid number. Your stake is still pending.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const amount = validation.amount;
  
  // Get user's wallet
  let walletAddress;
  if (isAnonymous) {
    walletAddress = "Anonymous Admin (no wallet required)";
  } else {
    if (!userWallets.has(userIdentifier)) {
      pendingStakes.delete(userIdentifier);
      return ctx.reply("❌ Wallet not found. Please register with /register");
    }
    walletAddress = userWallets.get(userIdentifier).address;
  }

  // Calculate amounts
  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  // Create payment instruction
  const paymentMsg = isAnonymous ? 
    `📤 *Send ${amount} SOL to continue*` :
    `📤 *Send ${amount} SOL from your wallet*\n` +
    `\`${walletAddress}\`\n\n` +
    `💰 *Breakdown:*\n` +
    `• Stake: ${netAmount.toFixed(6)} SOL\n` +
    `• Rake (20%): ${rake.toFixed(6)} SOL\n\n` +
    `🏦 *Send to this address:*\n` +
    `\`${RAKE_WALLET}\`\n\n` +
    `⏱️ Complete within 10 minutes\n` +
    `After sending, click *I've Sent* to confirm`;

  const confirmKeyboard = {
    inline_keyboard: [[
      { text: "✅ I've Sent the SOL", callback_data: `confirm_${stakeData.pollNum}_${amount}` }
    ]]
  };

  await ctx.reply(paymentMsg, {
    parse_mode: "Markdown",
    reply_markup: isAnonymous ? undefined : confirmKeyboard
  });

  // Store pending payment
  pendingStakes.set(userIdentifier, {
    ...stakeData,
    amount,
    netAmount,
    rake,
    awaitingConfirmation: true
  });
});

// Handle payment confirmation
bot.action(/^confirm_(\d+)_([\d.]+)$/, async (ctx) => {
  const userIdentifier = getUserIdentifier(ctx);
  const pollNum = parseInt(ctx.match[1]);
  const amount = parseFloat(ctx.match[2]);
  
  if (!pendingStakes.has(userIdentifier)) {
    return ctx.answerCbQuery("❌ No pending stake found");
  }

  const stakeData = pendingStakes.get(userIdentifier);
  
  if (stakeData.amount !== amount || stakeData.pollNum !== pollNum) {
    return ctx.answerCbQuery("❌ Stake data mismatch");
  }

  // Here you would verify the transaction on Solana
  // For now, we'll simulate confirmation
  console.log(`🔍 Verifying payment of ${amount} SOL from ${stakeData.username}`);

  // Add stake to poll
  stakeData.poll.pot += stakeData.netAmount;
  stakeData.poll.stakes.push({
    userIdentifier,
    amount: stakeData.netAmount,
    choice: stakeData.choice,
    username: stakeData.username,
    timestamp: Date.now(),
    confirmed: true,
    txId: "simulated_tx_" + Date.now()
  });

  // Remove from pending
  pendingStakes.delete(userIdentifier);

  // Update poll message
  const coinPair = stakeData.poll.coin + "/USD";
  const currentPrice = prices[coinPair] || "unknown";
  
  const updatedMsg = buildPollMessage(
    stakeData.poll.pollNum,
    stakeData.poll.coin,
    currentPrice,
    stakeData.poll.pot,
    stakeData.poll.stakes
  );

  try {
    await ctx.telegram.editMessageText(
      stakeData.chatId,
      parseInt(stakeData.pollId),
      undefined,
      updatedMsg,
      { 
        parse_mode: "Markdown",
        reply_markup: getPollKeyboard(stakeData.poll.pollNum) 
      }
    );
  } catch (e) {
    console.error("Poll update error:", e.message);
  }

  // Confirm to user
  await ctx.reply(
    `✅ *STAKE CONFIRMED!*\n\n` +
    `💰 *Amount:* ${amount} SOL\n` +
    `📈 *Choice:* ${stakeData.choice.toUpperCase()}\n` +
    `🎯 *Poll:* #${stakeData.pollNum}\n\n` +
    `💎 *Net stake:* ${stakeData.netAmount.toFixed(6)} SOL\n` +
    `💸 *Rake:* ${stakeData.rake.toFixed(6)} SOL\n` +
    `🏦 *Rake wallet:* \`${RAKE_WALLET}\`\n\n` +
    `📊 *Total pot:* ${stakeData.poll.pot.toFixed(6)} SOL\n` +
    `👥 *Total players:* ${stakeData.poll.stakes.length}`,
    { parse_mode: "Markdown" }
  );

  ctx.answerCbQuery("✅ Stake confirmed!");
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`❌ Bot error:`, err);
});

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach(signal => {
  process.once(signal, () => {
    console.log(`\n🛑 Shutting down...`);
    bot.stop(signal);
    process.exit(0);
  });
});

// Launch bot
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Degen Echo Bot ONLINE");
    console.log("✅ Solana integration enabled");
    console.log(`💰 Minimum stake: ${MIN_STAKE} SOL`);
    console.log(`💸 Rake rate: ${RAKE_RATE * 100}%\n`);
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
