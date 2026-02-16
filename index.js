const { Telegraf } = require("telegraf");

// Solana coins
const solanaCoins = ["SOL", "BONK", "WIF", "JUP"];

// Per-poll data (poll ID → {coin, pot, voters: []})
const activePolls = {};

// Fixed stake amount per vote (change as needed)
const STAKE_AMOUNT = 0.001;
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls"));

// /poll – creates 4 separate button-based polls
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP!");

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
    const pollNumber = i + 1;
    const message = await ctx.reply(`Degen Echo #${pollNumber} – \[ {coin} next 1H vibe?\nCurrent pot: 0 SOL`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Pump", callback_data: `vote_${pollNumber}_pump` },
            { text: "💀 Dump", callback_data: `vote_${pollNumber}_dump` },
            { text: "🤷 Stagnate", callback_data: `vote_${pollNumber}_stagnate` }
          ]
        ]
      }
    });

    // Store poll data
    activePolls[message.message_id] = {
      coin,
      pollNumber,
      pot: 0,
      voters: []
    };
  }
});

// Handle button votes (auto-stake)
bot.on("callback_query", async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  if (!callbackData.startsWith("vote_")) return;

  const [_, pollNumberStr, choice] = callbackData.split("_");
  const pollNumber = parseInt(pollNumberStr);
  const pollId = ctx.callbackQuery.message.message_id;
  const pollData = activePolls[pollId];

  if (!pollData) return ctx.answerCbQuery("Poll expired");

  const userId = ctx.callbackQuery.from.id;
  if (pollData.voters.includes(userId)) {
    return ctx.answerCbQuery("You already voted!");
  }

  // Auto-stake
  const amount = STAKE_AMOUNT;
  const rake = amount * rakeRate;
  pollData.pot += amount;
  pollData.voters.push(userId);

  // Edit message to show updated pot
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    pollId,
    undefined,
    `Degen Echo #${pollNumber} – \]{pollData.coin} next 1H vibe?\nCurrent pot: ${pollData.pot.toFixed(6)} SOL`,
    {
      reply_markup: ctx.callbackQuery.message.reply_markup
    }
  );

  await ctx.answerCbQuery(`Voted ${choice}! Staked ${amount} SOL (rake: ${rake.toFixed(6)})`);
});

// Launch bot
bot.launch();
console.log("Degen Echo Bot is running");
