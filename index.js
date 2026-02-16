const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");

// Solana coins and their Raydium USDC pools (real addresses)
const pools = {
  SOL: "58oQChx4yWmvKdwLLZzBiLXAkJyqQcD4BXcRx4dg5Pc",  // SOL-USDC
  BONK: "E6Gtmit8rcoApeefHJKfJRNoS3wAHzQEtgQqfkdHwTNs",  // BONK-USDC
  WIF: "EKpQGSJtjMFqKZ9KQGPfgob1Q7iwsCwnO7Hc9ZXkB471",  // WIF-USDC
  JUP: "CLHLa1JLrDc3mWj3M8rA4kmR6ar9dp5wM3Yf99s87Qh4"   // JUP-USDC
};

// Solana public RPC
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Current prices (updated from RPC)
const prices = {
  SOL: "unknown",
  BONK: "unknown",
  WIF: "unknown",
  JUP: "unknown"
};

// Per-poll data (message ID → {coin, pot: 0, stakes: []})
const activePolls = {};

// Rake
const rakeRate = 0.2;
const rakeWallet = "9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK";

const bot = new Telegraf("8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o");

// Update prices from Raydium pools every 30 seconds
setInterval(async () => {
  for (const coin in pools) {
    try {
      const poolAddress = new PublicKey(pools[coin]);
      const account = await connection.getAccountInfo(poolAddress);
      if (!account) continue;

      // Simplified price calculation (real code needs full Raydium AMM decoding)
      // For now, placeholder – in production, decode tokenA/tokenB balances and decimals
      // This is the structure:
      // const data = account.data;
      // const tokenA = data.slice(0, 32); // PublicKey
      // const tokenB = data.slice(32, 64); // PublicKey
      // const reserveA = data.slice(64, 72).readBigUInt64LE();
      // const reserveB = data.slice(72, 80).readBigUInt64LE();
      // price = reserveB / reserveA (adjusted for decimals)

      prices[coin] = "on-chain-" + coin + "-" + Math.random().toFixed(2); // Placeholder
    } catch (e) {
      console.error("RPC failed for " + coin + ": " + e.message);
      prices[coin] = "unknown";
    }
  }
}, 30000);

// /start
bot.start((ctx) => ctx.reply("Degen Echo Bot online! /poll to start 4 polls (tap to vote & stake your amount)"));

// /poll – creates 4 separate button polls with on-chain prices
bot.command("poll", async (ctx) => {
  ctx.reply("Starting 4 separate polls for SOL, BONK, WIF, and JUP! Tap to vote & stake");

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
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
