const { Telegraf } = require("telegraf");
const axios = require("axios");

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];

let currentPot = 0;
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls, /stake <amount> <poll#> to join, /chaos for score"));

bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, JUP!");

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
    const pollNumber = i + 1;
    let price = "unknown";

    try {
      const symbol = coin === "SOL" ? "SOLUSDT" : coin === "BONK" ? "BONKUSDT" : coin === "WIF" ? "WIFUSDT" : "JUPUSDT";
      const response = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=" + symbol, { timeout: 5000 });
      price = Number(response.data.price).toFixed(6);
    } catch (e) {
      console.error("Price fetch failed for " + coin + ": " + e.message);
    }

    const question = "Degen Echo #" + pollNumber + " - $" + coin + " at $" + price + " - next 1H vibe?";

    try {
      await ctx.replyWithPoll(question, ["Pump", "Dump", "Stagnate"], {
        is_anonymous: true,
        open_period: 3600
      });
    } catch (err) {
      ctx.reply("Error creating poll #" + pollNumber + " - skipping!");
    }
  }
});

bot.command("stake", (ctx) => {
  const args = ctx.message.text.split(" ");
  const amount = parseFloat(args[1]);
  const pollNumber = parseInt(args[2]);

  if (!amount || amount <= 0) return ctx.reply("Usage: /stake <amount> <poll#> (e.g. /stake 0.001 1)");
  if (!pollNumber || pollNumber < 1 || pollNumber > 4) return ctx.reply("Poll # must be 1-4");

  const rake = amount * rakeRate;
  currentPot += amount;

  ctx.reply("Staked " + amount + " SOL into poll #" + pollNumber + "! Pot now: " + currentPot + " SOL (rake cut: " + rake.toFixed(6) + " SOL to " + rakeWallet + ")");
});

bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish" : score < 30 ? "bearish" : "neutral";
  ctx.reply("Chaos Score: " + score + "/100 - Vibe: " + vibe);
});

bot.launch();
console.log("Degen Echo Bot is running");
