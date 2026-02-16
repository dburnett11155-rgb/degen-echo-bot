const { Telegraf } = require("telegraf");

// Bot start time (used for fake drift)
const startTime = Date.now();

// Fixed anchor prices (update these manually if you want)
const anchors = {
  SOL: 89.76,
  BONK: 0.00000642,
  WIF: 0.23,
  JUP: 0.163
};

// Current prices & direction (start from anchors)
const prices = {
  SOL: { value: anchors.SOL, direction: "Stagnate" },
  BONK: { value: anchors.BONK, direction: "Stagnate" },
  WIF: { value: anchors.WIF, direction: "Stagnate" },
  JUP: { value: anchors.JUP, direction: "Stagnate" }
};

// Poll storage
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// /start
bot.start((ctx) => {
  ctx.reply("Degen Echo Bot online! Use /poll to start 4 polls (tap to vote & stake your amount)");
});

// /poll command
bot.command("poll", async (ctx) => {
  const uptimeSeconds = (Date.now() - startTime) / 1000;

  // Update prices with simple clock-based drift
  for (const coin in anchors) {
    const drift = Math.sin(uptimeSeconds / 3600) * 0.02 + (Math.random() - 0.5) * 0.005;
    const current = prices[coin].value;
    const newPrice = current * (1 + drift);
    prices[coin].value = newPrice.toFixed(coin === "BONK" ? 8 : 2);

    // Direction based on drift
    if (Math.abs(drift) < 0.002) {
      prices[coin].direction = "Stagnate";
    } else if (drift > 0) {
      prices[coin].direction = "Pump";
    } else {
      prices[coin].direction = "Dump";
    }
  }

  await ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

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

// Handle button taps
bot.on("callback_query", async (ctx) => {
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
    if (replyCtx.from.id !== userId) return;
    const amount = parseFloat(replyCtx.message.text.trim());

    if (!amount || amount <= 0) {
      return replyCtx.reply("Invalid amount – try again");
    }

    const rake = amount * rakeRate;
    pollData.pot += amount;
    pollData.stakes.push({ userId, amount, choice });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      pollId,
      undefined,
      `Degen Echo #\( {pollData.pollNumber} – \[ {pollData.coin} at \]{prices[pollData.coin].value} ( \){prices[pollData.coin].direction}) – next 1H vibe?\nPot: ${pollData.pot.toFixed(6)} SOL`,
      { reply_markup: ctx.callbackQuery.message.reply_markup }
    );

    await replyCtx.reply(`Staked ${amount} SOL on \( {choice} for poll # \){pollNumber}! Pot now: ${pollData.pot.toFixed(6)} SOL (rake: ${rake.toFixed(6)})`);
    bot.off("text", listener);
  });
});

// /chaos
bot.command("chaos", (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? "bullish 🔥" : score < 30 ? "bearish 💀" : "neutral 🤷";
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

// Launch
bot.launch();
console.log("Degen Echo Bot is running");
