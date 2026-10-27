const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.BALE_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const DATABASE_URL = process.env.DATABASE_URL;
const API = TOKEN ? `https://tapi.bale.ai/bot${TOKEN}` : "";
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL)
    ? { rejectUnauthorized: false } : false
});

const PRODUCTS = [
  ["stuffed_chicken", "مرغ شکم‌پر نمکی", 900000],
  ["royal_chicken", "چلو مرغ همایونی", 480000],
  ["shrimp", "چلو دوپیازه میگو", 570000],
  ["ghormeh", "چلو قورمه‌سبزی", 400000],
  ["gheimeh_shirazi", "چلو خورشت قیمه شیرازی", 400000],
  ["gheimeh_eggplant", "چلو قیمه بادمجان", 410000],
  ["istanboli", "استانبولی مرغ", 370000],
  ["adas", "عدس‌پلو با سویا", 300000],
  ["zereshk", "زرشک‌پلو با مرغ سسی", 450000],
  ["joojeh", "چلو جوجه", 480000],
  ["plain_rice", "چلو ساده", 130000],
  ["stew_bowl", "کاسه خورشت قیمه", 260000],
  ["ghormeh_bowl", "کاسه خورشت قورمه‌سبزی", 260000]
];

const sessions = new Map();
let polling = false;
let offset = 0;

