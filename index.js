const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// Solana coins (Kraken symbols)
const solanaCoins = ["SOL/USD", "BONK/USD", "WIF/USD", "JUP/USD"];

// Real-time prices (updated live by WebSocket)
const prices = {
  "SOL/USD": "unknown",
  "BONK/USD": "unknown",
  "WIF/USD": "unknown",
  "JUP/USD": "unknown"
};

// Per-poll data (poll message ID → {coin, startPrice, pot: 0, stakes: []})
const activePolls = {};

// Stake & rake settings
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";
const STAGNATE_RANGE = 0.5; // ±0.5% = stagnate

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// Connect to Kraken WebSocket
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
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls"));

// /poll – creates 4 separate polls, records starting price
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP!");

  for (let i = 0; i < solanaCoins.length; i++) {
    const pair = solanaCoins[i];
    const coin = pair.replace("/USD", "");
    const pollNumber = i + 1;
    const startPrice = prices[pair] || "unknown";

    const question = `Degen Echo #${pollNumber} – \[ {coin} at \]{startPrice} – next 1H vibe?`;

    try {
      const message = await ctx.replyWithPoll(question, ["Pump", "Dump", "Stagnate"], {
        is_anonymous: true,
        open_period: 3600
      });

      activePolls[message.poll.id] = {
        coin,
        startPrice,
        pollNumber,
        messageId: message.message_id,
        chatId: ctx.chat.id
      };

      // Schedule outcome check after 1 hour
      setTimeout(async () => {
        const pollData = activePolls[message.poll.id];
        if (!pollData) return;

        const endPrice = prices[pair] || "unknown";
        if (endPrice === "unknown") {
          ctx.telegram.sendMessage(pollData.chatId, `Poll #${pollData.pollNumber} closed – no ending price for \[ {pollData.coin}`);
          delete activePolls[message.poll.id];
          return;
        }

        const change = ((endPrice - pollData.startPrice) / pollData.startPrice) * 100;
        let outcome = "Stagnate";
        if (change > STAGNATE_RANGE) outcome = "Pump";
        else if (change < -STAGNATE_RANGE) outcome = "Dump";

        ctx.telegram.sendMessage(pollData.chatId, `Poll #${pollData.pollNumber} closed! Winner: ${outcome} – \]{pollData.coin} moved \( {change.toFixed(2)}% ( \){outcome === "Stagnate" ? "within ±" + STAGNATE_RANGE + "%" : outcome})!`);

        delete activePolls[message.poll.id];
      }, 3600 * 1000); // 1 hour

    } catch (err) {
      ctx.reply(`Error creating poll #${pollNumber} – skipping!`);
    }
  }
});

// /stake – stake into a specific poll's pot
bot.command("stake", (ctx) => {
  const args = ctx.message.text.split(" ");
  const amount = parseFloat(args[1]);
  const pollNumber = parseInt(args[2]);

  if (!amount || amount <= 0) return ctx.reply("Usage: /stake <amount> <poll#> (e.g. /stake 0.001 1)");
  if (!pollNumber || pollNumber < 1 || pollNumber > 4) return ctx.reply("Poll # must be 1–4");

  const rake = amount * rakeRate;
  pots[pollNumber] += amount;

  ctx.reply(`Staked \( {amount} SOL into poll # \){pollNumber}! Pot now: ${pots[pollNumber]} SOL (rake cut: ${rake.toFixed(6)} SOL to ${rakeWallet})`);
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
