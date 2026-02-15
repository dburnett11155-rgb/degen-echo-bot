const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Global pot tracker (simulated – later real Solana)
let currentPot = 0;
const rakeRate = 0.20; // 20%
const rakeWallet = '9pWyRYfKahQZPTnNMcXhZDDsUV75mHcb2ZpxGqzZsHnK';

bot.start((ctx) => ctx.reply('Degen Echo Bot online! Commands: /poll (start prediction), /stake <amount> (join pot), /chaos (sentiment score)'));

bot.command('poll', async (ctx) => {
  let solPrice = 'unknown';
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', {
      timeout: 5000
    });
    solPrice = Number(response.data.price).toFixed(2);
  } catch (error) {
    console.error('Binance fetch failed:', error.message);
    solPrice = 'unknown (API error)';
  }

  const question = `Degen Echo – $SOL at $${solPrice} – next 1H vibe?`;

  try {
    const poll = await ctx.replyWithPoll(
      question,
      ['🚀 Pump', '💀 Dump', '🤷 Stagnate'],
      {
        is_anonymous: true,
        open_period: 3600  // 1 hour auto-close
      }
    );
    ctx.reply('Poll started! Closes in 1 hour. Stake with /stake 0.001 SOL');
  } catch (pollError) {
    ctx.reply('Error creating poll – try again!');
    console.error('Poll creation failed:', pollError.message);
  }
});

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

bot.command('chaos', (ctx) => {
  const score = Math.floor(Math.random() * 100) + 1;
  const vibe = score > 70 ? 'bullish 🔥' : score < 30 ? 'bearish 💀' : 'neutral 🤷';
  ctx.reply(`Chaos Score: ${score}/100 – Vibe: ${vibe}`);
});

bot.launch();
console.log('Degen Echo Bot is running');
