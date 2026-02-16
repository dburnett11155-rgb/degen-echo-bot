const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins (Binance symbols)
const solanaCoins = ["SOLUSDT", "BONKUSDT", "WIFUSDT", "JUPUSDT"];

// Real-time prices (updated by WebSocket)
const prices = {
  SOLUSDT: "unknown",
  BONKUSDT: "unknown",
  WIFUSDT: "unknown",
  JUPUSDT: "unknown"
};

// Connect to Binance WebSocket for real-time trades (no key)
const ws = new WebSocket("wss://stream.binance.com:9443/ws");

ws.on("open", () => {
  console.log("Binance WebSocket connected");
  // Subscribe to trade streams for our coins
  const subscribeMsg = {
    method: "SUBSCRIBE",
    params: solanaCoins.map(coin => coin.toLowerCase() + "@trade"),
    id: 1
  };
  ws.send(JSON.stringify(subscribeMsg));
});

ws.on("message", (data) => {
  try {
    const message = JSON.parse(data);
    if (message.s && message.p) {
      const symbol = message.s;
      if (solanaCoins.includes(symbol)) {
        prices[symbol] = Number(message.p).toFixed(6);
      }
    }
  } catch (e) {
    console.error("WebSocket parse error:", e.message);
  }
});

ws.on("error", (error) => {
  console.error("WebSocket error:", error.message);
});

ws.on("close", () => {
  console.log("WebSocket closed – reconnecting in 5s...");
  setTimeout(() => {
    // Reconnect logic (simple)
    const newWs = new WebSocket("wss://stream.binance.com:9443/ws");
    // Re-attach events (copy from above)
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
    const symbol = solanaCoins[i];
    const coin = symbol.replace("USDT", "");
    const pollNumber = i + 1;
    const price = prices[symbol] || "unknown";

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

// /stake – stake into a specific poll's pot
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
