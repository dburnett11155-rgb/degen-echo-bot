const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Configuration
const BOT_TOKEN = "8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o";
const RAKE_WALLET = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const RAKE_RATE = 0.2;
const STAKE_TIMEOUT = 180000; // 3 minutes

// Global error handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
});

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
const userStakeMode = new Map();

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// DIAGNOSTIC: Log all incoming updates
bot.use((ctx, next) => {
  console.log("\n=== INCOMING UPDATE ===");
  console.log("Type:", ctx.updateType);
  if (ctx.message) {
    console.log("Message text:", ctx.message.text);
    console.log("From user:", ctx.from.id, ctx.from.username);
    console.log("Chat:", ctx.chat.id);
  }
  if (ctx.callbackQuery) {
    console.log("Callback data:", ctx.callbackQuery.data);
    console.log("From user:", ctx.from.id, ctx.from.username);
  }
  console.log("======================\n");
  return next();
});

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
  let msg = `🎰 Degen Echo #${pollNum} – $${coin} at $${price} – next 1H vibe?\n`;
  msg += `💰 Pot: ${pot.toFixed(6)} SOL\n`;
  
  if (stakes.length > 0) {
    msg += `\n📊 Stakes:\n`;
    const grouped = {};
    stakes.forEach(s => {
      if (!grouped[s.choice]) grouped[s.choice] = [];
      grouped[s.choice].push(s);
    });
    
    for (const [choice, stakeList] of Object.entries(grouped)) {
      const emoji = choice === 'pump' ? '🚀' : choice === 'dump' ? '📉' : '🟡';
      const total = stakeList.reduce((sum, s) => sum + s.amount, 0);
      msg += `${emoji} ${choice.toUpperCase()}: ${total.toFixed(6)} SOL (${stakeList.length})\n`;
    }
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

// DIAGNOSTIC: Show current state
bot.command("debug", ctx => {
  console.log("\n=== DEBUG STATE ===");
  console.log("Active Polls:", activePolls.size);
  console.log("Pending Stakes:", pendingStakes.size);
  console.log("User Stake Mode:", userStakeMode.size);
  
  console.log("\nPending Stakes Details:");
  for (const [key, value] of pendingStakes.entries()) {
    console.log(`  ${key}:`, value.pollNum, value.choice);
  }
  
  console.log("\nUser Stake Mode Details:");
  for (const [userId, value] of userStakeMode.entries()) {
    console.log(`  User ${userId}:`, value.pollNum, value.choice);
  }
  console.log("===================\n");
  
  ctx.reply(
    `📊 Debug Info:\n` +
    `Active Polls: ${activePolls.size}\n` +
    `Pending Stakes: ${pendingStakes.size}\n` +
    `User Stake Mode: ${userStakeMode.size}`
  );
});

// Command: /start
bot.start(ctx => {
  console.log("▶️ Start command");
  ctx.reply(
    "🎰 Degen Echo Bot is live!\n\n" +
    "Use /poll to create polls\n" +
    "Use /cancel to abort pending stakes\n" +
    "Use /debug to see bot state"
  );
});

// Command: /poll
bot.command("poll", async ctx => {
  console.log("📊 Poll command received");
  
  try {
    await ctx.reply("🚀 Creating 4 polls for SOL, BONK, WIF, JUP! Tap to vote & stake!");

    for (let i = 0; i < COINS.length; i++) {
      const pair = COINS[i];
      const coin = pair.replace("/USD", "");
      const pollNum = i + 1;
      const price = prices[pair] || "unknown";

      const pollMsg = buildPollMessage(pollNum, coin, price, 0);
      const sent = await ctx.reply(pollMsg, {
        reply_markup: getPollKeyboard(pollNum)
      });

      activePolls.set(sent.message_id, {
        coin,
        pollNum,
        pot: 0,
        stakes: [],
        chatId: ctx.chat.id
      });

      console.log(`✅ Created poll #${pollNum}, msgId: ${sent.message_id}`);
    }
  } catch (error) {
    console.error("Poll creation error:", error);
    ctx.reply("❌ Error creating polls").catch(() => {});
  }
});

// Command: /chaos
bot.command("chaos", ctx => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
  ctx.reply(`🎲 Chaos Score: ${score}/100 – ${vibe}`);
});

