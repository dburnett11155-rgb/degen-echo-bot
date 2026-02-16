const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Global error handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

// Solana coins (Kraken symbols)
const solanaCoins = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Real-time prices
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Poll storage
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// Initialize context storage
bot.context = {};

// WebSocket connection function
function connectWebSocket() {
  const ws = new WebSocket("wss://ws.kraken.com");

  ws.on("open", () => {
    console.log("Kraken WS connected");
    ws.send(JSON.stringify({
      event: "subscribe",
      pair: solanaCoins,
      subscription: { name: "ticker" }
    }));
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      if (Array.isArray(message) && message[1] && message[1].c) {
        const pair = message[3];
        const price = message[1].c[0];
        if (solanaCoins.includes(pair)) {
          prices[pair] = Number(price).toFixed(6);
        }
      }
    } catch (e) {
      console.error("WS parse error:", e.message);
    }
  });

  ws.on("error", (error) => {
    console.error("Kraken WS error:", error.message);
  });

  ws.on("close", () => {
    console.log("Kraken WS closed – reconnecting in 5s...");
    setTimeout(() => {
      connectWebSocket();
    }, 5000);
  });

  return ws;
}

// Initialize WebSocket connection
let ws = connectWebSocket();

// Helper function to build poll message
function buildPollMessage(pollNumber, coin, price, pot) {
  var part1 = "Degen Echo #";
  var part2 = pollNumber.toString();
  var part3 = " – $";
  var part4 = coin;
  var part5 = " at $";
  var part6 = price;
  var part7 = " – next 1H vibe?\nPot: ";
  var part8 = pot.toFixed(6);
  var part9 = " SOL";

  return part1 + part2 + part3 + part4 + part5 + part6 + part7 + part8 + part9;
}

// /start
bot.start((ctx) => {
  ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)");
});

// /poll
bot.command("poll", async (ctx) => {
  try {
    await ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

    for (let i = 0; i < solanaCoins.length; i++) {
      const pair = solanaCoins[i];
      const coin = pair.replace("/USD", "");
      const pollNumber = i + 1;
      const price = prices[pair] || "unknown";

      const pollText = buildPollMessage(pollNumber, coin, price, 0);

      const message = await ctx.reply(pollText, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🚀 Pump", callback_data: "vote_" + pollNumber + "_pump" },
              { text: "📉 Dump", callback_data: "vote_" + pollNumber + "_dump" },
              { text: "🟡 Stagnate", callback_data: "vote_" + pollNumber + "_stagnate" }
            ]
          ]
        }
      });

      activePolls[message.message_id] = {
        coin: coin,
        pollNumber: pollNumber,
        pot: 0,
        stakes: []
      };
    }
  } catch (error) {
    console.error("Poll command error:", error);
    ctx.reply("Error creating polls. Please try again.").catch(() => {});
  }
});

// /chaos
bot.command("chaos", (ctx) => {
  try {
    const score = Math.floor(Math.random() * 100) + 1;
    const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
    ctx.reply("Chaos Score: " + score + "/100 – Vibe: " + vibe);
  } catch (error) {
    console.error("Chaos command error:", error);
  }
});

// Handle button tap
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("vote_")) {
      await ctx.answerCbQuery();
      return;
    }

    const parts = data.split("_");
    const pollNumber = parseInt(parts[1]);
    const choice = parts[2];
    const pollId = ctx.callbackQuery.message.message_id;
    const pollData = activePolls[pollId];

    if (!pollData) {
      return ctx.answerCbQuery("Poll expired or not found");
    }

    const userId = ctx.callbackQuery.from.id;
    const chatId = ctx.chat.id;

    await ctx.answerCbQuery();
    await ctx.reply("How much SOL do you want to stake on " + choice + " for poll #" + pollNumber + "? Reply with amount (e.g. 0.001)");

    // Store context for this user's next message
    const waitKey = chatId + "_" + userId;
    bot.context[waitKey] = {
      pollId: pollId,
      pollData: pollData,
      choice: choice,
      pollNumber: pollNumber,
      chatId: chatId,
      timestamp: Date.now()
    };

    // Auto-clear context after 5 minutes to prevent memory leaks
    setTimeout(() => {
      if (bot.context[waitKey] && bot.context[waitKey].timestamp === bot.context[waitKey].timestamp) {
        delete bot.context[waitKey];
      }
    }, 300000);

  } catch (error) {
    console.error("Callback query error:", error);
    ctx.answerCbQuery("Error processing vote").catch(() => {});
  }
});

// Handle stake amount replies (MUST come after all commands)
bot.on("text", async (ctx) => {
  try {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const waitKey = chatId + "_" + userId;

    // Skip if no pending stake for this user
    if (!bot.context[waitKey]) return;

    const stakeData = bot.context[waitKey];
    delete bot.context[waitKey];

    const amount = parseFloat(ctx.message.text.trim());

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("Invalid amount – please enter a valid number greater than 0");
    }

    const rake = amount * rakeRate;
    const netAmount = amount - rake;
    
    stakeData.pollData.pot += netAmount;
    stakeData.pollData.stakes.push({ 
      userId: userId, 
      amount: netAmount,
      choice: stakeData.choice,
      username: ctx.from.username || ctx.from.first_name || "Anonymous"
    });

    const coinPair = stakeData.pollData.coin + "/USD";
    const currentPrice = prices[coinPair] || "unknown";
    
    const updatedText = buildPollMessage(
      stakeData.pollData.pollNumber, 
      stakeData.pollData.coin, 
      currentPrice, 
      stakeData.pollData.pot
    );

    await ctx.telegram.editMessageText(
      stakeData.chatId,
      stakeData.pollId,
      undefined,
      updatedText,
      { 
        reply_markup: { 
          inline_keyboard: [[
            { text: "🚀 Pump", callback_data: "vote_" + stakeData.pollNumber + "_pump" },
            { text: "📉 Dump", callback_data: "vote_" + stakeData.pollNumber + "_dump" },
            { text: "🟡 Stagnate", callback_data: "vote_" + stakeData.pollNumber + "_stagnate" }
          ]] 
        }
      }
    ).catch((error) => {
      console.error("Error updating poll message:", error.message);
    });

    await ctx.reply(
      "✅ Staked " + amount + " SOL on " + stakeData.choice + " for poll #" + stakeData.pollNumber + 
      "!\n\nPot now: " + stakeData.pollData.pot.toFixed(6) + " SOL\nRake: " + rake.toFixed(6) + 
      " SOL → " + rakeWallet
    );

  } catch (error) {
    console.error("Text handler error:", error);
    ctx.reply("Error processing your stake. Please try again.").catch(() => {});
  }
});

// Graceful shutdown
process.once("SIGINT", () => {
  console.log("Shutting down gracefully...");
  bot.stop("SIGINT");
  if (ws) ws.close();
});

process.once("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  bot.stop("SIGTERM");
  if (ws) ws.close();
});

// Launch
bot.launch().then(() => {
  console.log("Degen Echo Bot is running");
}).catch((error) => {
  console.error("Failed to launch bot:", error);
  process.exit(1);
});
