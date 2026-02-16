const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Global error handling - prevents crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Solana coins & AscendEX symbols
const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];
const ascendexSymbols = ["SOL/USDT", "BONK/USDT", "WIF/USDT", "JUP/USDT"];

// Real-time prices
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

// Connect to AscendEX WS
let ws = new WebSocket("wss://ascendex.com/0/api/pro/v1/stream");

ws.on("open", () => {
  console.log("AscendEX WS connected");
  ws.send(JSON.stringify({
    method: "sub.ticker",
    id: 1,
    params: { symbol: ascendexSymbols }
  }));
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data);
    if (msg.m === "ticker" && msg.data && msg.data.symbol) {
      const symbol = msg.data.symbol;
      const coin = symbol.split('/')[0];
      if (solanaCoins.includes(coin)) {
        prices[coin] = Number(msg.data.close).toFixed(coin === "BONK" ? 8 : 2);
      }
    }
  } catch (e) {
    console.error("WS parse error:", e.message);
  }
});

ws.on("error", (error) => console.error("WS error:", error.message));

ws.on("close", () => {
  console.log("WS closed – reconnecting in 5s...");
  setTimeout(() => {
    ws = new WebSocket("wss://ascendex.com/0/api/pro/v1/stream");
    ws.on("open", () => {});
    ws.on("message", (data) => {});
    ws.on("error", (error) => {});
    ws.on("close", () => {});
  }, 5000);
});

// /start
bot.start((ctx) => {
  try {
    ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)");
  } catch (e) {
    console.error("Start error:", e.message);
  }
});

// /poll
bot.command("poll", async (ctx) => {
  try {
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
  } catch (e) {
    console.error("Poll error:", e.message);
    ctx.reply("Error creating polls – try again");
  }
});

// Button tap
bot.on("callback_query", async (ctx) => {
  try {
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
      try {
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
      } catch (e) {
        console.error("Stake error:", e.message);
      }
      bot.off("text", listener);
    });
  } catch (e) {
    console.error("Callback error:", e.message);
    ctx.answerCbQuery("Error processing vote");
  }
});

// /chaos
bot.command("chaos", (ctx) => {
  try {
    const score = Math.floor(Math.random() * 100) + 1;
    const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
    ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
  } catch (e) {
    console.error("Chaos error:", e.message);
  }
});

// Launch with error handling
try {
  bot.launch();
  console.log("Degen Echo Bot is running");
} catch (e) {
  console.error("Bot launch error:", e.message);
}

// Keep alive
process.on('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit(0);
});
