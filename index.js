require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= CONFIG =================
const ADMIN_IDS = [123456789]; // your telegram id

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("Mongo Connected"))
.catch(err => console.log(err));

const User = mongoose.model('User', new mongoose.Schema({
    userId: Number,
    phone: String,
    language: String,
    country: String
}));

// ================= SESSION =================
const sessions = {};
function getSession(id){
    if(!sessions[id]) sessions[id] = { step:'phone', data:{} };
    return sessions[id];
}

// ================= TEXT =================
function getText(lang){
    const t = {
        en:{ phone:"📱 Share your number", lang:"🌐 Select language", country:"🌍 Select country", type:"🎨 Select banner type", promo:"✏️ Enter Promo Code", done:"✅ Posters generated!" },
        bn:{ phone:"📱 নাম্বার শেয়ার করুন", lang:"🌐 ভাষা নির্বাচন করুন", country:"🌍 দেশ নির্বাচন করুন", type:"🎨 ব্যানার টাইপ নির্বাচন করুন", promo:"✏️ প্রোমো কোড দিন", done:"✅ পোস্টার তৈরি হয়েছে!" },
        hi:{ phone:"📱 नंबर शेयर करें", lang:"🌐 भाषा चुनें", country:"🌍 देश चुनें", type:"🎨 बैनर चुनें", promo:"✏️ प्रोमो कोड डालें", done:"✅ पोस्टर तैयार!" },
        ar:{ phone:"📱 شارك رقمك", lang:"🌐 اختر اللغة", country:"🌍 اختر الدولة", type:"🎨 اختر نوع البانر", promo:"✏️ أدخل كود العرض", done:"✅ تم إنشاء البوستر!" }
    };
    return t[lang] || t.en;
}

// ================= START =================
bot.start(ctx=>{
    const s = getSession(ctx.from.id);
    s.step='phone';

    ctx.reply("📱 Share your phone",
        Markup.keyboard([
            [Markup.button.contactRequest("📲 Share Number")]
        ]).resize()
    );
});

// ================= PHONE =================
bot.on('contact', async ctx=>{
    const s = getSession(ctx.from.id);
    const phone = ctx.message.contact.phone_number;

    await User.findOneAndUpdate(
        { userId: ctx.from.id },
        { userId: ctx.from.id, phone },
        { upsert:true }
    );

    if(ADMIN_IDS.includes(ctx.from.id)){
        s.step='admin_menu';
        return ctx.reply("👑 Admin Panel",
            Markup.keyboard([
                ["🛠 Upload Template"],
                ["📢 Broadcast"]
            ]).resize()
        );
    }

    s.step='language';

    ctx.reply("🌐 Select language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English","lang_en"), Markup.button.callback("🇧🇩 বাংলা","lang_bn")],
            [Markup.button.callback("🇮🇳 हिंदी","lang_hi"), Markup.button.callback("🇸🇦 العربية","lang_ar")]
        ])
    );
});

// ================= LANGUAGE =================
bot.action(/lang_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.language = ctx.match[1];
    s.step='country';

    ctx.editMessageText("🌍 Select country",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇧🇩 BD","country_bd"), Markup.button.callback("🇮🇳 IN","country_in")],
            [Markup.button.callback("🇹🇷 TR","country_tr"), Markup.button.callback("🇵🇭 PH","country_ph")],
            [Markup.button.callback("🇹🇭 TH","country_th"), Markup.button.callback("🇵🇰 PK","country_pk")]
        ])
    );
});

// ================= COUNTRY =================
bot.action(/country_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.country = ctx.match[1];
    s.step='type';

    ctx.editMessageText("🎨 Select banner type",
        Markup.inlineKeyboard([
            [Markup.button.callback("⚽ Match","type_match"), Markup.button.callback("🎁 Promo","type_promo")],
            [Markup.button.callback("📦 All","type_all")]
        ])
    );
});

