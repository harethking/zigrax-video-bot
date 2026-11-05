const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ضع BOT_TOKEN في متغيرات البيئة');
  process.exit(1);
}

const MAX_BYTES = 49 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), 'video-dl-bot');
fs.mkdirSync(TMP_DIR, { recursive: true });

const ALLOWED = /^https?:\/\/(www\.|m\.|vm\.|vt\.)?(instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\//i;

function download(url, id) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--max-filesize', '49M',
      '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      '-o', path.join(TMP_DIR, `${id}.%(ext)s`),
      '--no-warnings',
      url,
    ];

    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        const lines = stderr.split('\n').filter(Boolean);
        return reject(new Error(lines[lines.length - 1] || 'فشل التحميل'));
      }
      const file = fs.readdirSync(TMP_DIR).find((f) => f.startsWith(id + '.'));
      if (!file) return reject(new Error('ما انلقى الملف'));
      resolve(path.join(TMP_DIR, file));
    });
  });
}

function cleanup(id) {
  try {
    fs.readdirSync(TMP_DIR)
      .filter((f) => f.startsWith(id + '.'))
      .forEach((f) => fs.rmSync(path.join(TMP_DIR, f), { force: true }));
  } catch (_) {}
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply('أرسل رابط فيديو من إنستغرام أو تيك توك أو يوتيوب، وأرسله لك كفيديو مع الصوت.')
);

bot.on('text', async (ctx) => {
  const match = ctx.message.text.match(/https?:\/\/\S+/);
  if (!match || !ALLOWED.test(match[0])) {
    return ctx.reply('أرسل رابط صحيح من إنستغرام أو تيك توك أو يوتيوب.');
  }

  const url = match[0];
  const id = `${ctx.chat.id}_${ctx.message.message_id}`;
  const wait = await ctx.reply('جاري التحميل... ⏳');

  try {
    const file = await download(url, id);
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES) throw new Error('الفيديو أكبر من 50 ميغابايت');

    await ctx.replyWithVideo({ source: fs.createReadStream(file) }, { supports_streaming: true });
    await ctx.deleteMessage(wait.message_id).catch(() => {});
  } catch (err) {
    await ctx.deleteMessage(wait.message_id).catch(() => {});
    await ctx.reply('تعذر التحميل: ' + String(err.message).slice(0, 200));
  } finally {
    cleanup(id);
  }
});

bot.catch((err) => console.error('Bot error:', err));

require('http')
  .createServer((req, res) => res.end('ok'))
  .listen(process.env.PORT || 3000);

bot.launch().then(() => console.log('البوت شغّال ✅'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
