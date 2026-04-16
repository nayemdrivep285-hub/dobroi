require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= ADMIN =================
const ADMIN_IDS = [123456789];

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("Mongo Connected"))
.catch(err=>console.log(err));

// ================= USER MODEL =================
const User = mongoose.model('User', new mongoose.Schema({
    userId: Number,
    phone: String,
    language: String,
    country: String
}));

// ================= SESSION =================
const sessions = {};
const getSession = (id) => {
    if (!sessions[id]) sessions[id] = { step: null, data: {} };
    return sessions[id];
};

// ================= START =================
bot.start(async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    const s = getSession(ctx.from.id);

    // EXISTING USER
    if (user && user.phone) {
        if (ADMIN_IDS.includes(ctx.from.id)) {
            s.step = 'admin';
            return ctx.reply("👑 Admin Panel",
                Markup.keyboard([
                    ["🛠 Upload Template"],
                    ["📢 Broadcast"]
                ]).resize()
            );
        }

        s.step = 'language';
        return sendLanguage(ctx);
    }

    // NEW USER
    s.step = 'phone';
    return ctx.reply("📱 Share your phone",
        Markup.keyboard([
            [Markup.button.contactRequest("📲 Share Number")]
        ]).resize()
    );
});

// ================= LANGUAGE =================
function sendLanguage(ctx) {
    ctx.reply("🌐 Select Language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English", "lang_en"),
             Markup.button.callback("🇧🇩 বাংলা", "lang_bn")],
            [Markup.button.callback("🇮🇳 हिंदी", "lang_hi"),
             Markup.button.callback("🇸🇦 العربية", "lang_ar")]
        ])
    );
}

// ================= CONTACT =================
bot.on('contact', async (ctx) => {
    const phone = ctx.message.contact.phone_number;
    const s = getSession(ctx.from.id);

    await User.findOneAndUpdate(
        { userId: ctx.from.id },
        {
            userId: ctx.from.id,
            phone
        },
        { upsert: true }
    );

    s.step = 'language';
    return sendLanguage(ctx);
});

// ================= LANGUAGE SELECT =================
bot.action(/lang_(.+)/, async (ctx) => {
    const s = getSession(ctx.from.id);
    s.data.language = ctx.match[1];
    s.step = 'country';

    ctx.editMessageText("🌍 Select Country",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇧🇩 BD", "country_bd"),
             Markup.button.callback("🇮🇳 IN", "country_in")],
            [Markup.button.callback("🇹🇷 TR", "country_tr"),
             Markup.button.callback("🇵🇭 PH", "country_ph")],
            [Markup.button.callback("🇹🇭 TH", "country_th"),
             Markup.button.callback("🇵🇰 PK", "country_pk")]
        ])
    );
});

// ================= COUNTRY =================
bot.action(/country_(.+)/, ctx => {
    const s = getSession(ctx.from.id);
    s.data.country = ctx.match[1];
    s.step = 'type';

    ctx.editMessageText("🎨 Select Type",
        Markup.inlineKeyboard([
            [Markup.button.callback("⚽ Match", "type_match"),
             Markup.button.callback("🎁 Promo", "type_promo")],
            [Markup.button.callback("📦 All", "type_all")]
        ])
    );
});

// ================= TYPE =================
bot.action(/type_(.+)/, ctx => {
    const s = getSession(ctx.from.id);
    s.data.type = ctx.match[1];
    s.step = 'promo';

    ctx.reply("✏️ Enter Promo Code (max 10)");
});

// ================= ADMIN BUTTONS =================
bot.hears("🛠 Upload Template", ctx => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    getSession(ctx.from.id).step = 'upload';
    ctx.reply("📤 Send image");
});

bot.hears("📢 Broadcast", ctx => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    getSession(ctx.from.id).step = 'broadcast';
    ctx.reply("📢 Send message");
});

// ================= TEXT HANDLER =================
bot.on('text', async (ctx) => {
    const s = getSession(ctx.from.id);

    // BROADCAST
    if (s.step === 'broadcast') {
        const users = await User.find({});
        let sent = 0;

        for (const u of users) {
            try {
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
                sent++;
            } catch {}
        }

        s.step = 'admin';
        return ctx.reply(`✅ Broadcast sent to ${sent} users`);
    }

    // PROMO INPUT
    if (s.step === 'promo') {
        s.data.promo = ctx.message.text.trim();

        ctx.reply("⏳ Generating posters...");

        return generateBanners(ctx, s.data);
    }
});

// ================= GENERATE BANNERS =================
async function generateBanners(ctx, data) {
    try {
        const dir = path.join(__dirname, 'assets', 'en', 'bd', 'match');

        if (!fs.existsSync(dir))
            return ctx.reply("❌ No templates found");

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.jpg') || f.endsWith('.png'));

        const outputs = [];

        for (const file of files.slice(0, 5)) {
            const input = path.join(dir, file);
            const output = path.join('/tmp', Date.now() + file);

            await addPromoText(input, output, data.promo);
            outputs.push(output);
        }

        await ctx.replyWithMediaGroup(outputs.map(f => ({
            type: 'photo',
            media: { source: f }
        })));

        // SUCCESS MESSAGE
        await ctx.reply(`🔥 Promo Code: ${data.promo}`);

        // ADMIN LOG
        ADMIN_IDS.forEach(id => {
            bot.telegram.sendMessage(id,
                `🎨 New Banner Generated\nUser: ${ctx.from.id}\nPromo: ${data.promo}`
            );
        });

    } catch (err) {
        console.log(err);
        ctx.reply("❌ Error generating banners");
    }
}

// ================= FINAL TEXT ENGINE =================
async function addPromoText(input, output, promoCode) {
    const img = sharp(input);
    const { width, height } = await img.metadata();

    // keep your design font size logic stable
    const fontSize = Math.max(70, Math.min(width * 0.09, 120));

    const textSvg = `
    <svg width="${width}" height="${height}">
      <text 
        x="50%" 
        y="85%" 
        text-anchor="middle" 
        font-family="Azo Sans Uber, Arial Black, Impact, sans-serif"
        font-size="${fontSize}" 
        font-weight="900"
        fill="#ff00a2" 
        stroke="black"
        stroke-width="4"
        paint-order="stroke"
        letter-spacing="2px"
      >
        ${promoCode}
      </text>
    </svg>
    `;

    await img
        .composite([{ input: Buffer.from(textSvg) }])
        .jpeg({ quality: 95 })
        .toFile(output);
}

// ================= UPLOAD TEMPLATE =================
bot.on('photo', async ctx => {
    const s = getSession(ctx.from.id);
    if (s.step !== 'upload') return;

    const file = ctx.message.photo.pop();
    const link = await ctx.telegram.getFileLink(file.file_id);

    const folder = path.join(__dirname, 'assets', 'en', 'bd', 'match');
    fs.mkdirSync(folder, { recursive: true });

    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    fs.writeFileSync(
        path.join(folder, Date.now() + ".jpg"),
        Buffer.from(buffer)
    );

    ctx.reply("✅ Template uploaded");
});

// ================= RUN =================
bot.launch();
console.log("🚀 Bot Running");
