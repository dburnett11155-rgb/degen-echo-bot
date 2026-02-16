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
  console.log("Start command received");
  ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)");
});

// /poll
bot.command("poll", async (ctx) => {
  console.log("Poll command received");
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
      console.log("Created poll #" + pollNumber + " with message ID: " + message.message_id);
    }
  } catch (error) {
    console.error("Poll command error:", error);
    ctx.reply("Error creating polls. Please try again.").catch(() => {});
  }
});

// /chaos
bot.command("chaos", (ctx) => {
  console.log("Chaos command received");
  try {
    const score = Math.floor(Math.random() * 100) + 1;
    const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
    ctx.reply("Chaos Score: " + score + "/100 – Vibe: " + vibe);
  } catch (error) {
    console.error("Chaos command error:", error);
  }
});

// /cancel - allow users to cancel pending stakes
bot.command("cancel", (ctx) => {
  console.log("Cancel command received");
  try {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const waitKey = chatId + "_" + userId;
    
    if (bot.context[waitKey]) {
      delete bot.context[waitKey];
      ctx.reply("❌ Your pending stake has been cancelled.");
    } else {
      ctx.reply("You don't have any pending stakes to cancel.");
    }
  } catch (error) {
    console.error("Cancel command error:", error);
  }
});

// Handle button tap
bot.on("callback_query", async (ctx) => {
  console.log("Callback query received:", ctx.callbackQuery.data);
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

    console.log("Vote for poll #" + pollNumber + ", choice: " + choice + ", pollId: " + pollId);
    console.log("Poll data found:", pollData ? "YES" : "NO");

    if (!pollData) {
      return ctx.answerCbQuery("Poll expired or not found");
    }

    const userId = ctx.callbackQuery.from.id;
    const chatId = ctx.chat.id;
    const waitKey = chatId + "_" + userId;

    // Check if user already has a pending stake
    if (bot.context[waitKey]) {
      return ctx.answerCbQuery("⚠️ You already have a pending stake. Reply with amount or use /cancel");
    }

    await ctx.answerCbQuery();
    await ctx.reply(
      "💰 How much SOL do you want to stake on *" + choice + "* for poll #" + pollNumber + 
      "?\n\nReply with amount (e.g. 0.001)\nOr use /cancel to abort",
      { parse_mode: "Markdown" }
    );

    // Store context for this user's next message
    bot.context[waitKey] = {
      pollId: pollId,
      pollData: pollData,
      choice: choice,
      pollNumber: pollNumber,
      chatId: chatId,
      timestamp: Date.now()
    };

    console.log("Waiting for stake amount from user " + userId + " in chat " + chatId);
    console.log("Context stored with key:", waitKey);
    console.log("Current bot.context keys:", Object.keys(bot.context));

    // Auto-clear context after 3 minutes with notification
    setTimeout(() => {
      if (bot.context[waitKey]) {
        console.log("Auto-clearing expired context for:", waitKey);
        delete bot.context[waitKey];
        
        // Notify user that their stake timed out
        ctx.telegram.sendMessage(
          chatId,
          "⏱️ Your stake for poll #" + pollNumber + " has timed out. Tap the button again to try again."
        ).catch((error) => {
          console.error("Error sending timeout notification:", error.message);
        });
      }
    }, 180000); // 3 minutes

  } catch (error) {
    console.error("Callback query error:", error);
    ctx.answerCbQuery("Error processing vote").catch(() => {});
  }
});

// Handle stake amount replies (MUST come after all commands)
bot.on("text", async (ctx) => {
  console.log("Text message received:", ctx.message.text);
  console.log("From user ID:", ctx.from.id, "in chat:", ctx.chat.id);
  
  try {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const waitKey = chatId + "_" + userId;

    console.log("Looking for context key:", waitKey);
    console.log("Available context keys:", Object.keys(bot.context));
    console.log("Context found:", bot.context[waitKey] ? "YES" : "NO");

    // Skip if no pending stake for this user
    if (!bot.context[waitKey]) {
      console.log("No pending stake for this user, ignoring message");
      // Don't respond - let other handlers or commands process this message
      return;
    }

    const stakeData = bot.context[waitKey];
    delete bot.context[waitKey];

    console.log("Processing stake for poll #" + stakeData.pollNumber);

    const amount = parseFloat(ctx.message.text.trim());

    if (isNaN(amount) || amount <= 0) {
      console.log("Invalid amount entered:", ctx.message.text);
      return ctx.reply(
        "❌ Invalid amount – please tap the button again and enter a valid number greater than 0"
      );
    }

    if (amount < 0.001) {
      console.log("Amount too small:", amount);
      return ctx.reply(
        "❌ Minimum stake is 0.001 SOL. Please tap the button again to stake a higher amount."
      );
    }

    console.log("Valid amount entered:", amount);

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

    console.log("Updating poll message:", stakeData.pollId);

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

    console.log("Sending confirmation message");

    await ctx.reply(
      "✅ Staked " + amount + " SOL on *" + stakeData.choice + "* for poll #" + stakeData.pollNumber + 
      "!\n\n💰 Pot now: " + stakeData.pollData.pot.toFixed(6) + " SOL\n" +
      "📊 Rake (20%): " + rake.toFixed(6) + " SOL → " + rakeWallet,
      { parse_mode: "Markdown" }
    );

    console.log("Stake processed successfully");

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
