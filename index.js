require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= CONFIG =================
const ADMIN_IDS = [123456789];

// ================= DB =================
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("Mongo Connected"))
.catch(err=>console.log(err));

const User = mongoose.model('User', new mongoose.Schema({
    userId:Number,
    phone:String
}));

// ================= SESSION =================
const sessions = {};
function getSession(id){
    if(!sessions[id]) sessions[id]={ step:'phone', data:{} };
    return sessions[id];
}

// ================= START =================
bot.start(async ctx=>{
    const user = await User.findOne({ userId: ctx.from.id });
    const s = getSession(ctx.from.id);

    // EXISTING USER
    if(user && user.phone){
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
        return sendLanguage(ctx);
    }

    // NEW USER
    s.step='phone';
    ctx.reply("📱 Share phone",
        Markup.keyboard([[Markup.button.contactRequest("📲 Share Number")]]).resize()
    );
});

// ================= LANGUAGE =================
function sendLanguage(ctx){
    return ctx.reply("🌐 Select Language",
        Markup.inlineKeyboard([
            [Markup.button.callback("🇺🇸 English","lang_en"),Markup.button.callback("🇧🇩 বাংলা","lang_bn")],
            [Markup.button.callback("🇮🇳 हिंदी","lang_hi"),Markup.button.callback("🇸🇦 العربية","lang_ar")]
        ])
    );
}

bot.action(/lang_(.+)/, ctx=>{
    const s=getSession(ctx.from.id);
    s.data.language=ctx.match[1];
    s.step='country';

    ctx.editMessageText("🌍 Select Country",
        Markup.inlineKeyboard([
            [Markup.button.callback("BD","country_bd"),Markup.button.callback("IN","country_in")],
            [Markup.button.callback("TR","country_tr"),Markup.button.callback("PH","country_ph")],
            [Markup.button.callback("TH","country_th"),Markup.button.callback("PK","country_pk")]
        ])
    );
});

// ================= COUNTRY =================
bot.action(/country_(.+)/, ctx=>{
    const s=getSession(ctx.from.id);
    s.data.country=ctx.match[1];
    s.step='type';

    ctx.editMessageText("🎨 Select Type",
        Markup.inlineKeyboard([
            [Markup.button.callback("Match","type_match"),Markup.button.callback("Promo","type_promo")],
            [Markup.button.callback("All","type_all")]
        ])
    );
});

// ================= TYPE =================
bot.action(/type_(.+)/, ctx=>{
    const s=getSession(ctx.from.id);
    s.data.type=ctx.match[1];
    s.step='promo';
    ctx.reply("✏️ Enter Promo Code");
});

// ================= PHONE =================
bot.on('contact', async ctx=>{
    const s=getSession(ctx.from.id);
    const phone=ctx.message.contact.phone_number;

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
    sendLanguage(ctx);
});

// ================= ADMIN BUTTONS =================
bot.hears("🛠 Upload Template", ctx=>{
    if(!ADMIN_IDS.includes(ctx.from.id)) return;
    const s=getSession(ctx.from.id);
    s.step='admin_upload';
    ctx.reply("Send image");
});

bot.hears("📢 Broadcast", ctx=>{
    if(!ADMIN_IDS.includes(ctx.from.id)) return;
    const s=getSession(ctx.from.id);
    s.step='broadcast';
    ctx.reply("Send message");
});

// ================= TEXT =================
bot.on('text', async ctx=>{
    const s=getSession(ctx.from.id);

    // BROADCAST
    if(s.step==='broadcast'){
        const users=await User.find({});
        let sent=0;

        for(const u of users){
            try{
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
                sent++;
            }catch{}
        }

        s.step='admin_menu';
        return ctx.reply(`✅ Sent to ${sent} users`);
    }

    // PROMO
    if(s.step==='promo'){
        s.data.promo=ctx.message.text.trim();
        ctx.reply("⏳ Generating...");
        return generate(ctx,s.data);
    }
});

// ================= GENERATE =================
async function generate(ctx,data){
    try{
        const dir=path.join(__dirname,'assets','en','bd','match');

        if(!fs.existsSync(dir)) return ctx.reply("❌ No templates");

        const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jpg'));

        const outputs=[];

        for(const f of files.slice(0,5)){
            const input=path.join(dir,f);
            const output=path.join('/tmp',Date.now()+f);

            await addText(input,output,data.promo);
            outputs.push(output);
        }

        await ctx.replyWithMediaGroup(outputs.map(o=>({
            type:'photo',
            media:{ source:o }
        })));

        await ctx.reply(`🔥 Promo: ${data.promo}`);

        // ADMIN NOTIFY
        for(const admin of ADMIN_IDS){
            bot.telegram.sendMessage(admin,
                `New Promo\nUser: ${ctx.from.id}\nCode: ${data.promo}`
            );
        }

    }catch(e){
        console.log(e);
        ctx.reply("Error");
    }
}

// ================= FIXED TEXT ENGINE =================
async function addText(input,output,promo){
    const img=sharp(input);
    const { width,height }=await img.metadata();

    const y = height * 0.82; // 🔥 FIXED SAFE POSITION
    const font = Math.max(70, width*0.08);

    const svg=`
    <svg width="${width}" height="${height}">
        <text x="50%" y="${y}"
        text-anchor="middle"
        font-size="${font}"
        font-weight="900"
        fill="white"
        font-family="Impact, Arial Black"
        letter-spacing="3">
        ${promo}
        </text>
    </svg>`;

    await img.composite([{ input:Buffer.from(svg) }])
    .jpeg({ quality:95 })
    .toFile(output);
}

// ================= UPLOAD =================
bot.on('photo', async ctx=>{
    const s=getSession(ctx.from.id);
    if(s.step!=='admin_upload') return;

    const file=ctx.message.photo.pop();
    const link=await ctx.telegram.getFileLink(file.file_id);

    const folder=path.join(__dirname,'assets','en','bd','match');
    fs.mkdirSync(folder,{ recursive:true });

    const res=await fetch(link.href);
    const buffer=await res.arrayBuffer();

    fs.writeFileSync(path.join(folder,Date.now()+".jpg"),Buffer.from(buffer));

    ctx.reply("✅ Uploaded");
});

// ================= RUN =================
bot.launch();
console.log("BOT RUNNING");
