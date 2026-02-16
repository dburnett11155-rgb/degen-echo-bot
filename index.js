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

// Active polls and pending stakes - Each user tracked separately
const activePolls = new Map();
const pendingStakes = new Map(); // Key is userId - allows multiple people to stake

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
      msg += `${emoji} ${choice.toUpperCase()}: ${total.toFixed(6)} SOL (${stakeList.length} ${stakeList.length === 1 ? 'player' : 'players'})\n`;
      
      // Show individual stakes
      stakeList.forEach(s => {
        msg += `  → ${s.username}: ${s.amount.toFixed(6)} SOL\n`;
      });
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
  console.log("▶️ Start from user", ctx.from.id);
  ctx.reply(
    "🎰 Degen Echo Bot - Multi-Player Betting!\n\n" +
    "📌 How to play:\n" +
    "1️⃣ Use /poll to create prediction polls\n" +
    "2️⃣ Each player clicks a button to vote\n" +
    "3️⃣ Each player sends their stake amount\n" +
    "4️⃣ Multiple players can bet on same poll!\n\n" +
    "Use /cancel to abort your pending stake"
  );
});

// Command: /debug
bot.command("debug", ctx => {
  console.log("\n=== DEBUG STATE ===");
  console.log("Active Polls:", activePolls.size);
  console.log("Pending Stakes:", pendingStakes.size);
  
  for (const [userId, value] of pendingStakes.entries()) {
    console.log(`  User ${userId}: Poll #${value.pollNum}, ${value.choice}`);
  }
  console.log("===================\n");
  
  let msg = `📊 Debug Info:\n`;
  msg += `Active Polls: ${activePolls.size}\n`;
  msg += `Pending Stakes: ${pendingStakes.size}\n\n`;
  
  if (pendingStakes.size > 0) {
    msg += `Waiting for stakes from:\n`;
    for (const [userId, value] of pendingStakes.entries()) {
      msg += `• User ${userId}\n`;
    }
  }
  
  ctx.reply(msg);
});

// Command: /poll
bot.command("poll", async ctx => {
  console.log("📊 Poll from user", ctx.from.id, "in chat", ctx.chat.id);
  
  try {
    await ctx.reply(
      "🚀 Creating 4 polls for SOL, BONK, WIF, JUP!\n\n" +
      "👥 Everyone can vote and stake!\n" +
      "👉 Click a button, then send your stake amount"
    );

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

      console.log(`✅ Poll #${pollNum}, msgId: ${sent.message_id}`);
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
    const stake = pendingStakes.get(userId);
    pendingStakes.delete(userId);
    ctx.reply(`✅ Cancelled your pending stake for poll #${stake.pollNum}`);
    console.log(`✅ Cancelled for user ${userId}`);
  } else {
    ctx.reply("❌ You don't have any pending stakes");
  }
});

// Handle button clicks - Each user can have their own pending stake
bot.action(/^vote_(\d+)_(pump|dump|stagnate)$/, async (ctx) => {
  console.log(`\n🔘 BUTTON from user ${ctx.from.id}`);
  
  const match = ctx.match;
  const pollNum = parseInt(match[1]);
  const choice = match[2];
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const username = ctx.from.username || ctx.from.first_name || "Anon";
  
  console.log(`Poll: ${pollNum}, Choice: ${choice}, User: ${username} (${userId})`);
  
  const pollId = ctx.callbackQuery.message.message_id;
  const poll = activePolls.get(pollId);
  
  if (!poll) {
    console.log(`❌ Poll not found!`);
    return ctx.answerCbQuery("❌ Poll not found");
  }

  // Check if THIS user already has a pending stake
  if (pendingStakes.has(userId)) {
    const existing = pendingStakes.get(userId);
    console.log(`⚠️ User ${userId} has pending stake for poll #${existing.pollNum}`);
    return ctx.answerCbQuery(
      `⚠️ You have a pending stake for poll #${existing.pollNum}! Use /cancel first`
    );
  }

  await ctx.answerCbQuery(`✅ Stake mode activated for ${choice.toUpperCase()}!`);

  const stakeInfo = {
    pollId,
    poll,
    choice,
    pollNum,
    chatId,
    username,
    timestamp: Date.now()
  };
  
  pendingStakes.set(userId, stakeInfo);
  
  console.log(`✅ STORED for user ${userId} (${username})`);
  console.log(`Total pending: ${pendingStakes.size}`);

  const prompt = await ctx.reply(
    `💰 *STAKE MODE ACTIVE* - @${username}\n\n` +
    `Poll #${pollNum}: ${choice.toUpperCase()}\n` +
    `Send your stake amount in SOL (min: 0.001)\n\n` +
    `Example: 0.5\n` +
    `⏱️ You have 3 minutes\n` +
    `Use /cancel to abort`,
    { parse_mode: "Markdown" }
  );

  console.log(`📤 Sent prompt to user ${userId}\n`);

  // Auto-timeout after 3 minutes
  setTimeout(() => {
    if (pendingStakes.has(userId)) {
      console.log(`⌛ TIMEOUT for user ${userId}`);
      pendingStakes.delete(userId);
      ctx.telegram.sendMessage(
        chatId,
        `⏱️ @${username} - Stake timeout for poll #${pollNum}. Click button to retry.`
      ).catch(e => console.error("Timeout error:", e));
    }
  }, STAKE_TIMEOUT);
});

