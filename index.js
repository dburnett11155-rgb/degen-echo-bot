const { Telegraf } = require('telegraf');
const axios = require('axios');

// List of large, well-known coins
const largeCoins = ['SOL', 'BTC', 'ETH', 'BNB', 'ADA', 'DOGE', 'XRP', 'LINK'];

// Global pot tracker (simulated – later real Solana tx)
let currentPot = 0;
const rakeRate = 0.20; // 20%
const rakeWallet = '9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK'; // your Phantom address

const bot = new Telegraf('8594205098:AAG_KeTd1T4jC5Qz-xXfoaprLiEO6Mnw_1o');

// /start
bot.start((ctx) => ctx.reply('Degen Echo Bot online! Commands: /poll (start 3 predictions), /stake <amount> (join pot), /chaos (sentiment score)'));

// /poll – creates 3 separate polls for random coins with DexScreener price, anonymous 1-hour auto-close
bot.command('poll', async (ctx) => {
  // Pick 3 unique random coins
  const selectedCoins = [];
  while (selectedCoins.length < 3) {
    const randomCoin = largeCoins[Math.floor(Math.random() * largeCoins.length)];
    if (!selectedCoins.includes(randomCoin)) {
      selectedCoins.push(randomCoin);
    }
  }

  ctx.reply('Starting 3 separate polls!');

  for (const coin of selectedCoins) {
    let price = 'unknown';
    try {
      // Fetch price from DexScreener search (public, no key)
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${coin}`, {
        timeout: 5000
      });
      const pair = response.data.pairs[0]; // First pair (most liquid)
      price = pair ? pair.priceUsd : 'unknown';
    } catch (error) {
      console.error(`DexScreener fetch failed for ${coin}:`, error.message);
      price = 'unknown (API error)';
    }

    const question = `Degen Echo – \[ {coin} at \]{price} – next 1H vibe?`;

    try {
      await ctx.replyWithPoll(
        question,
        ['🚀 Pump', '💀 Dump', '🤷 Stagnate'],
        {
          is_anonymous: true,
          open_period: 3600  // 1 hour auto-close
        }
      );
    } catch (pollError) {
      ctx.reply(`Error creating poll for $${coin} – skipping!`);
      console.error('Poll creation failed:', pollError.message);
    }
  }
});

// /stake – simulate stake + 20% rake
bot.command('stake', (ctx) => {
  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);

  if (!amount || amount <= 0) {
    return ctx.reply('Usage: /stake 0.001');
  }

  const rake = amount * rakeRate;
  currentPot += amount;

  ctx.reply(`Staked ${amount} SOL! Current pot: ${currentPot} SOL (rake cut: ${rake.toFixed(6)} SOL to ${rakeWallet})`);
});

// /chaos – simple random sentiment score
bot.command('chaos', (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? 'bullish 🔥' : score < 30 ? 'bearish 💀' : 'neutral 🤷';
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

// Launch bot
bot.launch();
console.log('Degen Echo Bot is running');
