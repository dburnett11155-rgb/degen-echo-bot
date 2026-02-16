const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins (Kraken symbols)
const solanaCoins = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Real-time prices
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Per-poll data (message ID → {coin, startPrice, pot: 0, stakes: [{userId, amount}]})
const activePolls = {};

// Rake & stake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

// Stagnate range
const STAGNATE_RANGE = 0.5; // ±0.5%

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// WebSocket connections
const wsConnections = {};
let currentExchange = "kraken";

// Exchange configs
const exchanges = {
  kraken: {
    url: "wss://ws.kraken.com",
    subscribe: {
      event: "subscribe",
      pair: solanaCoins,
      subscription: { name: "ticker" }
    },
    parse: (msg) => {
      if (Array.isArray(msg) && msg[1] && msg[1].c) {
        const pair = msg[3];
        const coin = pair.replace("/USD", "");
        prices[pair] = Number(msg[1].c[0]).toFixed(6);
      }
    }
  },
  okx: {
    url: "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: {
      op: "subscribe",
      args: solanaCoins.map(p => ({ channel: "tickers", instId: p.replace("/USD", "-USDT") }))
    },
    parse: (msg) => {
      if (msg.data && msg.arg && msg.arg.channel === "tickers") {
        const instId = msg.arg.instId;
        const coin = instId.replace("-USDT", "");
        if (msg.data[0] && msg.data[0].last) {
          prices[coin + "/USD"] = Number(msg.data[0].last).toFixed(6);
        }
      }
    }
  },
  bybit: {
    url: "wss://stream.bybit.com/v5/public/spot",
    subscribe: {
      op: "subscribe",
      args: Object.values(coins).map(c => "tickers." + c.bybit)
    },
    parse: (msg) => {
      if (msg.topic && msg.data && msg.data.lastPrice) {
        const symbol = msg.topic.split(".")[2];
        const coin = Object.keys(coins).find(k => coins[k].bybit === symbol);
        if (coin) prices[coin + "/USD"] = Number(msg.data.lastPrice).toFixed(6);
      }
    }
  }
};

// Connect to current exchange
function connectCurrentWS() {
  const config = exchanges[currentExchange];
  if (!config) return;

  if (wsConnections[currentExchange]) wsConnections[currentExchange].close();

  const ws = new WebSocket(config.url);
  wsConnections[currentExchange] = ws;

  ws.on("open", () => {
    console.log(`${currentExchange} WebSocket connected`);
    ws.send(JSON.stringify(config.subscribe));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      config.parse(msg);
    } catch (e) {
      console.error(`${currentExchange} parse error:`, e.message);
    }
  });

  ws.on("error", (error) => console.error(`${currentExchange} WS error:`, error.message));

  ws.on("close", () => {
    console.log(`${currentExchange} WS closed – switching to next...`);
    const order = ["kraken", "okx", "bybit"];
    const currentIndex = order.indexOf(currentExchange);
    currentExchange = order[(currentIndex + 1) % order.length];
    connectCurrentWS();
  });
}

// Start with Kraken
connectCurrentWS();

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with real-time prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < solanaCoins.length; i++) {
    const pair = solanaCoins[i];
    const coin = pair.replace("/USD", "");
    const pollNumber = i + 1;
    const price = prices[pair] || "unknown";

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
      `Degen Echo #${pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pair] || "unknown"} – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
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
