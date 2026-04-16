require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ========= CONFIG =========
const ADMIN_IDS = [123456789];

// ========= DB =========
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("Mongo Connected"))
.catch(err=>console.log(err));

const User = mongoose.model('User', new mongoose.Schema({
    userId:Number,
    phone:String
}));

// ========= SESSION =========
const sessions = {};
const getSession = (id)=>{
    if(!sessions[id]) sessions[id]={ step:'phone', data:{} };
    return sessions[id];
};

// ========= START =========
bot.start(async ctx=>{
    const user = await User.findOne({ userId: ctx.from.id });
    const s = getSession(ctx.from.id);

    if(user && user.phone){
        if(ADMIN_IDS.includes(ctx.from.id)){
            s.step='admin';
            return ctx.reply("👑 Admin Panel",
                Markup.keyboard([
                    ["🛠 Upload Template"],
                    ["📢 Broadcast"]
                ]).resize()
            );
        }

        s.step='language';
        return ctx.reply("🌐 Select Language",
            Markup.inlineKeyboard([
                [Markup.button.callback("🇺🇸 English","lang_en"),Markup.button.callback("🇧🇩 বাংলা","lang_bn")],
                [Markup.button.callback("🇮🇳 हिंदी","lang_hi"),Markup.button.callback("🇸🇦 العربية","lang_ar")]
            ])
        );
    }

    s.step='phone';
    ctx.reply("📱 Share phone",
        Markup.keyboard([[Markup.button.contactRequest("📲 Share Number")]]).resize()
    );
});

// ========= PHONE =========
bot.on('contact', async ctx=>{
    const phone = ctx.message.contact.phone_number;

    await User.findOneAndUpdate(
        { userId: ctx.from.id },
        { userId: ctx.from.id, phone },
        { upsert:true }
    );

    ctx.reply("✅ Saved");

    return bot.telegram.sendMessage(ctx.chat.id,"🌐 Select Language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English","lang_en"),Markup.button.callback("🇧🇩 বাংলা","lang_bn")],
            [Markup.button.callback("🇮🇳 हिंदी","lang_hi"),Markup.button.callback("🇸🇦 العربية","lang_ar")]
        ])
    );
});

// ========= LANGUAGE =========
bot.action(/lang_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.language = ctx.match[1];
    s.step='country';

    ctx.editMessageText("🌍 Select Country",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇧🇩 BD","country_bd"),Markup.button.callback("🇮🇳 IN","country_in")],
            [Markup.button.callback("🇹🇷 TR","country_tr"),Markup.button.callback("🇵🇭 PH","country_ph")],
            [Markup.button.callback("🇹🇭 TH","country_th"),Markup.button.callback("🇵🇰 PK","country_pk")]
        ])
    );
});

// ========= COUNTRY =========
bot.action(/country_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.country = ctx.match[1];
    s.step='type';

    ctx.editMessageText("🎨 Select Banner Type",
        Markup.inlineKeyboard([
            [Markup.button.callback("⚽ Match","type_match"),Markup.button.callback("🎁 Promo","type_promo")],
            [Markup.button.callback("📦 All","type_all")]
        ])
    );
});

// ========= TYPE =========
bot.action(/type_(.+)/, ctx=>{
    const s = getSession(ctx.from.id);
    s.data.type = ctx.match[1];
    s.step='promo';

    ctx.reply("✏️ Enter Promo Code");
});

// ========= ADMIN BUTTONS =========
bot.hears("🛠 Upload Template", ctx=>{
    if(!ADMIN_IDS.includes(ctx.from.id)) return;
    getSession(ctx.from.id).step='upload';
    ctx.reply("Send image");
});

bot.hears("📢 Broadcast", ctx=>{
    if(!ADMIN_IDS.includes(ctx.from.id)) return;
    getSession(ctx.from.id).step='broadcast';
    ctx.reply("Send message");
});

// ========= TEXT =========
bot.on('text', async ctx=>{
    const s = getSession(ctx.from.id);

    // BROADCAST
    if(s.step==='broadcast'){
        const users = await User.find({});
        for(const u of users){
            try{
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
            }catch{}
        }
        s.step='admin';
        return ctx.reply("✅ Broadcast done");
    }

    // PROMO
    if(s.step==='promo'){
        s.data.promo = ctx.message.text.trim();
        ctx.reply("⏳ Generating...");
        return generate(ctx, s.data);
    }
});

// ========= GENERATE =========
async function generate(ctx,data){
    try{
        const dir = path.join(__dirname,'assets','en','bd','match');

        if(!fs.existsSync(dir)) return ctx.reply("❌ No templates");

        const files = fs.readdirSync(dir).filter(f=>f.endsWith('.jpg')||f.endsWith('.png'));
        if(!files.length) return ctx.reply("❌ No templates");

        const outputs = [];

        for(const file of files.slice(0,5)){
            const input = path.join(dir,file);
            const output = path.join('/tmp',Date.now()+file);

            await addText(input,output,data.promo);
            outputs.push(output);
        }

        await ctx.replyWithMediaGroup(outputs.map(o=>({
            type:'photo',
            media:{ source:o }
        })));

        await ctx.reply(`🔥 Promo Code: ${data.promo}`);

        // ADMIN LOG
        ADMIN_IDS.forEach(id=>{
            bot.telegram.sendMessage(id,
                `🎨 New Promo\nUser: ${ctx.from.id}\nCode: ${data.promo}`
            );
        });

    }catch(e){
        console.log(e);
        ctx.reply("❌ Error");
    }
}

// ========= SMART TEXT ENGINE =========
async function addText(input, output, promo) {
    const img = sharp(input);
    const { width, height } = await img.metadata();

    const raw = await img.clone().resize(100,100).grayscale().raw().toBuffer();

    let bestY = 0, bestScore = 999999;

    for (let y = 50; y < 100; y++) {
        let sum = 0;
        for (let x = 10; x < 90; x++) {
            sum += raw[y * 100 + x];
        }
        if (sum < bestScore) {
            bestScore = sum;
            bestY = y;
        }
    }

    const yPos = (bestY / 100) * height;
    const fontSize = Math.max(70, Math.min(width * 0.085, 120));

    const svg = `
    <svg width="${width}" height="${height}">
        <style>
            @font-face {
                font-family: 'Bebas';
                src: url('file://${process.cwd()}/fonts/BebasNeue-Regular.ttf');
            }
        </style>

        <text x="50%" y="${yPos+3}" text-anchor="middle"
        font-family="Bebas" font-size="${fontSize}"
        fill="black" opacity="0.6">${promo}</text>

        <text x="50%" y="${yPos}" text-anchor="middle"
        font-family="Bebas" font-size="${fontSize}"
        fill="white" stroke="black" stroke-width="2"
        letter-spacing="4">${promo}</text>
    </svg>
    `;

    await img.composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality:95 })
    .toFile(output);
}

// ========= UPLOAD =========
bot.on('photo', async ctx=>{
    const s = getSession(ctx.from.id);
    if(s.step!=='upload') return;

    const file = ctx.message.photo.pop();
    const link = await ctx.telegram.getFileLink(file.file_id);

    const folder = path.join(__dirname,'assets','en','bd','match');
    fs.mkdirSync(folder,{ recursive:true });

    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();

    fs.writeFileSync(path.join(folder,Date.now()+".jpg"),Buffer.from(buffer));

    ctx.reply("✅ Uploaded");
});

// ========= RUN =========
bot.launch();
console.log("🚀 Bot Running");
