const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const { Connection, PublicKey } = require("@solana/web3.js");
const math = require("mathjs");

// Solana coins (Kraken symbols)
const solanaCoins = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Real-time prices from Kraken WebSocket
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Per-poll data (message ID → {coin, pot: 0, stakes: []})
const activePolls = {};

// Rake & stake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

// Stagnate range
const STAGNATE_RANGE = 0.5;

// Solana RPC for SPP (pulse data)
const connection = new Connection("https://api.mainnet-beta.solana.com");

// Pulse vector history (for ML model)
let pulseHistory = [];

// Invented SPP: Track Solana pulse for price action
async function updateSPP() {
  try {
    const block = await connection.getLatestBlockhash();
    const tps = await connection.getRecentPerformanceSamples(1);
    const delta = block.lastValidBlockHeight - block.blockHeight; // approximate block delta
    const skips = tps[0].numSlots - tps[0].numTransactions; // approximate skips
    const pulseVector = [delta, tps[0].numTransactions / tps[0].samplePeriodSecs, skips];

    pulseHistory.push(pulseVector);
    if (pulseHistory.length > 10) pulseHistory.shift(); // Keep last 10

    // Simple AI model (linear regression on historical pulse vs price)
    // Placeholder historical matrix (X = pulse, y = price change)
    const X = math.matrix(pulseHistory);
    const y = math.matrix([[0.2, -0.1, 0.0]]); // Placeholder y (replace with real historical data)
    const theta = math.multiply(math.inv(math.multiply(math.transpose(X), X)), math.multiply(math.transpose(X), y)); // Theta = (X^T X)^-1 X^T y
    const prediction = math.dot(pulseVector, theta.toArray()); // Predicted change

    // Update prices with predicted change (anchor to last known)
    for (const coin in prices) {
      if (prices[coin] !== "unknown") {
        prices[coin] = (Number(prices[coin]) + prediction).toFixed(6);
      }
    }
  } catch (e) {
    console.error("SPP update failed:", e.message);
  }
}

// Run SPP update every 10s
setInterval(updateSPP, 10000);

// Connect to Kraken WebSocket (for initial prices)
let ws = new WebSocket("wss://ws.kraken.com");

ws.on("open", () => {
  console.log("Kraken WebSocket connected");
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
    console.error("WebSocket parse error:", e.message);
  }
});

ws.on("error", (error) => console.error("Kraken WS error:", error.message));

ws.on("close", () => {
  console.log("Kraken WS closed – reconnecting in 5s...");
  setTimeout(() => {
    ws = new WebSocket("wss://ws.kraken.com");
    ws.on("open", () => { /* same */ });
    ws.on("message", (data) => { /* same */ });
    ws.on("error", (error) => { /* same */ });
    ws.on("close", () => { /* same */ });
  }, 5000);
});

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
