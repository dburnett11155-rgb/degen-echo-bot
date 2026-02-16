const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Configuration
const BOT_TOKEN = "8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o";
const RAKE_WALLET = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const RAKE_RATE = 0.2; // 20%
const STAKE_TIMEOUT = 180000; // 3 minutes
const MIN_STAKE = 0.001; // Minimum SOL stake

// Solana coins
const COINS = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Price storage
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Active polls and pending stakes - Each user tracked separately
const activePolls = new Map(); // Key: message_id (as string)
const pendingStakes = new Map(); // Key: userId (as string)

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Helper function to validate stake amount
function validateStakeAmount(input) {
  // Remove any whitespace and replace comma with period
  const cleaned = input.trim().replace(',', '.');
  
  // Check if it's a valid number format
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
  
  // Limit to 6 decimal places (SOL decimals)
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

let ws = connectPriceWebSocket();

// Helper: Build poll message
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
      
      // Show individual stakes
      stakeList.forEach(s => {
        msg += `  → ${s.username}: ${s.amount.toFixed(6)} SOL\n`;
      });
    }
  } else {
    msg += `\n❌ No stakes yet - Be the first to bet!`;
  }
  
  return msg;
}

// Helper: Create poll keyboard
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
  console.log("▶️ Start from user", ctx.from.id);
  ctx.reply(
    "🎰 *Degen Echo Bot - Multi-Player Betting!*\n\n" +
    "📌 *How to play:*\n" +
    "1️⃣ Use /poll to create prediction polls\n" +
    "2️⃣ Each player clicks a button to vote\n" +
    "3️⃣ Each player sends their stake amount\n" +
    "4️⃣ Multiple players can bet on same poll!\n\n" +
    "💰 *Rake:* 20% goes to the house wallet\n" +
    "💎 *Min stake:* 0.001 SOL\n\n" +
    "📋 *Commands:*\n" +
    "/poll - Create new polls\n" +
    "/cancel - Cancel your pending stake\n" +
    "/chaos - Check market chaos score\n" +
    "/debug - View bot status\n" +
    "/help - Show this message",
    { parse_mode: "Markdown" }
  );
});

// Command: /help
bot.help(ctx => {
  ctx.reply(
    "📋 *Available Commands:*\n\n" +
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
  console.log("\n=== DEBUG STATE ===");
  console.log("Active Polls:", activePolls.size);
  console.log("Pending Stakes:", pendingStakes.size);
  
  // Log all pending stakes with details
  for (const [userId, value] of pendingStakes.entries()) {
    console.log(`  User ${userId}: Poll #${value.pollNum}, ${value.choice}, username: ${value.username}`);
  }
  console.log("===================\n");
  
  let msg = `📊 *Debug Info:*\n`;
  msg += `Active Polls: ${activePolls.size}\n`;
  msg += `Pending Stakes: ${pendingStakes.size}\n\n`;
  msg += `*Current Prices:*\n`;
  
  for (const [coin, price] of Object.entries(prices)) {
    msg += `• ${coin}: $${price}\n`;
  }
  
  if (pendingStakes.size > 0) {
    msg += `\n⏳ *Waiting for stakes from:*\n`;
    for (const [userId, value] of pendingStakes.entries()) {
      msg += `• ${value.username} (ID: ${userId}) - Poll #${value.pollNum}\n`;
    }
  }
  
  ctx.reply(msg, { parse_mode: "Markdown" });
});

// Command: /poll
bot.command("poll", async ctx => {
  console.log("📊 Poll from user", ctx.from.id, "in chat", ctx.chat.id);
  
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
        messageId: sent.message_id
      });

      console.log(`✅ Poll #${pollNum}, msgId: ${sent.message_id}`);
    }
  } catch (error) {
    console.error("Poll creation error:", error);
    ctx.reply("❌ Error creating polls. Please try again.").catch(() => {});
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
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "Anon";
  
  console.log(`🚫 Cancel from user ${username} (${userId})`);
  
  if (pendingStakes.has(userId)) {
    const stake = pendingStakes.get(userId);
    pendingStakes.delete(userId);
    ctx.reply(
      `✅ *Cancelled your pending stake*\n\n` +
      `Poll #${stake.pollNum}\n` +
      `Choice: ${stake.choice.toUpperCase()}`,
      { parse_mode: "Markdown" }
    );
    console.log(`✅ Cancelled for user ${userId}`);
  } else {
    console.log(`❌ No pending stake found for user ${userId}`);
    ctx.reply("❌ You don't have any pending stakes");
  }
});

