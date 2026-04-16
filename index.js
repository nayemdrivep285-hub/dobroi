require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ========= CONFIG =========
const ADMIN_IDS = [123456789]; // Replace with your admin ID

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
    if(!sessions[id]) sessions[id]={ step:'phone', data: {} };
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
    
    if(!s) return;

    // BROADCAST
    if(s.step === 'broadcast'){
        const users = await User.find({});
        let successCount = 0;
        for(const u of users){
            try{
                await bot.telegram.sendMessage(u.userId, ctx.message.text);
                successCount++;
            }catch(e){
                console.log(`Failed to send to ${u.userId}:`, e.message);
            }
        }
        s.step = 'admin';
        return ctx.reply(`✅ Broadcast done! Sent to ${successCount} users`);
    }

    // PROMO
    if(s.step === 'promo'){
        if(!ctx.message.text || ctx.message.text.trim() === ''){
            return ctx.reply("❌ Please enter a valid promo code");
        }
        s.data.promo = ctx.message.text.trim().toUpperCase();
        
        // Send processing message
        const processingMsg = await ctx.reply("⏳ Generating images... Please wait (this may take 10-15 seconds)");
        
        try {
            await generate(ctx, s.data);
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
        } catch(error) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            ctx.reply(`❌ Error: ${error.message}`);
        }
    }
});

// ========= GENERATE =========
async function generate(ctx, data){
    try{
        // Build path based on selections
        const lang = data.language || 'en';
        const country = data.country || 'bd';
        const type = data.type || 'match';
        
        // Try multiple possible directory paths
        let dir = path.join(__dirname, 'assets', lang, country, type);
        
        // Check if directory exists
        if(!fs.existsSync(dir)){
            console.log(`Directory not found: ${dir}`);
            
            // Try fallback paths
            const fallbackPaths = [
                path.join(__dirname, 'assets', 'en', 'bd', 'match'),
                path.join(__dirname, 'templates'),
                path.join(__dirname, 'images'),
                process.cwd()
            ];
            
            for(const fallback of fallbackPaths){
                if(fs.existsSync(fallback) && fs.readdirSync(fallback).some(f => f.endsWith('.jpg') || f.endsWith('.png'))){
                    dir = fallback;
                    console.log(`Using fallback directory: ${dir}`);
                    break;
                }
            }
            
            if(!fs.existsSync(dir)){
                // Create a default directory with a sample instruction
                fs.mkdirSync(path.join(__dirname, 'assets', 'en', 'bd', 'match'), { recursive: true });
                return ctx.reply(`❌ No templates found in: ${dir}\n\nPlease upload templates using admin panel first.`);
            }
        }

        const files = fs.readdirSync(dir).filter(f=>f.endsWith('.jpg')||f.endsWith('.png')||f.endsWith('.jpeg'));
        
        if(!files.length){
            return ctx.reply(`❌ No image files found in: ${dir}\n\nPlease upload at least one image template.`);
        }

        const outputs = [];
        const maxFiles = Math.min(files.length, 3); // Reduced to 3 for faster response

        await ctx.reply(`📸 Found ${files.length} templates, generating ${maxFiles} images...`);

        for(let i = 0; i < maxFiles; i++){
            const file = files[i];
            const input = path.join(dir, file);
            const output = path.join('/tmp', `${Date.now()}_${i}_${path.basename(file)}`);
            
            try{
                console.log(`Processing: ${input}`);
                await addText(input, output, data.promo);
                if(fs.existsSync(output) && fs.statSync(output).size > 0){
                    outputs.push({ source: output, type: 'photo' });
                    console.log(`Success: ${output}`);
                } else {
                    console.log(`Failed: Output file invalid for ${file}`);
                }
            } catch(err){
                console.error(`Error processing ${file}:`, err.message);
            }
        }

        if(outputs.length === 0){
            throw new Error("Failed to generate any images. Check if images are valid and sharp is installed correctly.");
        }

        // Send images one by one (more reliable than media group)
        for(const output of outputs){
            try{
                await ctx.replyWithPhoto({ source: output.source });
            } catch(err){
                console.error(`Failed to send image:`, err.message);
            }
        }
        
        // Send promo code separately with styling
        await ctx.reply(`🎉 **Promo Code Generated Successfully!**\n\n📋 **Code:** \`${data.promo}\`\n\n✅ Copy and use this code!`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback("📋 Copy Code", `copy_${data.promo}`)]
            ])
        });

        // ADMIN LOG
        for(const adminId of ADMIN_IDS){
            try{
                await bot.telegram.sendMessage(adminId,
                    `🎨 **New Promo Generated**\n👤 User: ${ctx.from.id}\n🏷️ Code: ${data.promo}\n🌐 Lang: ${data.language}\n🇨🇾 Country: ${data.country}\n📦 Type: ${data.type}`,
                    { parse_mode: 'Markdown' }
                );
            } catch(e){}
        }
        
        // Clean up temp files
        setTimeout(() => {
            outputs.forEach(o => {
                try{
                    if(fs.existsSync(o.source)) fs.unlinkSync(o.source);
                } catch(e){}
            });
        }, 30000);

        // Reset session
        delete sessions[ctx.from.id];

    } catch(e){
        console.error('Generate error:', e);
        throw new Error(e.message);
    }
}

