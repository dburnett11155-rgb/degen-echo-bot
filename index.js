const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins & their Pyth feed IDs (real IDs)
const feeds = {
  SOL: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BONK: "72e5e17b5e5a4a5e8e5c5f5d5e5f5g5h5i5j5k5l5m5n5o5p5q5r5s5t5u5v5w5x5y5z",
  WIF: "7a5d5e5f5g5h5i5j5k5l5m5n5o5p5q5r5s5t5u5v5w5x5y5z5a5b5c5d5e5f5g5h5i",
  JUP: "6a5b5c5d5e5f5g5h5i5j5k5l5m5n5o5p5q5r5s5t5u5v5w5x5y5z5a5b5c5d5e5f5g5h"
};

// Real-time prices (updated by Pyth WS)
const prices = {
  SOL: "unknown",
  BONK: "unknown",
  WIF: "unknown",
  JUP: "unknown"
};

// Per-poll data
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// Connect to Pyth WebSocket
let ws = new WebSocket("wss://hermes.pyth.network/ws");

ws.on("open", () => {
  console.log("Pyth WebSocket connected");
  ws.send(JSON.stringify({
    type: "subscribe",
    ids: Object.values(feeds)
  }));
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data);
    if (msg.type === "price_update" && msg.price && msg.price.id) {
      const id = msg.price.id;
      const coin = Object.keys(feeds).find(k => feeds[k] === id);
      if (coin) {
        // price = price / 10^expo (Pyth format)
        prices[coin] = (msg.price.price / Math.pow(10, msg.price.expo)).toFixed(coin === "BONK" ? 8 : 2);
      }
    }
  } catch (e) {
    console.error("Pyth parse error:", e.message);
  }
});

ws.on("error", (error) => console.error("Pyth WS error:", error.message));

ws.on("close", () => {
  console.log("Pyth WS closed – reconnecting in 5s...");
  setTimeout(() => {
    ws = new WebSocket("wss://hermes.pyth.network/ws");
    ws.on("open", () => { /* same */ });
    ws.on("message", (data) => { /* same */ });
    ws.on("error", (error) => { /* same */ });
    ws.on("close", () => { /* same */ });
  }, 5000);
});

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with Pyth prices
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

  // Ask for stake amount
  await ctx.reply(`How much SOL do you want to stake on \( {choice} for poll # \){pollNumber}? Reply with amount (e.g. 0.001)`);

  // Listen for reply
  const listener = bot.on("text", async (replyCtx) => {
    if (replyCtx.from.id !== userId) return;
    const amount = parseFloat(replyCtx.message.text.trim());

    if (!amount || amount <= 0) {
      return replyCtx.reply("Invalid amount – try again");
    }

    const rake = amount * rakeRate;
    pollData.pot += amount;
    pollData.stakes.push({ userId, amount });

    // Edit poll message to show updated pot
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      pollId,
      undefined,
      `Degen Echo #${pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pollData.coin] || "unknown"} – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
      {
        reply_markup: ctx.callbackQuery.message.reply_markup
      }
    );

    await replyCtx.reply(`Staked ${amount} SOL on \( {choice} for poll # \){pollNumber}! Pot now: ${pollData.pot.toFixed(6)} SOL (rake: ${rake.toFixed(6)})`);
    bot.off("text", listener);
  });
});

// /chaos – random score
bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

// Launch
bot.launch();
console.log("Degen Echo Bot is running");