// Handle button clicks - Each user can have their own pending stake
bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "Anon";
  
  console.log(`\n🔘 BUTTON from user ${username} (${userId})`);
  
  const match = ctx.match;
  const pollNum = parseInt(match[1]);
  const choice = match[2];
  const chatId = ctx.chat.id;
  
  console.log(`Poll: ${pollNum}, Choice: ${choice}, User: ${username} (${userId})`);
  
  const pollId = ctx.callbackQuery.message.message_id.toString();
  const poll = activePolls.get(pollId);
  
  if (!poll) {
    console.log(`❌ Poll not found! pollId: ${pollId}`);
    return ctx.answerCbQuery("❌ Poll not found or expired");
  }

  // Check if THIS user already has a pending stake
  if (pendingStakes.has(userId)) {
    const existing = pendingStakes.get(userId);
    console.log(`⚠️ User ${userId} has pending stake for poll #${existing.pollNum}`);
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
    username,
    userId,
    timestamp: Date.now()
  };
  
  pendingStakes.set(userId, stakeInfo);
  
  console.log(`✅ STORED pending stake for user ${username} (${userId})`);
  console.log(`Total pending stakes: ${pendingStakes.size}`);
  console.log(`Pending stake details:`, {
    userId,
    username,
    pollNum,
    choice,
    pollId
  });

  await ctx.reply(
    `💰 *STAKE MODE ACTIVE* - @${username}\n\n` +
    `📌 *Poll #${pollNum}:* ${choice.toUpperCase()}\n` +
    `💎 *Minimum stake:* ${MIN_STAKE} SOL\n\n` +
    `✍️ *Send your stake amount now*\n` +
    `Example: \`0.5\` or \`1.23\`\n\n` +
    `⏱️ You have 3 minutes\n` +
    `❌ Use /cancel to abort`,
    { parse_mode: "Markdown" }
  );

  console.log(`📤 Sent stake prompt to user ${username}\n`);

  // Auto-timeout after 3 minutes
  setTimeout(() => {
    if (pendingStakes.has(userId)) {
      const expiredStake = pendingStakes.get(userId);
      console.log(`⌛ TIMEOUT for user ${username} (${userId})`);
      pendingStakes.delete(userId);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ @${username} - *Stake timeout* for poll #${pollNum}. Click button to try again.`,
        { parse_mode: "Markdown" }
      ).catch(e => console.error("Timeout error:", e));
    }
  }, STAKE_TIMEOUT);
});

