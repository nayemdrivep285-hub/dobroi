require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= CONFIG =================
const ADMIN_IDS = [123456789]; // 🔥 PUT YOUR TELEGRAM ID

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err.message));

const User = mongoose.model('User', new mongoose.Schema({
    userId: Number,
    phone: String,
    language: { type: String, default: 'en' },
    country: String
}));

// ================= SESSION =================
const sessions = {};
const getSession = (id) => {
    if (!sessions[id]) sessions[id] = { step: 'phone', data: {} };
    return sessions[id];
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================= START =================
bot.start(ctx => {
    const s = getSession(ctx.from.id);
    s.step = 'phone';

    ctx.reply("📱 Share your phone",
        Markup.keyboard([[Markup.button.contactRequest("📲 Share Number")]])
        .resize()
    );
});

// ================= PHONE =================
bot.on('contact', async (ctx) => {
    const s = getSession(ctx.from.id);
    const phone = ctx.message.contact.phone_number;

    await User.findOneAndUpdate(
        { userId: ctx.from.id },
        { userId: ctx.from.id, phone },
        { upsert: true }
    );

    // ADMIN MENU
    if (ADMIN_IDS.includes(ctx.from.id)) {
        s.step = 'admin_menu';

        return ctx.reply("👑 Admin Panel",
            Markup.keyboard([
                ["🛠 Upload Template"],
                ["📢 Broadcast"]
            ]).resize()
        );
    }

    s.step = 'language';

    ctx.reply("🌐 Select Language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English", "lang_en")]
        ])
    );
});

// ================= LANGUAGE =================
bot.action(/lang_(.+)/, async (ctx) => {
    const s = getSession(ctx.from.id);
    const lang = ctx.match[1];

    s.data.language = lang;

    await User.updateOne({ userId: ctx.from.id }, { language: lang });

    s.step = 'country';

    ctx.editMessageText("🌍 Select Country",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇧🇩 BD", "country_bd"),
             Markup.button.callback("🇮🇳 IN", "country_in")]
        ])
    );
});

// ================= COUNTRY =================
bot.action(/country_(.+)/, async (ctx) => {
    const s = getSession(ctx.from.id);
    s.data.country = ctx.match[1];
    s.step = 'type';

    ctx.editMessageText("🎨 Select Type",
        Markup.inlineKeyboard([
            [Markup.button.callback("⚽ Match", "type_match"),
             Markup.button.callback("🎁 Promo", "type_promo")]
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

// ================= TEXT =================
bot.on('text', async (ctx) => {
    const s = getSession(ctx.from.id);

    // ADMIN MENU
    if (s.step === 'admin_menu' && ADMIN_IDS.includes(ctx.from.id)) {

        if (ctx.message.text === "🛠 Upload Template") {
            s.step = 'admin_upload';
            return ctx.reply("📤 Send image (saved to EN/BD/MATCH)");
        }

        if (ctx.message.text === "📢 Broadcast") {
            s.step = 'broadcast';
            return ctx.reply("Send message:");
        }
    }

    // BROADCAST
    if (s.step === 'broadcast') {
        const users = await User.find({});
        for (let u of users) {
            try {
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
                await sleep(50);
            } catch {}
        }
        s.step = null;
        return ctx.reply("✅ Broadcast Done");
    }

    // PROMO
    if (s.step === 'promo') {
        const promo = ctx.message.text.trim();

        if (promo.length > 10) return ctx.reply("❌ Max 10 char");

        s.data.promo = promo;

        ctx.reply("⏳ Generating posters...");

        return generate(ctx, s.data);
    }
});

// ================= GENERATE =================
async function generate(ctx, data) {
    try {
        let dir = path.join(__dirname, 'assets', data.language || 'en', data.country, data.type);

        // fallback
        if (!fs.existsSync(dir)) {
            dir = path.join(__dirname, 'assets', 'en', data.country, data.type);
        }

        if (!fs.existsSync(dir)) {
            return ctx.reply("❌ No templates found");
        }

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));

        if (!files.length) return ctx.reply("❌ Folder empty");

        const selected = files.slice(0, 5);
        const results = [];

        for (let f of selected) {
            const input = path.join(dir, f);
            const output = path.join('/tmp', `${Date.now()}_${f}`);

            await addTextToImage(input, output, data.promo);
            results.push(output);
        }

        await ctx.replyWithMediaGroup(results.map(x => ({
            type: 'photo',
            media: { source: x }
        })));

        ctx.reply(`🔥 Promo Code: ${data.promo}`);

    } catch (e) {
        console.log(e);
        ctx.reply("❌ Error generating");
    }
}

// ================= IMAGE ENGINE (FIXED) =================
async function addTextToImage(inputPath, outputPath, promoCode) {
    try {
        const image = sharp(inputPath);
        const { width, height } = await image.metadata();

        const yPosition = height * 0.78;
        const fontSize = Math.max(60, Math.min(width * 0.08, 110));

        const svg = `
        <svg width="${width}" height="${height}">
            <defs>
                <filter id="glow">
                    <feGaussianBlur stdDeviation="4" result="blur"/>
                    <feMerge>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>

            <text 
                x="50%" 
                y="${yPosition}" 
                text-anchor="middle"
                font-family="Impact, Arial Black, sans-serif"
                font-size="${fontSize}"
                font-weight="900"
                fill="#ffffff"
                letter-spacing="3px"
                filter="url(#glow)"
            >
                ${promoCode}
            </text>
        </svg>
        `;

        await image
            .composite([{ input: Buffer.from(svg) }])
            .jpeg({ quality: 90 })
            .toFile(outputPath);

        return true;

    } catch (err) {
        console.log(err);
        return false;
    }
}

// ================= ADMIN UPLOAD =================
bot.on('photo', async (ctx) => {
    const s = getSession(ctx.from.id);

    if (s.step !== 'admin_upload') return;

    const file = ctx.message.photo.pop();
    const link = await ctx.telegram.getFileLink(file.file_id);

    const folder = path.join(__dirname, 'assets', 'en', 'bd', 'match');
    fs.mkdirSync(folder, { recursive: true });

    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    const filePath = path.join(folder, `${Date.now()}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    ctx.reply("✅ Template Saved (EN/BD/MATCH)");
});

// ================= START =================
bot.launch();
console.log("🚀 BOT RUNNING");
