const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Configuration
const BOT_TOKEN = "8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o";
const RAKE_WALLET = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const RAKE_RATE = 0.2;
const STAKE_TIMEOUT = 180000;

// Solana coins
const COINS = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Price storage
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Active polls and pending stakes - SIMPLIFIED: Track by userId only
const activePolls = new Map();
const pendingStakes = new Map(); // Key is just userId

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

// Command: /start
bot.start(ctx => {
  console.log("▶️ Start command from user", ctx.from.id);
  ctx.reply(
    "🎰 Degen Echo Bot is live!\n\n" +
    "Use /poll to create polls\n" +
    "Use /cancel to abort pending stakes\n" +
    "Use /debug to see pending stakes"
  );
});

// Command: /debug
bot.command("debug", ctx => {
  console.log("\n=== DEBUG STATE ===");
  console.log("Active Polls:", activePolls.size);
  console.log("Pending Stakes:", pendingStakes.size);
  
  for (const [userId, value] of pendingStakes.entries()) {
    console.log(`  User ${userId}:`, value.pollNum, value.choice);
  }
  console.log("===================\n");
  
  ctx.reply(
    `📊 Debug:\n` +
    `Polls: ${activePolls.size}\n` +
    `Pending: ${pendingStakes.size}`
  );
});

// Command: /poll
bot.command("poll", async ctx => {
  console.log("📊 Poll command from user", ctx.from.id, "in chat", ctx.chat.id);
  
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
  
  console.log(`🚫 Cancel from user ${userId}`);
  
  if (pendingStakes.has(userId)) {
    pendingStakes.delete(userId);
    ctx.reply("✅ Pending stake cancelled");
    console.log(`✅ Cancelled stake for user ${userId}`);
  } else {
    ctx.reply("No pending stakes to cancel");
  }
});

// Handle button clicks - Track by userId ONLY
bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  console.log(`\n🔘 BUTTON CLICKED`);
  
  const match = ctx.match;
  const pollNum = parseInt(match[1]);
  const choice = match[2];
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  console.log(`User: ${userId}, Chat: ${chatId}`);
  console.log(`Poll: ${pollNum}, Choice: ${choice}`);
  
  const pollId = ctx.callbackQuery.message.message_id;
  const poll = activePolls.get(pollId);
  
  console.log(`Poll ID: ${pollId}, Found: ${!!poll}`);

  if (!poll) {
    console.log(`❌ Poll not found!`);
    return ctx.answerCbQuery("❌ Poll not found");
  }

  // Check by userId ONLY
  if (pendingStakes.has(userId)) {
    console.log(`⚠️ User ${userId} already has pending stake`);
    return ctx.answerCbQuery("⚠️ You have a pending stake! Use /cancel first");
  }

  await ctx.answerCbQuery();

  const stakeInfo = {
    pollId,
    poll,
    choice,
    pollNum,
    chatId,
    timestamp: Date.now()
  };
  
  // Store by userId ONLY
  pendingStakes.set(userId, stakeInfo);
  
  console.log(`✅ STORED for userId: ${userId}`);
  console.log(`Map size: ${pendingStakes.size}`);

  const prompt = await ctx.reply(
    `💰 *STAKE MODE ACTIVE*\n\n` +
    `Poll #${pollNum}: ${choice.toUpperCase()}\n` +
    `Send your stake amount in SOL (min: 0.001)\n\n` +
    `Example: 0.5\n` +
    `Use /cancel to abort`,
    { parse_mode: "Markdown" }
  );

  console.log(`📤 Sent prompt ${prompt.message_id}\n`);

  setTimeout(() => {
    if (pendingStakes.has(userId)) {
      console.log(`⌛ TIMEOUT for user ${userId}`);
      pendingStakes.delete(userId);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ Stake timeout for poll #${pollNum}. Tap button to retry.`
      ).catch(e => console.error("Timeout error:", e));
    }
  }, STAKE_TIMEOUT);
});

// Handle text messages - Look up by userId ONLY
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  console.log(`\n📩 TEXT: "${text}"`);
  console.log(`User: ${userId}, Chat: ${chatId}`);
  
  if (text.startsWith("/")) {
    console.log(`Skipping command`);
    return;
  }

  console.log(`Looking for userId: ${userId}`);
  console.log(`Pending stakes size: ${pendingStakes.size}`);
  console.log(`Has userId: ${pendingStakes.has(userId)}`);

  // Look up by userId ONLY
  if (!pendingStakes.has(userId)) {
    console.log(`No pending stake - exiting\n`);
    return;
  }

  const stakeData = pendingStakes.get(userId);
  pendingStakes.delete(userId);
  
  console.log(`✅ Found stake for poll #${stakeData.pollNum}`);

  const amount = parseFloat(text.trim());

  if (isNaN(amount) || amount <= 0) {
    console.log(`❌ Invalid amount`);
    return ctx.reply(`❌ Invalid amount: "${text}"\n\nTap button to try again.`);
  }

  if (amount < 0.001) {
    console.log(`❌ Too small`);
    return ctx.reply("❌ Minimum stake: 0.001 SOL");
  }

  console.log(`✅ Valid: ${amount} SOL`);

  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  stakeData.poll.pot += netAmount;
  stakeData.poll.stakes.push({
    userId,
    amount: netAmount,
    choice: stakeData.choice,
    username: ctx.from.username || ctx.from.first_name || "Anon"
  });

  console.log(`💰 Pot now: ${stakeData.poll.pot.toFixed(6)} SOL`);

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
      stakeData.pollId,
      undefined,
      updatedMsg,
      { reply_markup: getPollKeyboard(stakeData.poll.pollNum) }
    );
    console.log(`✅ Poll updated`);
  } catch (e) {
    console.error(`❌ Update error:`, e.message);
  }

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

  console.log(`🎉 COMPLETE!\n`);
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

// Launch
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("🤖 Degen Echo Bot ONLINE");
    console.log(`📱 @${bot.botInfo.username}`);
    console.log("✅ Tracking stakes by userId only (fixes group chat issues)\n");
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
