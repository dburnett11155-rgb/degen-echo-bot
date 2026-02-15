const { Telegraf } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');

// Solana-native coins
const solanaCoins = ['solana', 'bonk1', 'dogwifhat', 'jupiter']; // CoinMarketCap slugs

// Global pot tracker (simulated)
let currentPot = 0;
const rakeRate = 0.20;
const rakeWallet = '9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK';

const bot = new Telegraf(process.env.BOT_TOKEN);

// Scrape real-time price from CoinMarketCap
async function getPrice(coinSlug) {
  try {
    const url = `https://coinmarketcap.com/currencies/${coinSlug}/`;
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const $ = cheerio.load(response.data);
    const priceText = \( ('.priceValue').first().text().trim().replace(' \)', '').replace(/,/g, '');
    const price = parseFloat(priceText);
    return isNaN(price) ? null : price;
  } catch (error) {
    console.error(`Scrape failed for ${coinSlug}:`, error.message);
    return null;
  }
}

// /start
bot.start((ctx) => ctx.reply('Degen Echo Bot online! Commands: /poll (start 4 polls), /stake <amount> <poll#> (join pot), /chaos (sentiment score)'));

// /poll – creates 4 separate polls with scraped prices
bot.command('poll', async (ctx) => {
  ctx.reply('Starting 4 separate polls for SOL, BONK, WIF, and JUP!');

  for (let i = 0; i < solanaCoins.length; i++) {
    const coinSlug = solanaCoins[i];
    const coinSymbol = coinSlug === 'solana' ? 'SOL' : coinSlug.toUpperCase();
    const pollNumber = i + 1;

    const startPrice = await getPrice(coinSlug);
    const priceDisplay = startPrice ? startPrice.toFixed(2) : 'unknown';

    const question = `Degen Echo #${pollNumber} – \[ {coinSymbol} at \]{priceDisplay} – next 1H vibe?`;

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