async function bale(method, body = {}) {
  if (!API) throw new Error("Missing BALE_BOT_TOKEN");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000)
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(`${method}: ${JSON.stringify(data)}`);
  return data.result;
}
async function send(chatId, text, keyboard) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  return bale("sendMessage", body);
}
function keyboard(rows) {
  return { keyboard: rows.map(r => r.map(text => ({ text }))), resize_keyboard: true, one_time_keyboard: false, is_persistent: true };
}
const MAIN = keyboard([
  ["🍽️ مشاهده منو", "🛒 ثبت سفارش"],
  ["📦 پیگیری سفارش", "📞 تماس با مامان حسنا"]
]);
const ADMIN = keyboard([
  ["📋 موجودی غذاها", "➕ تغییر موجودی"],
  ["🧾 سفارش‌های جدید", "🚚 سفارش‌های در انتظار هزینه ارسال"],
  ["📦 سفارش‌های در حال آماده‌سازی", "✅ سفارش‌های آماده/ارسال"],
  ["⭐ گزارش نظرسنجی‌ها", "🕒 درخواست‌های پیش‌سفارش"],
  ["🏠 منوی اصلی"]
]);
const money = n => `${Number(n).toLocaleString("fa-IR")} تومان`;
const faNum = n => Number(n).toLocaleString("fa-IR");

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers (
      chat_id TEXT PRIMARY KEY, name TEXT, phone TEXT, address TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      customer_name TEXT,
      phone TEXT,
      address TEXT,
      items JSONB NOT NULL,
      subtotal INTEGER NOT NULL,
      delivery_fee INTEGER,
      total INTEGER,
      status TEXT NOT NULL DEFAULT 'در انتظار تعیین هزینه ارسال',
      invoice_sent BOOLEAN NOT NULL DEFAULT FALSE,
      survey_sent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS preorder_requests (
      id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL, customer_name TEXT,
      product_id TEXT NOT NULL, product_name TEXT NOT NULL, quantity INTEGER NOT NULL,
      note TEXT, status TEXT NOT NULL DEFAULT 'در انتظار بررسی', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS surveys (
      id BIGSERIAL PRIMARY KEY, order_id BIGINT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
      taste INTEGER, ingredients INTEGER, cooking INTEGER, delivery INTEGER, overall INTEGER,
      comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Safe additions for an existing database created by an older bot version.
  const additions = [
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee INTEGER",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal INTEGER",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS total INTEGER",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_sent BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS survey_sent BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"
  ];
  for (const q of additions) await pool.query(q);
  for (const [id, name, price] of PRODUCTS) {
    await pool.query(
      `INSERT INTO products(id,name,price,stock) VALUES($1,$2,$3,0)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price`,
      [id, name, price]
    );
  }
  console.log("Database initialized.");
}
async function admin(chatId) {
  return !!ADMIN_ID && String(chatId) === ADMIN_ID;
}
async function getProducts() {
  return (await pool.query("SELECT * FROM products ORDER BY array_position(ARRAY['stuffed_chicken','royal_chicken','shrimp','ghormeh','gheimeh_shirazi','gheimeh_eggplant','istanboli','adas','zereshk','joojeh','plain_rice','stew_bowl','ghormeh_bowl'], id)")).rows;
}
async function showMenu(chatId) {
  const products = await getProducts();
  const lines = products.map(p =>
    `${p.name}\n💰 ${money(p.price)}\n📦 موجودی: ${p.stock > 0 ? `${faNum(p.stock)} عدد` : "۰ — فعلاً موجود نیست"}`
  );
  await send(chatId, "🍲 منوی غذای خانگی مامان حسنا\n\n" + lines.join("\n\n") +
    "\n\nبرای سفارش، دکمه «🛒 ثبت سفارش» را بزنید.", MAIN);
}
function orderSummary(order, items, delivery = order.delivery_fee) {
  const itemLines = items.map(i => `• ${i.name} × ${faNum(i.quantity)} = ${money(i.unit_price * i.quantity)}`).join("\n");
  const subtotal = Number(order.subtotal ?? items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0));
  const feeLine = delivery === null || delivery === undefined ? "هزینه ارسال: در انتظار تعیین توسط مدیریت" : `هزینه ارسال: ${money(delivery)}`;
  const totalLine = delivery === null || delivery === undefined ? "مبلغ نهایی: پس از تعیین هزینه ارسال اعلام می‌شود" : `مبلغ نهایی: ${money(subtotal + Number(delivery))}`;
  return `🧾 فاکتور سفارش #${order.id}\n\n${itemLines}\n\nجمع غذاها: ${money(subtotal)}\n${feeLine}\n${totalLine}`;
}
async function sendAdminOrder(orderId, prefix = "🛒 سفارش جدید") {
  const row = (await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!row || !ADMIN_ID) return;
  const items = Array.isArray(row.items) ? row.items : JSON.parse(row.items);
  await send(ADMIN_ID,
    `${prefix} #${row.id}\nمشتری: ${row.customer_name || "نامشخص"}\nشناسه بله: ${row.chat_id}\nتلفن: ${row.phone || "ثبت نشده"}\nنشانی: ${row.address || "ثبت نشده"}\n\n${orderSummary(row, items)}\n\nوضعیت: ${row.status}`,
    keyboard([["💵 تعیین هزینه ارسال #" + row.id], ["🍳 آماده‌سازی #" + row.id], ["🚚 ارسال‌شده #" + row.id], ["✅ تحویل‌شده #" + row.id], ["🏠 منوی اصلی"]])
  );
}
async function handleAdmin(chatId, text) {
  const sess = sessions.get(String(chatId));
  if (text === "📋 موجودی غذاها") {
    const ps = await getProducts();
    return send(chatId, "📦 موجودی فعلی غذاها:\n\n" + ps.map(p => `${p.name}: ${faNum(p.stock)} عدد`).join("\n"), ADMIN);
  }
  if (text === "➕ تغییر موجودی") {
    sessions.set(String(chatId), { mode: "stock_product" });
    const ps = await getProducts();
    return send(chatId, "غذا را انتخاب کن:", keyboard(ps.map(p => [p.name]).concat([["🏠 منوی اصلی"]])));
  }
  if (text === "🧾 سفارش‌های جدید") {
    const rows = (await pool.query("SELECT id,customer_name,status FROM orders WHERE status='در انتظار تعیین هزینه ارسال' ORDER BY id DESC LIMIT 15")).rows;
    if (!rows.length) return send(chatId, "سفارش جدیدی در انتظار بررسی نیست.", ADMIN);
    for (const r of rows) await sendAdminOrder(r.id, "🛒 سفارش در انتظار بررسی");
    return;
  }
  if (text === "🚚 سفارش‌های در انتظار هزینه ارسال") {
    const rows = (await pool.query("SELECT id FROM orders WHERE status='در انتظار تعیین هزینه ارسال' ORDER BY id DESC LIMIT 20")).rows;
    if (!rows.length) return send(chatId, "سفارشی در انتظار تعیین هزینه ارسال نیست.", ADMIN);
    for (const r of rows) await sendAdminOrder(r.id, "🚚 تعیین هزینه ارسال");
    return;
  }
  if (text === "📦 سفارش‌های در حال آماده‌سازی") {
    const rows = (await pool.query("SELECT id FROM orders WHERE status IN ('در حال آماده‌سازی','آماده ارسال','ارسال‌شده') ORDER BY id DESC LIMIT 20")).rows;
    if (!rows.length) return send(chatId, "سفارشی در این مرحله نیست.", ADMIN);
    for (const r of rows) await sendAdminOrder(r.id, "📦 پیگیری سفارش");
    return;
  }
  if (text === "⭐ گزارش نظرسنجی‌ها") {
    const r = await pool.query(`SELECT COUNT(*) AS n, ROUND(AVG(overall),2) AS avg_overall,
      ROUND(AVG(taste),2) AS avg_taste, ROUND(AVG(ingredients),2) AS avg_ingredients,
      ROUND(AVG(cooking),2) AS avg_cooking, ROUND(AVG(delivery),2) AS avg_delivery
      FROM surveys`);
    const x = r.rows[0];
    return send(chatId, `⭐ گزارش نظرسنجی‌ها\nتعداد پاسخ‌ها: ${x.n}\nمیانگین رضایت کلی: ${x.avg_overall || "—"} از ۵\nطعم و مزه: ${x.avg_taste || "—"} از ۵\nمواد اولیه: ${x.avg_ingredients || "—"} از ۵\nکیفیت پخت: ${x.avg_cooking || "—"} از ۵\nارسال و بسته‌بندی: ${x.avg_delivery || "—"} از ۵`, ADMIN);
  }
  if (text === "🕒 درخواست‌های پیش‌سفارش") {
    const rows = (await pool.query("SELECT * FROM preorder_requests WHERE status='در انتظار بررسی' ORDER BY id DESC LIMIT 15")).rows;
    return send(chatId, rows.length ? rows.map(r => `#${r.id} — ${r.product_name}\nتعداد: ${r.quantity}\nمشتری: ${r.customer_name || "نامشخص"} (${r.chat_id})\nتوضیح: ${r.note || "—"}`).join("\n\n") : "درخواست پیش‌سفارش جدیدی نیست.", ADMIN);
  }
  if (sess?.mode === "stock_product") {
    const p = (await pool.query("SELECT * FROM products WHERE name=$1", [text])).rows[0];
    if (!p) return send(chatId, "لطفاً غذا را از دکمه‌های فهرست انتخاب کن.", ADMIN);
    sessions.set(String(chatId), { mode: "stock_qty", productId: p.id, productName: p.name });
    return send(chatId, `موجودی جدید «${p.name}» را وارد کن. برای ناموجود کردن، عدد ۰ را بفرست.`);
  }
  if (sess?.mode === "stock_qty") {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty < 0 || qty > 100000) return send(chatId, "یک عدد صحیح از ۰ به بالا وارد کن.");
    await pool.query("UPDATE products SET stock=$1, updated_at=NOW() WHERE id=$2", [qty, sess.productId]);
    sessions.delete(String(chatId));
    return send(chatId, `✅ موجودی «${sess.productName}» روی ${faNum(qty)} عدد تنظیم شد.`, ADMIN);
  }
  const feeMatch = text.match(/^💵 تعیین هزینه ارسال #(\d+)$/);
  if (feeMatch) {
    sessions.set(String(chatId), { mode: "delivery_fee", orderId: Number(feeMatch[1]) });
    return send(chatId, `هزینه پیک/اسنپ برای سفارش #${feeMatch[1]} را به تومان وارد کن. فقط عدد بفرست؛ اگر ارسال رایگان است عدد ۰.`);
  }
  if (sess?.mode === "delivery_fee") {
    const fee = Number(text.replace(/[٬,،\s]/g, ""));
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > 100000000) return send(chatId, "هزینه را به صورت عدد صحیح و به تومان وارد کن؛ مثال: ۸۰۰۰۰.");
    const result = await pool.query("UPDATE orders SET delivery_fee=$1,total=subtotal+$1,status='فاکتور صادر شده',invoice_sent=TRUE,updated_at=NOW() WHERE id=$2 RETURNING *", [fee, sess.orderId]);
    sessions.delete(String(chatId));
    const o = result.rows[0];
    if (!o) return send(chatId, "این شماره سفارش پیدا نشد.", ADMIN);
    const items = Array.isArray(o.items) ? o.items : JSON.parse(o.items);
    await send(o.chat_id, orderSummary(o, items, fee) + "\n\nلطفاً برای تأیید فاکتور با مامان حسنا هماهنگ کنید.", MAIN);
    await send(chatId, `✅ فاکتور سفارش #${o.id} برای مشتری ارسال شد.\nمبلغ نهایی: ${money(o.total)}`, ADMIN);
    return;
  }
  const statusActions = [
    { re: /^🍳 آماده‌سازی #(\d+)$/, status: "در حال آماده‌سازی" },
    { re: /^🚚 ارسال‌شده #(\d+)$/, status: "ارسال‌شده" },
    { re: /^✅ تحویل‌شده #(\d+)$/, status: "تحویل‌شده" }
  ];
  for (const a of statusActions) {
    const m = text.match(a.re);
    if (!m) continue;
    const id = Number(m[1]);
    const r = await pool.query("UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *", [a.status, id]);
    const o = r.rows[0];
    if (!o) return send(chatId, "سفارش پیدا نشد.", ADMIN);
    if (a.status === "تحویل‌شده" && !o.survey_sent) {
      await pool.query("UPDATE orders SET survey_sent=TRUE WHERE id=$1", [id]);
      sessions.set(String(o.chat_id), { mode: "survey", orderId: id, step: "taste", values: {} });
      await send(o.chat_id, `🌷 امیدواریم از غذای مامان حسنا لذت برده باشید!\nلطفاً به هر مورد از ۱ تا ۵ امتیاز بدهید.\n\n۱) طعم و مزه غذا چطور بود؟`, keyboard([["۱", "۲", "۳", "۴", "۵"]]));
      await send(chatId, `✅ سفارش #${id} تحویل‌شده ثبت شد و نظرسنجی برای مشتری ارسال شد.`, ADMIN);
    } else {
      await send(o.chat_id, `📦 وضعیت سفارش #${id} تغییر کرد: ${a.status}`, MAIN);
      await send(chatId, `وضعیت سفارش #${id}: ${a.status}`, ADMIN);
    }
    return;
  }
  return send(chatId, "🛠️ پنل مدیریت غذای خانگی مامان حسنا", ADMIN);
}

async function createPreorder(chatId, name, product, qty) {
  const r = await pool.query(
    "INSERT INTO preorder_requests(chat_id,customer_name,product_id,product_name,quantity,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [String(chatId), name || null, product.id, product.name, qty, "درخواست برای فردا/هماهنگی با مدیریت"]
  );
  const id = r.rows[0].id;
  if (ADMIN_ID) await send(ADMIN_ID, `🕒 درخواست پیش‌سفارش #${id}\nغذا: ${product.name}\nتعداد: ${faNum(qty)}\nمشتری: ${name || "نامشخص"}\nشناسه بله: ${chatId}\nبرای هماهنگی با مشتری تماس بگیرید.`);
  await send(chatId, `✅ درخواست شما برای ${faNum(qty)} عدد «${product.name}» ثبت شد.\nاین درخواست هنوز سفارش قطعی نیست؛ مدیریت برای هماهنگی با شما تماس می‌گیرد.`, MAIN);
}

async function handleSurvey(chatId, text, session) {
  const map = { taste: ["طعم و مزه", "ingredients"], ingredients: ["مواد اولیه", "cooking"], cooking: ["کیفیت پخت", "delivery"], delivery: ["ارسال و بسته‌بندی", "overall"], overall: ["رضایت کلی", "comment"] };
  const steps = ["taste", "ingredients", "cooking", "delivery", "overall"];
  if (session.step === "comment") {
    const comment = text === "بدون نظر" ? null : text.slice(0, 1000);
    const v = session.values;
    await pool.query(
      `INSERT INTO surveys(order_id,chat_id,taste,ingredients,cooking,delivery,overall,comment)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(order_id) DO UPDATE SET taste=EXCLUDED.taste,ingredients=EXCLUDED.ingredients,cooking=EXCLUDED.cooking,delivery=EXCLUDED.delivery,overall=EXCLUDED.overall,comment=EXCLUDED.comment`,
      [session.orderId, String(chatId), v.taste, v.ingredients, v.cooking, v.delivery, v.overall, comment]
    );
    sessions.delete(String(chatId));
    if (ADMIN_ID) await send(ADMIN_ID, `⭐ نظرسنجی سفارش #${session.orderId}\nطعم: ${v.taste}/۵\nمواد اولیه: ${v.ingredients}/۵\nپخت: ${v.cooking}/۵\nارسال: ${v.delivery}/۵\nرضایت کلی: ${v.overall}/۵\nنظر: ${comment || "بدون نظر"}`);
    return send(chatId, "💚 ممنون از اینکه وقت گذاشتید و نظر دادید. بازخورد شما به بهتر شدن غذای مامان حسنا کمک می‌کند.", MAIN);
  }
  const digitMap = { "۱":1, "۲":2, "۳":3, "۴":4, "۵":5, "1":1, "2":2, "3":3, "4":4, "5":5 };
  const score = digitMap[text];
  if (!score) return send(chatId, "لطفاً یکی از امتیازهای ۱ تا ۵ را انتخاب کنید.", keyboard([["۱","۲","۳","۴","۵"]]));
  session.values[session.step] = score;
  const idx = steps.indexOf(session.step);
  if (idx < steps.length - 1) {
    session.step = steps[idx + 1];
    const questions = {
      ingredients: "۲) کیفیت و تازگی مواد اولیه چطور بود؟",
      cooking: "۳) کیفیت پخت و ظاهر غذا چطور بود؟",
      delivery: "۴) بسته‌بندی و ارسال چطور بود؟",
      overall: "۵) در مجموع چقدر راضی بودید؟"
    };
    sessions.set(String(chatId), session);
    return send(chatId, questions[session.step], keyboard([["۱","۲","۳","۴","۵"]]));
  }
  session.step = "comment";
  sessions.set(String(chatId), session);
  return send(chatId, "اگر توضیح یا پیشنهادی دارید بنویسید؛ یا برای رد کردن این مرحله «بدون نظر» را بزنید.", keyboard([["بدون نظر"]]));
}

async function handleMessage(msg) {
  if (!msg?.chat?.id) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();
  if (!text) return;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  await pool.query(
    `INSERT INTO customers(chat_id,name,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(chat_id) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),customers.name),updated_at=NOW()`,
    [chatId, name || null]
  );

  if (text === "/start" || text === "🏠 منوی اصلی") {
    sessions.delete(chatId);
    return send(chatId, await admin(chatId) ? "🍲 پنل مدیریت غذای خانگی مامان حسنا" : "🍲💚 به غذای خانگی مامان حسنا خوش آمدید!\nغذاهای خانگی با عشق و سلیقه؛ برای دیدن منو و موجودی از دکمه زیر استفاده کنید.", await admin(chatId) ? ADMIN : MAIN);
  }
  const sess = sessions.get(chatId);
  if (sess?.mode === "survey") return handleSurvey(chatId, text, sess);
  if (await admin(chatId)) return handleAdmin(chatId, text);

  if (text === "🍽️ مشاهده منو" || text === "🛒 ثبت سفارش") return showMenu(chatId);
  if (text === "📦 پیگیری سفارش") {
    const rows = (await pool.query("SELECT id,status,total,created_at FROM orders WHERE chat_id=$1 ORDER BY id DESC LIMIT 10", [chatId])).rows;
    return send(chatId, rows.length ? rows.map(o => `سفارش #${o.id}\nوضعیت: ${o.status}\nمبلغ نهایی: ${o.total == null ? "در انتظار تعیین هزینه ارسال" : money(o.total)}\nتاریخ: ${new Date(o.created_at).toLocaleString("fa-IR")}`).join("\n\n") : "هنوز سفارشی ثبت نشده است.", MAIN);
  }
  if (text === "📞 تماس با مامان حسنا") return send(chatId, "برای هماهنگی سفارش با مامان حسنا تماس بگیرید:\n۰۹۱۷۷۷۰۰۹۶۱\n۰۹۱۷۹۰۶۸۵۴۴", MAIN);

  if (sess?.mode === "choose_product") {
    const p = (await pool.query("SELECT * FROM products WHERE name=$1", [text])).rows[0];
    if (!p) return send(chatId, "لطفاً نام یکی از غذاهای منو را انتخاب کنید.");
    if (p.stock <= 0) {
      sessions.set(chatId, { mode: "preorder_product", productId: p.id });
      return send(chatId, `❌ ${p.name} فعلاً موجود نیست.\nموجودی فعلی: ۰ عدد\nاگر این غذا را برای فردا می‌خواهید، «درخواست برای فردا» را بزنید.`, keyboard([["🕒 درخواست برای فردا"], ["🍽️ مشاهده منو"]]));
    }
    sessions.set(chatId, { mode: "quantity", productId: p.id });
    return send(chatId, `${p.name}\nقیمت هر پرس: ${money(p.price)}\nموجودی: ${faNum(p.stock)} عدد\nچند عدد می‌خواهید؟`);
  }
  if (sess?.mode === "preorder_product" && text === "🕒 درخواست برای فردا") {
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    sessions.set(chatId, { mode: "preorder_quantity", productId: p.id });
    return send(chatId, `چند عدد «${p.name}» برای فردا می‌خواهید؟ عدد را وارد کنید.`);
  }
  if (sess?.mode === "preorder_quantity") {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return send(chatId, "تعداد معتبر از ۱ تا ۱۰۰ وارد کنید.");
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    sessions.delete(chatId);
    return createPreorder(chatId, name, p, qty);
  }
  if (sess?.mode === "quantity") {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return send(chatId, "لطفاً تعداد معتبر از ۱ تا ۱۰۰ وارد کنید.");
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    if (!p || qty > p.stock) {
      sessions.set(chatId, { mode: "quantity_shortage", productId: sess.productId, requested: qty });
      return send(chatId, `از این غذا فقط ${p?.stock || 0} عدد موجود است.\nمی‌توانید موجودی فعلی را سفارش دهید یا برای تعداد درخواستی، پیش‌سفارش فردا ثبت کنید.`, keyboard([["🛒 سفارش موجودی فعلی"], ["🕒 درخواست برای فردا"], ["🍽️ مشاهده منو"]]));
    }
    sessions.set(chatId, { mode: "confirm", productId: p.id, qty });
    return send(chatId, `خلاصه سفارش:\n${p.name} × ${faNum(qty)}\nجمع غذاها: ${money(p.price * qty)}\n\nبرای ادامه «تأیید سفارش» را بزنید یا «لغو» بنویسید.`);
  }
  if (sess?.mode === "quantity_shortage" && text === "🕒 درخواست برای فردا") {
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    sessions.set(chatId, { mode: "preorder_quantity", productId: p.id });
    return send(chatId, `چند عدد «${p.name}» برای فردا می‌خواهید؟`);
  }
  if (sess?.mode === "quantity_shortage" && text === "🛒 سفارش موجودی فعلی") {
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    if (!p || p.stock <= 0) return send(chatId, "موجودی این غذا تمام شده است؛ برای فردا درخواست ثبت کنید.", keyboard([["🕒 درخواست برای فردا"]]));
    sessions.set(chatId, { mode: "confirm", productId: p.id, qty: Math.min(sess.requested, p.stock) });
    return send(chatId, `از «${p.name}» تعداد ${faNum(Math.min(sess.requested, p.stock))} عدد موجود است.\nبرای ثبت سفارش همین تعداد، «تأیید سفارش» را بزنید.`);
  }
  if (sess?.mode === "confirm" && text === "لغو") {
    sessions.delete(chatId);
    return send(chatId, "سفارش لغو شد.", MAIN);
  }
  if (sess?.mode === "confirm" && text === "تأیید سفارش") {
    const p = (await pool.query("SELECT * FROM products WHERE id=$1", [sess.productId])).rows[0];
    if (!p || p.stock < sess.qty) {
      sessions.delete(chatId);
      return send(chatId, "متأسفانه موجودی تغییر کرده است. لطفاً منو را دوباره بررسی کنید.", MAIN);
    }
    sessions.set(chatId, { mode: "contact_phone", productId: p.id, qty: sess.qty });
    return send(chatId, "برای ثبت سفارش، شماره تماس خود را ارسال کنید (فقط شماره را بنویسید).");
  }
  if (sess?.mode === "contact_phone") {
    const phone = text.replace(/\s/g, "");
    if (!/^[+0-9۰-۹-]{8,18}$/.test(phone)) return send(chatId, "شماره تماس معتبر وارد کنید.");
    sessions.set(chatId, { ...sess, mode: "contact_address", phone });
    return send(chatId, "حالا نشانی کامل تحویل غذا را بنویسید.");
  }
  if (sess?.mode === "contact_address") {
    if (text.length < 8) return send(chatId, "لطفاً نشانی کامل‌تری وارد کنید.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query("SELECT * FROM products WHERE id=$1 FOR UPDATE", [sess.productId])).rows[0];
      if (!p || p.stock < sess.qty) {
        await client.query("ROLLBACK");
        sessions.delete(chatId);
        return send(chatId, "موجودی در این فاصله تغییر کرده است. لطفاً دوباره منو را بررسی کنید.", MAIN);
      }
      // Reserve inventory when customer confirms the order and provides contact details.
      await client.query("UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2", [sess.qty, p.id]);
      await client.query(
        "INSERT INTO customers(chat_id,name,phone,address,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(chat_id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,address=EXCLUDED.address,updated_at=NOW()",
        [chatId, name || null, sess.phone, text]
      );
      const subtotal = p.price * sess.qty;
      const order = await client.query(
        "INSERT INTO orders(chat_id,customer_name,phone,address,items,subtotal,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [chatId, name || null, sess.phone, text, JSON.stringify([{ product_id:p.id, name:p.name, quantity:sess.qty, unit_price:p.price }]), subtotal, "در انتظار تعیین هزینه ارسال"]
      );
      await client.query("COMMIT");
      sessions.delete(chatId);
      await send(chatId, `✅ درخواست سفارش شما ثبت شد.\nشماره سفارش: #${order.rows[0].id}\nغذا: ${p.name} × ${faNum(sess.qty)}\nجمع غذاها: ${money(subtotal)}\n\nهزینه پیک/اسنپ را مدیریت تعیین می‌کند. پس از آن فاکتور نهایی برای شما ارسال می‌شود.`, MAIN);
      await sendAdminOrder(order.rows[0].id, "🛒 سفارش جدید؛ تعیین هزینه ارسال لازم است");
      return;
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      throw e;
    } finally { client.release(); }
  }

  // A product name can be selected directly from the always-visible menu.
  const product = (await pool.query("SELECT * FROM products WHERE name=$1", [text])).rows[0];
  if (product) {
    if (product.stock <= 0) {
      sessions.set(chatId, { mode: "preorder_product", productId: product.id });
      return send(chatId, `❌ «${product.name}» فعلاً موجود نیست.\nموجودی: ۰ عدد\nبرای درخواست فردا، دکمه زیر را بزنید.`, keyboard([["🕒 درخواست برای فردا"], ["🍽️ مشاهده منو"]]));
    }
    sessions.set(chatId, { mode: "quantity", productId: product.id });
    return send(chatId, `${product.name}\nقیمت: ${money(product.price)}\nموجودی: ${faNum(product.stock)} عدد\nچند عدد می‌خواهید؟`);
  }
  if (text === "🕒 درخواست برای فردا") {
    const ps = await getProducts();
    sessions.set(chatId, { mode: "choose_preorder_product" });
    return send(chatId, "غذای مورد نظر برای فردا را انتخاب کنید:", keyboard(ps.map(p => [p.name]).concat([["🏠 منوی اصلی"]])));
  }
  if (sess?.mode === "choose_preorder_product") {
    const p = (await pool.query("SELECT * FROM products WHERE name=$1", [text])).rows[0];
    if (!p) return send(chatId, "لطفاً یک غذا را از فهرست انتخاب کنید.");
    sessions.set(chatId, { mode: "preorder_quantity", productId: p.id });
    return send(chatId, `چند عدد «${p.name}» برای فردا می‌خواهید؟`);
  }
  return send(chatId, "برای دیدن غذاها «🍽️ مشاهده منو» را انتخاب کنید.", MAIN);
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  console.log("Starting Bale polling...");
  while (true) {
    try {
      const updates = await bale("getUpdates", { offset, timeout: Number(process.env.POLL_TIMEOUT || 25), allowed_updates: ["message"] });
      for (const update of updates || []) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        const msg = update.message;
        // Log group chat identifiers so ADMIN_CHAT_ID can be configured safely.
        if (msg?.chat && msg.chat.type !== "private") {
          console.log("BALE_GROUP_CHAT", JSON.stringify({
            chat_id: String(msg.chat.id),
            type: msg.chat.type,
            title: msg.chat.title || null,
            text: String(msg.text || "").slice(0, 80)
          }));
        }
        try { await handleMessage(msg); }
        catch (e) { console.error("Message handler error:", e.message); }
      }
    } catch (e) {
      console.error("Bale polling error:", e.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

app.get("/", (_req, res) => res.status(200).send("Maman Hosna Food Bot is running."));
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected", polling: polling });
  } catch (e) {
    res.status(500).json({ ok: false, error: "database connection failed" });
  }
});

(async () => {
  if (!TOKEN) throw new Error("Missing BALE_BOT_TOKEN environment variable");
  if (!DATABASE_URL) throw new Error("Missing DATABASE_URL environment variable");
  await initDb();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  pollLoop().catch(e => console.error("Polling loop stopped:", e));
})().catch(e => {
  console.error("Startup failed:", e);
  process.exit(1);
});

