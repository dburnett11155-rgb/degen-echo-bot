const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins (Kraken symbols)
const solanaCoins = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Real-time prices (updated by WebSocket)
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Connect to Kraken public WebSocket (no key)
const ws = new WebSocket("wss://ws.kraken.com");

ws.on("open", () => {
  console.log("Kraken WebSocket connected");
  // Subscribe to ticker for our coins
  const subscribeMsg = {
    event: "subscribe",
    pair: solanaCoins,
    subscription: { name: "ticker" }
  };
  ws.send(JSON.stringify(subscribeMsg));
});

ws.on("message", (data) => {
  try {
    const message = JSON.parse(data);
    if (Array.isArray(message) && message[1] && message[1].c) {
      const pair = message[3]; // Kraken pair name
      const price = message[1].c[0]; // Close price
      if (solanaCoins.includes(pair)) {
        prices[pair] = Number(price).toFixed(6);
      }
    }
  } catch (e) {
    console.error("WebSocket parse error:", e.message);
  }
});

ws.on("error", (error) => {
  console.error("Kraken WebSocket error:", error.message);
});

ws.on("close", () => {
  console.log("Kraken WebSocket closed – reconnecting in 5s...");
  setTimeout(() => {
    const newWs = new WebSocket("wss://ws.kraken.com");
    // Re-attach events
  }, 5000);
});

// Simulated pot per poll
const pots = { 1: 0, 2: 0, 3: 0, 4: 0 };
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls, /stake <amount> <poll#> to join, /chaos for score"));

// /poll – 4 separate polls with real-time WebSocket prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP!");

  for (let i = 0; i < solanaCoins.length; i++) {
    const pair = solanaCoins[i];
    const coin = pair.replace("/USD", "");
    const pollNumber = i + 1;
    const price = prices[pair] || "unknown";

    const question = "Degen Echo #" + pollNumber + " – $" + coin + " at $" + price + " – next 1H vibe?";

    try {
      await ctx.replyWithPoll(question, ["Pump", "Dump", "Stagnate"], {
        is_anonymous: true,
        open_period: 3600
      });
    } catch (err) {
      ctx.reply("Error creating poll #" + pollNumber + " – skipping!");
    }
  }
});

// /stake – simulate stake + rake
bot.command("stake", (ctx) => {
  const args = ctx.message.text.split(" ");
  const amount = parseFloat(args[1]);
  const pollNumber = parseInt(args[2]);

  if (!amount || amount <= 0) return ctx.reply("Usage: /stake <amount> <poll#> (e.g. /stake 0.001 1)");
  if (!pollNumber || pollNumber < 1 || pollNumber > 4) return ctx.reply("Poll # must be 1-4");

  const rake = amount * rakeRate;
  pots[pollNumber] += amount;

  ctx.reply("Staked " + amount + " SOL into poll #" + pollNumber + "! Pot now: " + pots[pollNumber] + " SOL (rake cut: " + rake.toFixed(6) + " SOL to " + rakeWallet + ")");
});

// /chaos – random score
bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish" : score < 30 ? "bearish" : "neutral";
  ctx.reply("Chaos Score: " + score + "/100 - Vibe: " + vibe);
});

// Launch
bot.launch();
console.log("Degen Echo Bot is running");
