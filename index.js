const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => ctx.reply('Degen Echo Bot online! Use /poll to start.'));

bot.command('poll', async (ctx) => {
  const poll = await ctx.replyWithPoll(
    'Test Echo – $SOL next 1H vibe?',
    ['Pump', 'Dump', 'Stagnate'],
    { is_anonymous: true, open_period: 3600 }
  );
  ctx.reply('Poll started! Closes in 1 hour.');
});

bot.launch();
console.log('Bot running');