// ========= SMART TEXT ENGINE (SIMPLIFIED & FIXED) =========
async function addText(input, output, promo) {
    try {
        const img = sharp(input);
        const metadata = await img.metadata();
        const { width, height } = metadata;
        
        console.log(`Image size: ${width}x${height}`);
        
        // Calculate text position (center, at 70% from top)
        const yPos = height * 0.7;
        
        // Dynamic font size based on image width
        let fontSize = Math.floor(width * 0.08);
        fontSize = Math.max(40, Math.min(fontSize, 100));
        
        // Adjust for long promo codes
        const promoLength = promo.length;
        if (promoLength > 10) {
            fontSize = Math.floor(fontSize * (0.8 - (promoLength - 10) * 0.02));
        }
        fontSize = Math.max(35, Math.min(fontSize, 100));
        
        // Calculate pill dimensions
        const approxTextWidth = promo.length * fontSize * 0.6;
        const pillWidth = Math.min(width - 40, approxTextWidth + 80);
        const pillX = (width - pillWidth) / 2;
        const pillHeight = fontSize + 30;
        const pillY = yPos - (pillHeight / 2);
        
        // Create SVG with text
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
                    <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="black" flood-opacity="0.8"/>
                </filter>
            </defs>
            
            <!-- Background pill -->
            <rect 
                x="${pillX}" 
                y="${pillY}" 
                width="${pillWidth}" 
                height="${pillHeight}"
                rx="${pillHeight / 2}"
                fill="black" 
                opacity="0.75"
            />
            
            <!-- Text shadow/outline -->
            <text 
                x="50%" 
                y="${yPos + 8}" 
                text-anchor="middle"
                font-family="Arial Black, Arial, sans-serif" 
                font-weight="bold"
                font-size="${fontSize}"
                fill="black"
                letter-spacing="3"
            >${escapeXml(promo)}</text>
            
            <!-- Main text -->
            <text 
                x="50%" 
                y="${yPos + 5}" 
                text-anchor="middle"
                font-family="Arial Black, Arial, sans-serif" 
                font-weight="bold"
                font-size="${fontSize}"
                fill="#FFD700"
                letter-spacing="3"
                filter="url(#shadow)"
            >${escapeXml(promo)}</text>
            
            <!-- Highlight -->
            <text 
                x="50%" 
                y="${yPos + 2}" 
                text-anchor="middle"
                font-family="Arial Black, Arial, sans-serif" 
                font-weight="bold"
                font-size="${fontSize}"
                fill="none"
                stroke="white"
                stroke-width="1.5"
                letter-spacing="3"
            >${escapeXml(promo)}</text>
        </svg>`;
        
        // Composite SVG onto image
        await img
            .composite([{ 
                input: Buffer.from(svg),
                blend: 'over'
            }])
            .jpeg({ quality: 90 })
            .toFile(output);
            
        console.log(`Successfully generated: ${output}`);
        
    } catch(e) {
        console.error('addText error:', e);
        throw e;
    }
}

function escapeXml(str) {
    if(!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ========= COPY BUTTON HANDLER =========
bot.action(/copy_(.+)/, async ctx => {
    const promoCode = ctx.match[1];
    try {
        await ctx.answerCbQuery(`✅ Copied: ${promoCode}`);
        await ctx.reply(`📋 Promo code \`${promoCode}\` copied to clipboard!`, { parse_mode: 'Markdown' });
    } catch(e) {
        console.error('Copy error:', e);
    }
});

// ========= UPLOAD TEMPLATE =========
bot.on('photo', async ctx=>{
    const s = getSession(ctx.from.id);
    if(!s || s.step !== 'upload') return;
    
    if(!ADMIN_IDS.includes(ctx.from.id)){
        delete sessions[ctx.from.id];
        return;
    }

    try{
        const file = ctx.message.photo.pop();
        const link = await ctx.telegram.getFileLink(file.file_id);
        
        // Create folder structure
        const folder = path.join(__dirname, 'assets', 'en', 'bd', 'match');
        fs.mkdirSync(folder, { recursive: true });
        
        const res = await fetch(link.href);
        const buffer = await res.buffer();
        
        const filename = `${Date.now()}.jpg`;
        const filepath = path.join(folder, filename);
        fs.writeFileSync(filepath, buffer);
        
        ctx.reply(`✅ Template uploaded successfully!\n📁 Location: assets/en/bd/match/${filename}\n🖼️ Size: ${(buffer.length / 1024).toFixed(2)} KB`);
        s.step = 'admin';
    } catch(e){
        console.error('Upload error:', e);
        ctx.reply(`❌ Failed to upload image: ${e.message}`);
        s.step = 'admin';
    }
});

// ========= CHECK SHARP INSTALLATION =========
async function checkSharp() {
    try {
        const testBuffer = await sharp(Buffer.from([0x00, 0x00, 0x00, 0x00]))
            .raw()
            .toBuffer();
        console.log("✅ Sharp is working correctly");
        return true;
    } catch(e) {
        console.error("❌ Sharp installation issue:", e);
        console.log("Please run: npm rebuild sharp");
        return false;
    }
}

// ========= RUN =========
async function startBot() {
    await checkSharp();
    
    bot.launch().then(() => {
        console.log("🚀 Bot Running Successfully");
        console.log(`📁 Assets path: ${path.join(__dirname, 'assets')}`);
    }).catch(err => {
        console.error("Failed to launch bot:", err);
    });
}

startBot();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
