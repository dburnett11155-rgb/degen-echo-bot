const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Global error handling - prevents crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Solana coins
const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];

// CoinCap asset IDs
const assetIds = {
  SOL: "solana",
  BONK: "bonk-inu",
  WIF: "dogwifhat",
  JUP: "jupiter-exchange-solana"
};

// Real-time prices from CoinCap WS
const prices = {
  SOL: "unknown",
  BONK: "unknown",
  WIF: "unknown",
  JUP: "unknown"
};

// Poll storage
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// Connect to CoinCap WebSocket
let ws = new WebSocket(`wss://ws.coincap.io/prices?assets=${Object.values(assetIds).join(',')}`);

ws.on("open", () => {
  console.log("CoinCap WebSocket connected");
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data);
    for (const [coin, assetId] of Object.entries(assetIds)) {
      if (msg[assetId]) {
        prices[coin] = Number(msg[assetId]).toFixed(coin === "BONK" ? 8 : 2);
      }
    }
  } catch (e) {
    console.error("CoinCap parse error:", e.message);
  }
});

ws.on("error", (error) => console.error("CoinCap WS error:", error.message));

ws.on("close", () => {
  console.log("CoinCap WS closed – reconnecting in 5s...");
  setTimeout(() => {
    ws = new WebSocket(`wss://ws.coincap.io/prices?assets=${Object.values(assetIds).join(',')}`);
    ws.on("open", () => {});
    ws.on("message", (data) => {});
    ws.on("error", (error) => {});
    ws.on("close", () => {});
  }, 5000);
});

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
    const pollNumber = i + 1;
    const price = prices[coin] || "unknown";

    const message = await ctx.reply(`Degen Echo #${pollNumber} – \[ {coin} at \]{price} – next 1H vibe?\nPot: 0 SOL`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Pump", callback_data: `vote_${pollNumber}_pump` },
            { text: "📉 Dump", callback_data: `vote_${pollNumber}_dump` },
            { text: "🟡 Stagnate", callback_data: `vote_${pollNumber}_stagnate` }
          ]
        ]
      }
    });

    activePolls[message.message_id] = {
      coin,
      pollNumber,
      pot: 0,
      stakes: []
    };
  }
});

// Handle button tap → ask for stake amount
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("vote_")) return;

  const [_, pollNumberStr, choice] = data.split("_");
  const pollNumber = parseInt(pollNumberStr);
  const pollId = ctx.callbackQuery.message.message_id;
  const pollData = activePolls[pollId];

  if (!pollData) return ctx.answerCbQuery("Poll expired");

  const userId = ctx.callbackQuery.from.id;

  await ctx.reply(`How much SOL do you want to stake on \( {choice} for poll # \){pollNumber}? Reply with amount (e.g. 0.001)`);

  const listener = bot.on("text", async (replyCtx) => {
    if (replyCtx.from.id !== userId) return;
    const amount = parseFloat(replyCtx.message.text.trim());

    if (!amount || amount <= 0) {
      return replyCtx.reply("Invalid amount – try again");
    }

    const rake = amount * rakeRate;
    pollData.pot += amount;
    pollData.stakes.push({ userId, amount });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      pollId,
      undefined,
      `Degen Echo #${pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pollData.coin] || "unknown"} – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
      { reply_markup: ctx.callbackQuery.message.reply_markup }
    );

    await replyCtx.reply(`Staked ${amount} SOL on \( {choice} for poll # \){pollNumber}! Pot now: ${pollData.pot.toFixed(6)} SOL (rake: ${rake.toFixed(6)})`);
    bot.off("text", listener);
  });
});

// /chaos
bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

// Launch
bot.launch();
console.log("Degen Echo Bot is running");