// Handle text messages - Each user's stake is tracked independently
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const username = ctx.from.username || ctx.from.first_name || "Anon";
  
  console.log(`\n📩 TEXT: "${text}" from ${username} (${userId})`);
  
  if (text.startsWith("/")) {
    console.log(`Skipping command`);
    return;
  }

  console.log(`Looking for userId ${userId} in pending stakes...`);
  console.log(`Pending stakes: ${pendingStakes.size}`);
  console.log(`Has this user: ${pendingStakes.has(userId)}`);

  if (!pendingStakes.has(userId)) {
    console.log(`❌ User ${userId} has no pending stake\n`);
    return;
  }

  const stakeData = pendingStakes.get(userId);
  pendingStakes.delete(userId);
  
  console.log(`✅ Found stake for ${username} - Poll #${stakeData.pollNum}`);

  const amount = parseFloat(text.trim());

  if (isNaN(amount) || amount <= 0) {
    console.log(`❌ Invalid amount from ${username}`);
    return ctx.reply(
      `❌ @${username} - Invalid amount: "${text}"\n\n` +
      `Click button again to retry.`
    );
  }

  if (amount < 0.001) {
    console.log(`❌ Amount too small from ${username}`);
    return ctx.reply(`❌ @${username} - Minimum stake: 0.001 SOL`);
  }

  console.log(`✅ Valid: ${amount} SOL from ${username}`);

  const rake = amount * RAKE_RATE;
  const netAmount = amount - rake;

  stakeData.poll.pot += netAmount;
  stakeData.poll.stakes.push({
    userId,
    amount: netAmount,
    choice: stakeData.choice,
    username: stakeData.username
  });

  console.log(`💰 ${username} added ${netAmount.toFixed(6)} SOL`);
  console.log(`💰 Total pot: ${stakeData.poll.pot.toFixed(6)} SOL`);
  console.log(`📊 Total players: ${stakeData.poll.stakes.length}`);

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
    console.log(`✅ Poll updated with ${username}'s stake`);
  } catch (e) {
    console.error(`❌ Update error:`, e.message);
  }

  await ctx.reply(
    `✅ *STAKE CONFIRMED* - @${username}\n\n` +
    `Amount: ${amount} SOL\n` +
    `Choice: ${stakeData.choice.toUpperCase()}\n` +
    `Poll: #${stakeData.pollNum}\n\n` +
    `💰 Your net stake: ${netAmount.toFixed(6)} SOL\n` +
    `📊 Total pot: ${stakeData.poll.pot.toFixed(6)} SOL\n` +
    `👥 Total players: ${stakeData.poll.stakes.length}\n` +
    `💸 Rake (20%): ${rake.toFixed(6)} SOL → ||${RAKE_WALLET}||`,
    { parse_mode: "Markdown" }
  );

  console.log(`🎉 STAKE COMPLETE for ${username}!\n`);
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
    console.log("🤖 Degen Echo Bot ONLINE - Multi-Player Mode");
    console.log(`📱 @${bot.botInfo.username}`);
    console.log("✅ Multiple users can stake on same polls\n");
  })
  .catch(error => {
    console.error("💥 Launch failed:", error);
    process.exit(1);
  });
