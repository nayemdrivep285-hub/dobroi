require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================
// CONFIG
// ==========================
const ADMIN_IDS = [123456789]; // 🔥 PUT YOUR TELEGRAM ID

// ==========================
// MONGODB
// ==========================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log(err));

const User = mongoose.model('User', new mongoose.Schema({
    userId: Number,
    phone: String,
    language: String,
    country: String,
    createdAt: { type: Date, default: Date.now }
}));

const Activity = mongoose.model('Activity', new mongoose.Schema({
    userId: Number,
    type: String,
    promo: String,
    createdAt: { type: Date, default: Date.now }
}));

// ==========================
// SESSION
// ==========================
const sessions = {};
function getSession(id) {
    if (!sessions[id]) sessions[id] = { step: 'phone', data: {} };
    return sessions[id];
}

// ==========================
// UTIL
// ==========================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================
// START
// ==========================
bot.start((ctx) => {
    const s = getSession(ctx.from.id);
    s.step = 'phone';

    return ctx.reply(
        "📱 Share your phone number",
        Markup.keyboard([
            [Markup.button.contactRequest("📲 Share Number")]
        ]).resize()
    );
});

// ==========================
// PHONE
// ==========================
bot.on('contact', async (ctx) => {
    const s = getSession(ctx.from.id);

    const phone = ctx.message.contact.phone_number;
    s.data.phone = phone;

    await User.findOneAndUpdate(
        { userId: ctx.from.id },
        { userId: ctx.from.id, phone },
        { upsert: true }
    );

    s.step = 'language';

    return ctx.reply(
        "🌐 Select Language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English", "lang_en")],
            [Markup.button.callback("🇧🇩 Bengali", "lang_bn")],
            [Markup.button.callback("🇮🇳 Hindi", "lang_hi")]
        ])
    );
});

// ==========================
// LANGUAGE
// ==========================
bot.action(/lang_(.+)/, async (ctx) => {
    const s = getSession(ctx.from.id);
    const lang = ctx.match[1];

    s.data.language = lang;

    await User.updateOne({ userId: ctx.from.id }, { language: lang });

    s.step = 'country';

    return ctx.editMessageText(
        "🌍 Select Country",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇧🇩 Bangladesh", "country_bd"),
             Markup.button.callback("🇮🇳 India", "country_in")],
            [Markup.button.callback("🇹🇷 Turkey", "country_tr"),
             Markup.button.callback("🇵🇭 Philippines", "country_ph")],
            [Markup.button.callback("🇹🇭 Thailand", "country_th"),
             Markup.button.callback("🇵🇰 Pakistan", "country_pk")]
        ])
    );
});

// ==========================
// COUNTRY
// ==========================
bot.action(/country_(.+)/, async (ctx) => {
    const s = getSession(ctx.from.id);
    const country = ctx.match[1];

    s.data.country = country;

    await User.updateOne({ userId: ctx.from.id }, { country });

    s.step = 'type';

    return ctx.editMessageText(
        "🎨 Select Banner Type",
        Markup.inlineKeyboard([
            [Markup.button.callback("⚽ Match", "type_match"),
             Markup.button.callback("🎁 Promo", "type_promo")],
            [Markup.button.callback("📦 All", "type_all")]
        ])
    );
});

// ==========================
// TYPE
// ==========================
bot.action(/type_(.+)/, (ctx) => {
    const s = getSession(ctx.from.id);
    s.data.type = ctx.match[1];
    s.step = 'promo';

    return ctx.reply("✏️ Enter Promo Code (Max 10):");
});

// ==========================
// TEXT HANDLER (PROMO + BROADCAST)
// ==========================
bot.on('text', async (ctx) => {
    const s = getSession(ctx.from.id);

    // ======================
    // BROADCAST
    // ======================
    if (s.step === 'broadcast' && ADMIN_IDS.includes(ctx.from.id)) {
        const users = await User.find({});
        let success = 0;

        await ctx.reply(`🚀 Sending to ${users.length} users...`);

        for (let u of users) {
            try {
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
                success++;
                await sleep(50);
            } catch {}
        }

        s.step = null;

        return ctx.reply(`✅ Done: ${success} users`);
    }

    // ======================
    // PROMO INPUT
    // ======================
    if (s.step === 'promo') {
        const promo = ctx.message.text.trim();

        if (promo.length > 10) {
            return ctx.reply("❌ Max 10 characters");
        }

        s.data.promo = promo;

        await Activity.create({
            userId: ctx.from.id,
            type: "generate",
            promo
        });

        await ctx.reply("⏳ Generating posters...");

        return generate(ctx, s.data);
    }
});

