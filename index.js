const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");

// Solana coins
const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];

// Solana public RPC
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Pulse history (last 10 vectors [delta, tps, skips])
let pulseHistory = [];
let lastPulseTime = Date.now();

// Current pulse-derived prices and direction
const prices = {
  SOL: { value: "85.00", direction: "unknown" }, // anchor starting point
  BONK: { value: "0.000021", direction: "unknown" },
  WIF: { value: "1.93", direction: "unknown" },
  JUP: { value: "0.78", direction: "unknown" }
};

// Stagnate range
const STAGNATE_RANGE = 0.5;

// Per-poll data (message ID → {coin, pot: 0, stakes: []})
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

// Update Solana Price Pulse every 10 seconds
setInterval(async () => {
  try {
    const startTime = Date.now();
    const block = await connection.getLatestBlockhash();
    const performance = await connection.getRecentPerformanceSamples(1);
    const endTime = Date.now();

    const blockDelta = (endTime - startTime) / 1000; // approximate block time delta
    const tps = performance[0].numTransactions / performance[0].samplePeriodSecs;
    const skips = performance[0].numSlots - performance[0].numTransactions; // approximate skips

    const pulseVector = [blockDelta, tps, skips];
    pulseHistory.push(pulseVector);
    if (pulseHistory.length > 10) pulseHistory.shift();

    // Simple pulse-to-direction model
    if (pulseHistory.length >= 3) {
      const recentPulses = pulseHistory.slice(-3);
      const avgDelta = recentPulses.reduce((sum, v) => sum + v[0], 0) / recentPulses.length;
      const avgTps = recentPulses.reduce((sum, v) => sum + v[1], 0) / recentPulses.length;
      const variance = recentPulses.reduce((sum, v) => sum + Math.pow(v[0] - avgDelta, 2), 0) / recentPulses.length;

      let direction = "Stagnate";
      let velocity = 0;

      if (variance < 0.1 && avgDelta < 0.5) {
        direction = "Stagnate";
        velocity = 0;
      } else if (avgTps > 1500 && avgDelta > 0.5) {
        direction = "Pump";
        velocity = avgTps / 10000; // rough velocity proxy
      } else if (avgTps < 1000 || avgDelta > 1) {
        direction = "Dump";
        velocity = -avgTps / 10000;
      }

      // Apply velocity to prices (anchor to last known)
      for (const coin in prices) {
        const current = Number(prices[coin].value);
        const newPrice = current * (1 + velocity * 0.01);
        prices[coin].value = newPrice.toFixed(2);
        prices[coin].direction = direction;
      }
    }
  } catch (e) {
    console.error("SPP update failed:", e.message);
  }
}, 10000);

// /start
const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with SPP prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
    const pollNumber = i + 1;
    const priceInfo = prices[coin];
    const price = priceInfo.value;
    const direction = priceInfo.direction;

    const message = await ctx.reply(`Degen Echo #\( {pollNumber} – \[ {coin} at \]{price} ( \){direction})\nPot: 0 SOL`, {
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
      `Degen Echo #\( {pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pollData.coin].value} ( \){prices[pollData.coin].direction}) – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
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
