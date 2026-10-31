const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};


// =======================================================
// TELEGRAM (টোকেন ও চ্যাট আইডি কোডে লেখা নেই, হোস্টিংয়ের Environment থেকে আসে)
// =======================================================
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';

// একই IP থেকে খুব বেশি রিকোয়েস্ট ঠেকানোর সহজ সীমা (মিনিটে ১০টা)
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').slice(0, max || 120);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('too-large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TG_CHAT, text: text, parse_mode: 'HTML' });
    const r = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resp => {
      let out = '';
      resp.on('data', c => out += c);
      resp.on('end', () => {
        try { const j = JSON.parse(out); j.ok ? resolve(j) : reject(new Error(j.description || 'telegram-error')); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    r.write(body); r.end();
  });
}

async function handleNotify(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (!TG_TOKEN || !TG_CHAT) return json(500, { ok: false, error: 'telegram-not-configured' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (tooMany(ip)) return json(429, { ok: false, error: 'too-many-requests' });

  let d;
  try { d = JSON.parse(await readBody(req, 10000)); }
  catch (e) { return json(400, { ok: false, error: 'bad-request' }); }

  const trx = clean(d.trxId, 30).toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(trx)) return json(400, { ok: false, error: 'bad-trx' });

  const time = new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });
  const msg =
    '🔔 <b>নতুন Instant Pay অর্ডার!</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '🆔 <b>অর্ডার নং:</b> ' + clean(d.orderId, 40) + '\n' +
    '📂 <b>ক্যাটাগরি:</b> ' + clean(d.category, 80) + '\n' +
    '📦 <b>প্যাকেজ:</b> ' + clean(d.productName, 120) + '\n' +
    '🔢 <b>পরিমাণ:</b> ' + clean(d.quantity || 1, 5) + '\n' +
    '💰 <b>মোট দাম:</b> ৳' + clean(d.price, 12) + '\n' +
    '🎮 <b>প্লেয়ার আইডি:</b> <code>' + clean(d.playerId, 60) + '</code>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '💳 <b>মেথড:</b> ' + clean(d.method, 20) + '\n' +
    '💵 <b>পাঠানো টাকা:</b> ৳' + clean(d.amount, 12) + '\n' +
    '🧾 <b>ট্রানজ্যাকশন আইডি:</b> <code>' + trx + '</code>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '👤 <b>ইউজার:</b> ' + clean(d.userName, 80) + '\n' +
    '📧 <b>ইমেইল:</b> ' + clean(d.userEmail, 100) + '\n' +
    '⏰ <b>সময়:</b> ' + time;
  try {
    await sendTelegram(msg);
    return json(200, { ok: true });
  } catch (e) {
    console.error('Telegram error:', e.message);
    return json(502, { ok: false, error: 'telegram-failed' });
  }
}

const server = http.createServer((req, res) => {
  // Telegram নোটিফিকেশন API
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/notify-order') {
    handleNotify(req, res);
    return;
  }

  // Decode URL and remove query strings
  let safeUrl = decodeURI(req.url.split('?')[0]);

  // Route root '/' or '/index.html' directly to 'FFX.html'
  if (safeUrl === '/' || safeUrl === '' || safeUrl === '/index.html') {
    safeUrl = '/index.html';
  }

  // Prevent directory traversal
  const filePath = path.normalize(path.join(ROOT_DIR, safeUrl));
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback: If route not found, serve FFX.html
      const fallbackPath = path.join(ROOT_DIR, 'index.html');
      fs.stat(fallbackPath, (fbErr, fbStats) => {
        if (!fbErr && fbStats.isFile()) {
          serveFile(fallbackPath, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
        }
      });
      return;
    }

    serveFile(filePath, res);
  });
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  });
  stream.pipe(res);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