// ================= TYPE =================
bot.action(/type_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.type = ctx.match[1];
    s.step='promo';

    const txt = getText(s.data.language);
    ctx.reply(txt.promo);
});

// ================= TEXT =================
bot.on('text', async ctx=>{
    const s = getSession(ctx.from.id);

    // ADMIN MENU
    if(s.step==='admin_menu'){
        if(ctx.message.text==="🛠 Upload Template"){
            s.step='admin_upload';
            return ctx.reply("Send image now");
        }

        if(ctx.message.text==="📢 Broadcast"){
            s.step='broadcast';
            return ctx.reply("Send broadcast message");
        }
    }

    // BROADCAST
    if(s.step==='broadcast'){
        const users = await User.find({});
        for(const u of users){
            try{ await bot.telegram.sendMessage(u.userId, ctx.message.text); } catch{}
        }
        s.step='admin_menu';
        return ctx.reply("✅ Broadcast sent");
    }

    // PROMO CODE
    if(s.step==='promo'){
        s.data.promo = ctx.message.text.trim();
        ctx.reply("⏳ Generating posters...");
        return generatePosters(ctx,s.data);
    }
});

// ================= GENERATE =================
async function generatePosters(ctx,data){
    try{
        let dir = path.join(__dirname,'assets',data.language,data.country,data.type);

        if(!fs.existsSync(dir)){
            return ctx.reply("❌ No templates found");
        }

        const files = fs.readdirSync(dir).filter(f=>f.endsWith('.jpg')||f.endsWith('.png'));

        if(!files.length){
            return ctx.reply("❌ No templates found");
        }

        const results = [];

        for(const file of files.slice(0,5)){
            const input = path.join(dir,file);
            const output = path.join('/tmp',`${Date.now()}_${file}`);

            await addPromoText(input,output,data.promo);
            results.push(output);
        }

        await ctx.replyWithMediaGroup(results.map(f=>({
            type:'photo',
            media:{ source:f }
        })));

        const txt = getText(data.language);
        await ctx.reply(txt.done);

        // ADMIN NOTIFY
        for(const adminId of ADMIN_IDS){
            await bot.telegram.sendMessage(adminId,
                `🎨 New Banner Generated\nUser: ${ctx.from.id}\nPromo: ${data.promo}\nLang: ${data.language}\nCountry: ${data.country}`
            );
        }

        // FINAL PROMO MESSAGE
        await ctx.reply(
            `🚀 Use Promo Code: ${data.promo}`,
            Markup.inlineKeyboard([
                [Markup.button.url("📱 Download App","https://7starswin.com")]
            ])
        );

    }catch(err){
        console.log(err);
        ctx.reply("❌ Error generating posters");
    }
}

// ================= IMAGE PROCESS =================
async function addPromoText(input,output,promo){
    const image = sharp(input);
    const meta = await image.metadata();

    const yPosition = meta.height * 0.865;
    const fontSize = Math.max(60, Math.min(meta.width * 0.09, 110));

    const svg = `
    <svg width="${meta.width}" height="${meta.height}">
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
            fill="white"
            letter-spacing="3"
            filter="url(#glow)"
        >
            ${promo}
        </text>
    </svg>
    `;

    await image
        .composite([{ input: Buffer.from(svg) }])
        .jpeg({ quality: 95 })
        .toFile(output);
}

// ================= ADMIN PHOTO UPLOAD =================
bot.on('photo', async ctx=>{
    const s = getSession(ctx.from.id);
    if(s.step!=='admin_upload') return;

    const file = ctx.message.photo.pop();
    const link = await ctx.telegram.getFileLink(file.file_id);

    const folder = path.join(__dirname,'assets','en','bd','match');
    fs.mkdirSync(folder,{ recursive:true });

    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    fs.writeFileSync(path.join(folder,`${Date.now()}.jpg`),Buffer.from(buffer));

    s.step='admin_menu';
    ctx.reply("✅ Template uploaded");
});

// ================= RUN =================
bot.launch();
console.log("🚀 Bot running");
