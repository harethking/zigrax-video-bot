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
      '--impersonate', 'chrome',
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveUrl(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
    return r.url.split('?')[0] || url;
  } catch (_) {
    return url;
  }
}

async function tikwm(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url, hd: '1' }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (json && json.code === 0 && json.data) return json.data;
      console.log('tikwm attempt', i + 1, json ? json.msg : 'empty response');
    } catch (e) {
      console.log('tikwm attempt', i + 1, e.message);
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error('مصدر تيك توك مشغول، جرّب بعد دقيقة');
}

async function downloadTikTok(url, id) {
  const full = await resolveUrl(url);
  const data = await tikwm(full);
  const videoUrl = data.hdplay || data.play;
  if (!videoUrl) throw new Error('هذا المنشور ما بيه فيديو');
  const vres = await fetch(videoUrl, { headers: { 'User-Agent': UA } });
  if (!vres.ok) throw new Error('فشل تنزيل فيديو تيك توك');
  const buf = Buffer.from(await vres.arrayBuffer());
  const file = path.join(TMP_DIR, `${id}.mp4`);
  fs.writeFileSync(file, buf);
  return file;
}

async function getVideo(url, id) {
  try {
    return await download(url, id);
  } catch (err) {
    console.log('yt-dlp failed:', err.message);
    if (/tiktok\.com/i.test(url)) {
      cleanup(id);
      return await downloadTikTok(url, id);
    }
    throw err;
  }
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
    const file = await getVideo(url, id);
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

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

async function start() {
  for (;;) {
    try {
      console.log('البوت شغّال ✅');
      await bot.launch();
      return;
    } catch (err) {
      const is409 = err && err.response && err.response.error_code === 409;
      console.log(is409 ? 'نسخة قديمة بعدها شغالة' : 'خطأ بالاتصال: ' + (err && err.message), '- أعيد بعد 5 ثواني');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

const stop = (sig) => {
  try { bot.stop(sig); } catch (_) {}
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