// Handle text messages - Each user's stake is tracked independently
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id.toString(); // Convert to string for Map key
  const chatId = ctx.chat.id;
  const username = ctx.from.username || ctx.from.first_name || "Anon";
  const messageId = ctx.message.message_id;
  
  console.log(`\n📩 TEXT MESSAGE RECEIVED`);
  console.log(`From: ${username} (${userId})`);
  console.log(`Message: "${text}"`);
  console.log(`Message ID: ${messageId}`);
  console.log(`Chat ID: ${chatId}`);
  
  // Skip commands
  if (text.startsWith("/")) {
    console.log(`Skipping command: ${text}`);
    return;
  }

  console.log(`\n🔍 Checking pending stakes for user ${userId}...`);
  console.log(`Total pending stakes in Map: ${pendingStakes.size}`);
  
  // Log all pending stake keys for debugging
  if (pendingStakes.size > 0) {
    console.log("Current pending stake keys:");
    for (const [key, value] of pendingStakes.entries()) {
      console.log(`  Key: "${key}" (type: ${typeof key}) - Username: ${value.username}, Poll: #${value.pollNum}`);
    }
  } else {
    console.log("No pending stakes in Map");
  }

  // Check if user has a pending stake
  const hasPending = pendingStakes.has(userId);
  console.log(`Has pending stake for user ${userId}: ${hasPending}`);

  if (!hasPending) {
    console.log(`❌ User ${username} (${userId}) has no pending stake`);
    return;
  }

  // Get the stake data
  const stakeData = pendingStakes.get(userId);
  console.log(`✅ Found pending stake for ${username}:`, {
    pollNum: stakeData.pollNum,
    choice: stakeData.choice,
    username: stakeData.username,
    userId: stakeData.userId
  });
  
  // Validate the stake amount
  const validation = validateStakeAmount(text);
  
  if (!validation.valid) {
    console.log(`❌ Invalid amount from ${username}: "${text}" - ${validation.error}`);
    
    // Keep the pending stake - user can try again
    await ctx.reply(
      `❌ @${username} - *${validation.error}*\n\n` +
      `You sent: \`${text}\`\n` +
      `Please send a valid number (e.g., \`0.5\` or \`1.23\`)\n` +
      `Your stake is still pending. Try again!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Amount is valid - remove from pending
  pendingStakes.delete(userId);
  const amount = validation.amount;
  
  console.log(`✅ Valid amount: ${amount} SOL from ${username}`);
  console.log(`Removed user ${userId} from pending stakes`);

  // Check if the poll still exists
  if (!stakeData.poll) {
    console.log(`❌ Poll not found for ${username}`);
    return ctx.reply(
      `❌ @${username} - Sorry, the poll no longer exists.\n` +
      `Please create a new poll with /poll`,
      { parse_mode: "Markdown" }
    );
  }

  // Calculate rake and net amount
  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  // Add the stake to the poll
  stakeData.poll.pot += netAmount;
  stakeData.poll.stakes.push({
    userId,
    amount: netAmount,
    choice: stakeData.choice,
    username: stakeData.username,
    timestamp: Date.now()
  });

  console.log(`💰 ${username} added ${netAmount.toFixed(6)} SOL (gross: ${amount} SOL, rake: ${rake.toFixed(6)} SOL)`);
  console.log(`💰 Total pot: ${stakeData.poll.pot.toFixed(6)} SOL`);
  console.log(`📊 Total players: ${stakeData.poll.stakes.length}`);

  // Get current price
  const coinPair = stakeData.poll.coin + "/USD";
  const currentPrice = prices[coinPair] || "unknown";
  
  // Build updated poll message
  const updatedMsg = buildPollMessage(
    stakeData.poll.pollNum,
    stakeData.poll.coin,
    currentPrice,
    stakeData.poll.pot,
    stakeData.poll.stakes
  );

  // Update the poll message
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
    console.log(`✅ Poll updated with ${username}'s stake`);
  } catch (e) {
    console.error(`❌ Poll update error:`, e.message);
  }

  // Send confirmation to the user
  await ctx.reply(
    `✅ *STAKE CONFIRMED* - @${username}\n\n` +
    `💰 *Amount:* ${amount.toFixed(6)} SOL\n` +
    `📈 *Choice:* ${stakeData.choice.toUpperCase()}\n` +
    `🎯 *Poll:* #${stakeData.pollNum}\n\n` +
    `💎 *Your net stake:* ${netAmount.toFixed(6)} SOL\n` +
    `💸 *Rake (20%):* ${rake.toFixed(6)} SOL\n` +
    `🏦 *Rake wallet:* \`${RAKE_WALLET}\`\n\n` +
    `📊 *Total pot:* ${stakeData.poll.pot.toFixed(6)} SOL\n` +
    `👥 *Total players:* ${stakeData.poll.stakes.length}`,
    { parse_mode: "Markdown" }
  );

  console.log(`🎉 STAKE COMPLETE for ${username}!\n`);
});

// Handle errors
bot.catch((err, ctx) => {
  console.error(`❌ Bot error for ${ctx.updateType}:`, err);
  ctx.reply("⚠️ An error occurred. Please try again.").catch(() => {});
});

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach(signal => {
  process.once(signal, () => {
    console.log(`\n🛑 Shutting down...`);
    bot.stop(signal);
    if (ws) ws.close();
    process.exit(0);
  });
});

// Launch bot
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Degen Echo Bot ONLINE - Multi-Player Mode");
    console.log(`📱 @${bot.botInfo.username}`);
    console.log("✅ Multiple users can stake on same polls");
    console.log(`💰 Minimum stake: ${MIN_STAKE} SOL`);
    console.log(`💸 Rake rate: ${RAKE_RATE * 100}%\n`);
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