// ==========================
// GENERATE
// ==========================
async function generate(ctx, data) {
    try {
        const dir = path.join(
            __dirname,
            'assets',
            data.language,
            data.country,
            data.type
        );

        if (!fs.existsSync(dir)) {
            return ctx.reply("❌ No templates found");
        }

        const files = fs.readdirSync(dir).slice(0, 5);
        const results = [];

        for (let f of files) {
            const input = path.join(dir, f);
            const output = path.join('/tmp', `${Date.now()}_${f}`);

            await createPoster(input, output, data.promo);
            results.push(output);
        }

        await ctx.replyWithMediaGroup(
            results.map(x => ({
                type: 'photo',
                media: { source: x }
            }))
        );

        ctx.reply(`🔥 Promo Code: ${data.promo}`);

    } catch (e) {
        console.log(e);
        ctx.reply("❌ Error generating");
    }
}

// ==========================
// POSTER ENGINE
// ==========================
async function createPoster(input, output, promo) {
    const img = sharp(input);
    const meta = await img.metadata();

    const svg = `
    <svg width="${meta.width}" height="${meta.height}">
        <text x="50%" y="90%" text-anchor="middle"
        font-size="60" fill="white" font-weight="bold">
        ${promo}
        </text>
    </svg>`;

    await img.composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toFile(output);
}

// ==========================
// ADMIN PANEL
// ==========================

// start admin
bot.command('admin', (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const s = getSession(ctx.from.id);
    s.step = 'admin_lang';

    ctx.reply("Select Language", Markup.inlineKeyboard([
        [Markup.button.callback("EN", "a_lang_en"),
         Markup.button.callback("BN", "a_lang_bn")]
    ]));
});

// language
bot.action(/a_lang_(.+)/, (ctx) => {
    const s = getSession(ctx.from.id);
    s.data = { lang: ctx.match[1] };
    s.step = 'admin_country';

    ctx.editMessageText("Country?", Markup.inlineKeyboard([
        [Markup.button.callback("BD", "a_c_bd"),
         Markup.button.callback("IN", "a_c_in")],
        [Markup.button.callback("TR", "a_c_tr"),
         Markup.button.callback("PK", "a_c_pk")]
    ]));
});

// country
bot.action(/a_c_(.+)/, (ctx) => {
    const s = getSession(ctx.from.id);
    s.data.country = ctx.match[1];
    s.step = 'admin_type';

    ctx.editMessageText("Type?", Markup.inlineKeyboard([
        [Markup.button.callback("match", "a_t_match"),
         Markup.button.callback("promo", "a_t_promo")],
        [Markup.button.callback("all", "a_t_all")]
    ]));
});

// type
bot.action(/a_t_(.+)/, (ctx) => {
    const s = getSession(ctx.from.id);
    s.data.type = ctx.match[1];
    s.step = 'admin_upload';

    ctx.reply("📤 Send image");
});

// upload
bot.on('photo', async (ctx) => {
    const s = getSession(ctx.from.id);

    if (s.step !== 'admin_upload') return;

    const file = ctx.message.photo.pop();
    const link = await ctx.telegram.getFileLink(file.file_id);

    const folder = path.join(__dirname, 'assets', s.data.lang, s.data.country, s.data.type);
    fs.mkdirSync(folder, { recursive: true });

    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    const filePath = path.join(folder, `${Date.now()}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    ctx.reply("✅ Template Saved!");
});

// ==========================
// BROADCAST COMMAND
// ==========================
bot.command('broadcast', (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const s = getSession(ctx.from.id);
    s.step = 'broadcast';

    ctx.reply("📢 Send message to broadcast");
});

// ==========================
bot.launch();
console.log("🚀 BOT LIVE");
