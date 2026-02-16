const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins (symbols for each exchange)
const coins = {
  SOL: { kraken: "SOL/USD", binance: "SOLUSDT", bybit: "SOLUSDT" },
  BONK: { kraken: "BONK/USD", binance: "BONKUSDT", bybit: "BONKUSDT" },
  WIF: { kraken: "WIF/USD", binance: "WIFUSDT", bybit: "WIFUSDT" },
  JUP: { kraken: "JUP/USD", binance: "JUPUSDT", bybit: "JUPUSDT" }
};

// Real-time prices (updated by WebSockets)
const prices = {
  SOL: "unknown",
  BONK: "unknown",
  WIF: "unknown",
  JUP: "unknown"
};

// Per-poll data (poll message ID → {coin, pot: 0, stakes: []})
const activePolls = {};

// Rake & stake settings
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const STAKE_PROMPT = "How much SOL do you want to stake? Reply with amount (e.g. 0.001)";

// Active WebSockets
const wsConnections = {};

// Function to connect to a WebSocket
function connectWS(exchange, url, subscribeMsg, symbolMap) {
  if (wsConnections[exchange]) wsConnections[exchange].close();

  const ws = new WebSocket(url);
  wsConnections[exchange] = ws;

  ws.on("open", () => {
    console.log(`${exchange} WebSocket connected`);
    ws.send(JSON.stringify(subscribeMsg));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      let price, symbol;

      if (exchange === "kraken" && Array.isArray(msg) && msg[1] && msg[1].c) {
        symbol = msg[3];
        price = msg[1].c[0];
      } else if (exchange === "binance" && msg.s && msg.p) {
        symbol = msg.s;
        price = msg.p;
      } else if (exchange === "bybit" && msg.topic && msg.data && msg.data.lastPrice) {
        symbol = msg.topic.split(".")[2];
        price = msg.data.lastPrice;
      }

      if (symbol && price) {
        const coin = Object.keys(coins).find(k => coins[k][exchange] === symbol);
        if (coin) prices[coin] = Number(price).toFixed(6);
      }
    } catch (e) {
      console.error(`${exchange} parse error:`, e.message);
    }
  });

  ws.on("error", (error) => console.error(`${exchange} WS error:`, error.message));

  ws.on("close", () => {
    console.log(`${exchange} WS closed – reconnecting in 5s...`);
    setTimeout(() => connectWS(exchange, url, subscribeMsg, symbolMap), 5000);
  });
}

// Connect to all WebSockets
connectWS("kraken", "wss://ws.kraken.com", {
  event: "subscribe",
  pair: Object.values(coins).map(c => c.kraken),
  subscription: { name: "ticker" }
}, coins);

connectWS("binance", "wss://stream.binance.com:9443/ws", {
  method: "SUBSCRIBE",
  params: Object.values(coins).map(c => c.binance.toLowerCase() + "@ticker"),
  id: 1
}, coins);

connectWS("bybit", "wss://stream.bybit.com/v5/public/spot", {
  op: "subscribe",
  args: Object.values(coins).map(c => "tickers." + c.bybit)
}, coins);

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with real-time prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < Object.keys(coins).length; i++) {
    const coin = Object.keys(coins)[i];
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