// Command: /cancel
bot.command("cancel", ctx => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}_${userId}`;
  
  console.log(`🚫 Cancel requested by user ${userId} in chat ${chatId}`);
  console.log(`   Key to delete: ${key}`);
  console.log(`   Has pending stake: ${pendingStakes.has(key)}`);
  console.log(`   Has stake mode: ${userStakeMode.has(userId)}`);
  
  if (pendingStakes.has(key) || userStakeMode.has(userId)) {
    pendingStakes.delete(key);
    userStakeMode.delete(userId);
    ctx.reply("✅ Pending stake cancelled");
    console.log(`   ✅ Cancelled successfully`);
  } else {
    ctx.reply("No pending stakes to cancel");
    console.log(`   ℹ️ Nothing to cancel`);
  }
});

// Handle button clicks
bot.on("callback_query", async ctx => {
  const data = ctx.callbackQuery.data;
  
  if (!data.startsWith("vote_")) {
    await ctx.answerCbQuery();
    return;
  }

  console.log(`\n🔘 BUTTON CLICKED: ${data}`);
  console.log(`   User ID: ${ctx.from.id}`);
  console.log(`   Username: ${ctx.from.username}`);
  console.log(`   Chat ID: ${ctx.chat.id}`);

  const [, pollNumStr, choice] = data.split("_");
  const pollNum = parseInt(pollNumStr);
  const pollId = ctx.callbackQuery.message.message_id;
  const poll = activePolls.get(pollId);

  console.log(`   Poll Num: ${pollNum}`);
  console.log(`   Choice: ${choice}`);
  console.log(`   Poll ID: ${pollId}`);
  console.log(`   Poll found: ${!!poll}`);

  if (!poll) {
    console.log(`   ❌ Poll not found!`);
    return ctx.answerCbQuery("❌ Poll not found");
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}_${userId}`;

  console.log(`   Generated key: ${key}`);

  // Check for existing pending stake
  if (pendingStakes.has(key) || userStakeMode.has(userId)) {
    console.log(`   ⚠️ User already has pending stake`);
    return ctx.answerCbQuery("⚠️ You have a pending stake! Use /cancel first");
  }

  await ctx.answerCbQuery();

  // Store pending stake BEFORE sending prompt
  const stakeInfo = {
    pollId,
    poll,
    choice,
    pollNum,
    chatId,
    timestamp: Date.now()
  };
  
  pendingStakes.set(key, stakeInfo);
  userStakeMode.set(userId, stakeInfo);

  console.log(`   ✅ Stored stake info with key: ${key}`);
  console.log(`   ✅ Stored stake info with userId: ${userId}`);
  console.log(`   Current pendingStakes size: ${pendingStakes.size}`);
  console.log(`   Current userStakeMode size: ${userStakeMode.size}`);

  // Ask for stake amount
  const prompt = await ctx.reply(
    `💰 *STAKE MODE ACTIVE*\n\n` +
    `Poll #${pollNum}: ${choice.toUpperCase()}\n` +
    `Send your stake amount in SOL (min: 0.001)\n\n` +
    `Example: 0.5\n` +
    `Use /cancel to abort`,
    { parse_mode: "Markdown" }
  );

  stakeInfo.promptMsgId = prompt.message_id;
  console.log(`   📤 Sent prompt message ID: ${prompt.message_id}`);

  // Auto-timeout after 3 minutes
  setTimeout(() => {
    if (pendingStakes.has(key) || userStakeMode.has(userId)) {
      console.log(`   ⌛ TIMEOUT for user ${userId}`);
      pendingStakes.delete(key);
      userStakeMode.delete(userId);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ Stake timeout for poll #${pollNum}. Tap button to retry.`
      ).catch(e => console.error("Timeout notify error:", e));
    }
  }, STAKE_TIMEOUT);
});

