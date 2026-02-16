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

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

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
  let msg = `Degen Echo #${pollNum} – $${coin} at $${price} – next 1H vibe?\n`;
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

// Command: /start
bot.start(ctx => {
  console.log("▶️ Start command");
  ctx.reply(
    "🎰 Degen Echo Bot is live!\n\n" +
    "Use /poll to create polls\n" +
    "Use /cancel to abort pending stakes"
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
  const key = `${ctx.chat.id}_${ctx.from.id}`;
  
  if (pendingStakes.has(key)) {
    pendingStakes.delete(key);
    ctx.reply("✅ Pending stake cancelled");
    console.log(`🚫 Cancelled stake for ${key}`);
  } else {
    ctx.reply("No pending stakes to cancel");
  }
});

// Handle button clicks
bot.on("callback_query", async ctx => {
  const data = ctx.callbackQuery.data;
  
  if (!data.startsWith("vote_")) {
    await ctx.answerCbQuery();
    return;
  }

  console.log(`🔘 Button clicked: ${data}`);

  const [, pollNumStr, choice] = data.split("_");
  const pollNum = parseInt(pollNumStr);
  const pollId = ctx.callbackQuery.message.message_id;
  const poll = activePolls.get(pollId);

  if (!poll) {
    return ctx.answerCbQuery("❌ Poll not found");
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}_${userId}`;

  // Check for existing pending stake
  if (pendingStakes.has(key)) {
    return ctx.answerCbQuery("⚠️ You have a pending stake! Use /cancel first");
  }

  await ctx.answerCbQuery();

  // Ask for stake amount
  const prompt = await ctx.reply(
    `💰 How much SOL to stake on *${choice.toUpperCase()}* for poll #${pollNum}?\n\n` +
    `Reply with amount (min: 0.001)\nUse /cancel to abort`,
    { 
      parse_mode: "Markdown",
      reply_markup: { force_reply: true, selective: true }
    }
  );

  // Store pending stake
  pendingStakes.set(key, {
    pollId,
    poll,
    choice,
    pollNum,
    chatId,
    promptMsgId: prompt.message_id,
    timestamp: Date.now()
  });

  console.log(`⏳ Waiting for stake from user ${userId} in chat ${chatId}`);

  // Auto-timeout after 3 minutes
  setTimeout(() => {
    if (pendingStakes.has(key)) {
      pendingStakes.delete(key);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ Stake timeout for poll #${pollNum}. Tap button to retry.`
      ).catch(e => console.error("Timeout notify error:", e));
      console.log(`⌛ Timeout for ${key}`);
    }
  }, STAKE_TIMEOUT);
});

// Handle all messages (catches stake amounts)
bot.on("message", async ctx => {
  // Skip commands
  if (ctx.message.text && ctx.message.text.startsWith("/")) {
    return;
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}_${userId}`;

  console.log(`📩 Message from ${userId}: ${ctx.message.text || "[non-text]"}`);

  // Check if user has pending stake
  if (!pendingStakes.has(key)) {
    console.log(`   No pending stake for ${key}`);
    return;
  }

  const stakeData = pendingStakes.get(key);
  
  // Verify reply in group chats
  if (ctx.message.reply_to_message && 
      ctx.message.reply_to_message.message_id !== stakeData.promptMsgId) {
    console.log(`   Reply to wrong message, ignoring`);
    return;
  }

  pendingStakes.delete(key);

  if (!ctx.message.text) {
    return ctx.reply("❌ Please send a number");
  }

  const amount = parseFloat(ctx.message.text.trim());

  if (isNaN(amount) || amount <= 0) {
    console.log(`❌ Invalid amount: ${ctx.message.text}`);
    return ctx.reply("❌ Invalid amount. Tap button to try again.");
  }

  if (amount < 0.001) {
    return ctx.reply("❌ Minimum stake: 0.001 SOL");
  }

  console.log(`✅ Valid stake: ${amount} SOL`);

  // Calculate rake and update poll
  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  stakeData.poll.pot += netAmount;
  stakeData.poll.stakes.push({
    userId,
    amount: netAmount,
    choice: stakeData.choice,
    username: ctx.from.username || ctx.from.first_name || "Anon"
  });

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

  await ctx.telegram.editMessageText(
    stakeData.chatId,
    stakeData.pollId,
    undefined,
    updatedMsg,
    { reply_markup: getPollKeyboard(stakeData.poll.pollNum) }
  ).catch(e => console.error("Poll update error:", e));

  // Confirm to user
  await ctx.reply(
    `✅ Staked ${amount} SOL on *${stakeData.choice.toUpperCase()}* for poll #${stakeData.pollNum}!\n\n` +
    `💰 Total pot: ${stakeData.poll.pot.toFixed(6)} SOL\n` +
    `📊 Rake (20%): ${rake.toFixed(6)} SOL → ||${RAKE_WALLET}||`,
    { parse_mode: "Markdown" }
  );

  console.log(`💰 Stake processed: ${amount} SOL from user ${userId}`);
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
    console.log("🤖 Degen Echo Bot is ONLINE");
    console.log(`📱 Username: @${bot.botInfo.username}`);
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
