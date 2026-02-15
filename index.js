const { Telegraf } = require('telegraf');
const axios = require('axios');

// Solana-native coins with excellent DexScreener coverage
const solanaCoins = ['SOL', 'BONK', 'WIF', 'JUP'];

// Global pot tracker (simulated – later use real Solana tx)
let currentPot = 0;
const rakeRate = 0.20; // 20%
const rakeWallet = '9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK'; // your Phantom address

const bot = new Telegraf(process.env.BOT_TOKEN);

// /start
bot.start((ctx) => ctx.reply('Degen Echo Bot online! Commands: /poll (start 4 polls), /stake <amount> <poll#> (e.g. /stake 0.001 1), /chaos (sentiment score)'));

// /poll – creates 4 separate polls with multi-API price fetch
bot.command('poll', async (ctx) => {
  ctx.reply('Starting 4 separate polls for SOL, BONK, WIF, and JUP!');

  for (let i = 0; i < solanaCoins.length; i++) {
    const coin = solanaCoins[i];
    const pollNumber = i + 1;
    const price = await getPrice(coin);  // Multi-API chain

    const question = `Degen Echo #${pollNumber} – \[ {coin} at \]{price} – next 1H vibe?`;

    try {
      await ctx.replyWithPoll(
        question,
        ['🚀 Pump', '💀 Dump', '🤷 Stagnate'],
        {
          is_anonymous: true,
          open_period: 3600
        }
      );
    } catch (pollError) {
      ctx.reply(`Error creating poll #${pollNumber} – skipping!`);
      console.error('Poll creation failed:', pollError.message);
    }
  }
});

// Helper: Try multiple public APIs in order (Binance → CoinGecko → DexScreener)
async function getPrice(coin) {
  const apis = [
    // 1. Binance (fastest, no key)
    async () => {
      const symbol = coin === 'SOL' ? 'SOLUSDT' : coin === 'BONK' ? 'BONKUSDT' : coin === 'WIF' ? 'WIFUSDT' : 'JUPUSDT';
      const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { timeout: 3000 });
      return Number(res.data.price).toFixed(6);
    },
    // 2. CoinGecko (no key for simple price)
    async () => {
      const id = coin.toLowerCase();
      const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { timeout: 3000 });
      return res.data[id].usd.toFixed(6);
    },
    // 3. DexScreener (fallback for Solana DEX)
    async () => {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${coin}`, { timeout: 5000 });
      const pair = res.data.pairs.find(p => p.baseToken.symbol === coin || p.quoteToken.symbol === coin);
      return pair ? Number(pair.priceUsd).toFixed(6) : 'unknown';
    }
  ];

  for (const api of apis) {
    try {
      return await api();
    } catch (e) {
      console.error(`API failed:`, e.message);
    }
  }

  return 'unknown (all APIs failed)';
}

// /stake – stake into a specific poll's pot
bot.command('stake', (ctx) => {
  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);
  const pollNumber = parseInt(args[2]);

  if (!amount || amount <= 0) return ctx.reply('Usage: /stake <amount> <poll#> (e.g. /stake 0.001 1)');
  if (!pollNumber || pollNumber < 1 || pollNumber > 4) return ctx.reply('Poll # must be 1–4');

  const rake = amount * rakeRate;
  currentPot += amount;

  ctx.reply(`Staked \( {amount} SOL into poll # \){pollNumber}! Pot now: ${currentPot} SOL (rake cut: ${rake.toFixed(6)} SOL to ${rakeWallet})`);
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