// Handle ALL messages (not just text)
bot.on("message", async ctx => {
  console.log(`\n📨 MESSAGE RECEIVED`);
  console.log(`   Type: ${ctx.message.text ? 'text' : 'other'}`);
  console.log(`   User ID: ${ctx.from.id}`);
  console.log(`   Chat ID: ${ctx.chat.id}`);
  console.log(`   Text: "${ctx.message.text}"`);
  
  const text = ctx.message.text;
  
  if (!text) {
    console.log(`   ℹ️ Not a text message, skipping`);
    return;
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}_${userId}`;

  // Skip commands
  if (text.startsWith("/")) {
    console.log(`   ℹ️ Skipping command: ${text}`);
    return;
  }

  // Check BOTH tracking systems
  const hasPending = pendingStakes.has(key);
  const hasStakeMode = userStakeMode.has(userId);
  
  console.log(`   Checking for pending stake:`);
  console.log(`     Key: ${key}`);
  console.log(`     Has pending (by key): ${hasPending}`);
  console.log(`     Has stake mode (by userId ${userId}): ${hasStakeMode}`);
  console.log(`     Total pending stakes: ${pendingStakes.size}`);
  console.log(`     Total stake modes: ${userStakeMode.size}`);

  if (!hasPending && !hasStakeMode) {
    console.log(`   ❌ No stake pending for this user - EXITING`);
    return;
  }

  console.log(`   ✅ Found pending stake! Processing...`);

  // Get stake data from either source
  const stakeData = pendingStakes.get(key) || userStakeMode.get(userId);
  
  if (!stakeData) {
    console.log(`   ❌ ERROR: Found pending flag but no stake data!`);
    return;
  }

  console.log(`   Stake data:`, {
    pollNum: stakeData.pollNum,
    choice: stakeData.choice,
    chatId: stakeData.chatId
  });

  // Clean up tracking
  pendingStakes.delete(key);
  userStakeMode.delete(userId);
  console.log(`   🧹 Cleaned up tracking maps`);

  // Parse amount
  const amount = parseFloat(text.trim());
  console.log(`   Parsed amount: ${amount}`);

  if (isNaN(amount) || amount <= 0) {
    console.log(`   ❌ Invalid amount`);
    return ctx.reply(
      `❌ Invalid amount: "${text}"\n\n` +
      `Please tap the button again and enter a valid number.`
    );
  }

  if (amount < 0.001) {
    console.log(`   ❌ Amount too small`);
    return ctx.reply("❌ Minimum stake: 0.001 SOL\n\nTap button to try again.");
  }

  console.log(`   ✅ Valid stake amount: ${amount} SOL`);

  // Calculate rake and update poll
  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  const oldPot = stakeData.poll.pot;
  stakeData.poll.pot += netAmount;
  stakeData.poll.stakes.push({
    userId,
    amount: netAmount,
    choice: stakeData.choice,
    username: ctx.from.username || ctx.from.first_name || "Anon"
  });

  console.log(`   💰 Old pot: ${oldPot.toFixed(6)} SOL`);
  console.log(`   💰 Added: ${netAmount.toFixed(6)} SOL (after ${rake.toFixed(6)} rake)`);
  console.log(`   💰 New pot: ${stakeData.poll.pot.toFixed(6)} SOL`);
  console.log(`   📊 Total stakes: ${stakeData.poll.stakes.length}`);

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

  console.log(`   Updating poll message ${stakeData.pollId}...`);

  try {
    await ctx.telegram.editMessageText(
      stakeData.chatId,
      stakeData.pollId,
      undefined,
      updatedMsg,
      { reply_markup: getPollKeyboard(stakeData.poll.pollNum) }
    );
    console.log(`   ✅ Poll message updated successfully`);
  } catch (e) {
    console.error(`   ❌ Poll update error:`, e.message);
  }

  // Confirm to user
  console.log(`   Sending confirmation to user...`);
  await ctx.reply(
    `✅ *STAKE CONFIRMED!*\n\n` +
    `Amount: ${amount} SOL\n` +
    `Choice: ${stakeData.choice.toUpperCase()}\n` +
    `Poll: #${stakeData.pollNum}\n\n` +
    `💰 Your net stake: ${netAmount.toFixed(6)} SOL\n` +
    `📊 Total pot: ${stakeData.poll.pot.toFixed(6)} SOL\n` +
    `💸 Rake (20%): ${rake.toFixed(6)} SOL → ||${RAKE_WALLET}||`,
    { parse_mode: "Markdown" }
  );

  console.log(`   🎉 STAKE FULLY PROCESSED!\n`);
});

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach(signal => {
  process.once(signal, () => {
    console.log(`\n🛑 Shutting down (${signal})...`);
    bot.stop(signal);
    if (ws) ws.close();
    process.exit(0);
  });
});

// Launch bot
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Degen Echo Bot is ONLINE (DIAGNOSTIC MODE)");
    console.log(`📱 Username: @${bot.botInfo.username}`);
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
