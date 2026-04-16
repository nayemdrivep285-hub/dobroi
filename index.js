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
        ctx.reply("⏳ Generating... Please wait");
        return generate(ctx, s.data);
    }
});

// ========= GENERATE =========
async function generate(ctx, data){
    try{
        // Build path based on selections
        const lang = data.language || 'en';
        const country = data.country || 'bd';
        const type = data.type || 'match';
        
        const dir = path.join(__dirname, 'assets', lang, country, type);
        
        // Check if directory exists
        if(!fs.existsSync(dir)){
            console.log(`Directory not found: ${dir}`);
            return ctx.reply("❌ No templates found for your selection");
        }

        const files = fs.readdirSync(dir).filter(f=>f.endsWith('.jpg')||f.endsWith('.png'));
        if(!files.length){
            console.log(`No image files in: ${dir}`);
            return ctx.reply("❌ No templates available");
        }

        const outputs = [];
        const maxFiles = Math.min(files.length, 5);

        for(let i = 0; i < maxFiles; i++){
            const file = files[i];
            const input = path.join(dir, file);
            const output = path.join('/tmp', `${Date.now()}_${i}_${file}`);
            
            try{
                await addText(input, output, data.promo);
                outputs.push({ source: output, type: 'photo' });
            }catch(err){
                console.error(`Error processing ${file}:`, err);
            }
        }

        if(outputs.length === 0){
            return ctx.reply("❌ Failed to generate images");
        }

        // Send as media group
        await ctx.replyWithMediaGroup(outputs);
        
        // Send promo code separately
        await ctx.reply(`🎉 **Your Promo Code:** \`${data.promo}\``, {
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
            }catch(e){}
        }
        
        // Clean up temp files
        setTimeout(() => {
            outputs.forEach(o => {
                try{
                    if(fs.existsSync(o.source)) fs.unlinkSync(o.source);
                }catch(e){}
            });
        }, 60000);

        // Reset session
        delete sessions[ctx.from.id];

    }catch(e){
        console.error('Generate error:', e);
        ctx.reply("❌ Error generating images. Please try again.");
    }
}

// ========= SMART TEXT ENGINE (FIXED) =========
async function addText(input, output, promo) {
    const img = sharp(input);
    const { width, height } = await img.metadata();
    
    // Resize to smaller for analysis
    const analyzeWidth = 400;
    const analyzeHeight = Math.floor((analyzeWidth / width) * height);
    
    const raw = await img.clone()
        .resize(analyzeWidth, analyzeHeight)
        .grayscale()
        .raw()
        .toBuffer();
    
    const cols = analyzeWidth;
    const rows = analyzeHeight;
    
    // Find region with most consistent brightness (promo box area)
    let bestRowStart = 0;
    let bestRowEnd = 0;
    let bestVariance = Infinity;
    let bestMean = 0;
    
    // Look for uniform area (promo box)
    for (let startY = 0; startY < rows - 40; startY++) {
        for (let endY = startY + 30; endY < Math.min(startY + 100, rows); endY++) {
            let sum = 0;
            let sumSq = 0;
            let pixelCount = 0;
            
            for (let y = startY; y <= endY; y++) {
                for (let x = 30; x < cols - 30; x++) {
                    const val = raw[y * cols + x];
                    sum += val;
                    sumSq += val * val;
                    pixelCount++;
                }
            }
            
            if(pixelCount === 0) continue;
            
            const mean = sum / pixelCount;
            const variance = (sumSq / pixelCount) - (mean * mean);
            
            // Lower variance = more uniform area
            if (variance < bestVariance && mean > 40 && mean < 220) {
                bestVariance = variance;
                bestRowStart = startY;
                bestRowEnd = endY;
                bestMean = mean;
            }
        }
    }
    
    // Calculate Y position (center of uniform area)
    let yPos;
    if (bestVariance !== Infinity) {
        const centerRow = (bestRowStart + bestRowEnd) / 2;
        yPos = (centerRow / rows) * height;
    } else {
        // Fallback - look for brightest area (text is often light on dark background)
        let brightestY = height * 0.7;
        let maxBrightness = 0;
        
        for (let y = 0; y < rows; y++) {
            let rowSum = 0;
            for (let x = 30; x < cols - 30; x++) {
                rowSum += raw[y * cols + x];
            }
            const avgBrightness = rowSum / (cols - 60);
            if (avgBrightness > maxBrightness) {
                maxBrightness = avgBrightness;
                brightestY = (y / rows) * height;
            }
        }
        yPos = brightestY;
    }
    
    // Dynamic font size
    const promoLength = promo.length;
    let fontSize = Math.min(width * 0.1, 130);
    
    if (promoLength > 12) {
        fontSize = fontSize * (0.7 - (promoLength - 12) * 0.015);
    } else if (promoLength > 8) {
        fontSize = fontSize * 0.85;
    }
    fontSize = Math.max(40, Math.min(fontSize, 130));
    
    const pillWidth = Math.min(width * 0.85, fontSize * promoLength * 0.7);
    const pillX = (width - pillWidth) / 2;
    const pillHeight = fontSize * 1.3;
    const pillY = yPos - (pillHeight / 1.8);
    
    // Create SVG with bold text
    const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="3" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.9"/>
            </filter>
            <linearGradient id="pillGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" style="stop-color:#000000;stop-opacity:0.75" />
                <stop offset="100%" style="stop-color:#000000;stop-opacity:0.85" />
            </linearGradient>
        </defs>
        
        <!-- Dark pill background -->
        <rect 
            x="${pillX}" 
            y="${pillY}" 
            width="${pillWidth}" 
            height="${pillHeight}"
            rx="${pillHeight / 2}"
            ry="${pillHeight / 2}"
            fill="url(#pillGrad)"
            stroke="rgba(255,215,0,0.3)"
            stroke-width="2"
        />
        
        <!-- Main bold text -->
        <text 
            x="50%" 
            y="${yPos + fontSize * 0.35}" 
            text-anchor="middle"
            font-family="'Arial Black', Arial, Helvetica, sans-serif" 
            font-weight="900"
            font-size="${fontSize}"
            fill="#FFD700"
            letter-spacing="${Math.max(3, fontSize * 0.06)}"
            filter="url(#shadow)"
        >${escapeXml(promo)}</text>
        
        <!-- White outline effect -->
        <text 
            x="50%" 
            y="${yPos + fontSize * 0.35}" 
            text-anchor="middle"
            font-family="'Arial Black', Arial, Helvetica, sans-serif" 
            font-weight="900"
            font-size="${fontSize}"
            fill="none"
            stroke="#FFFFFF"
            stroke-width="2"
            letter-spacing="${Math.max(3, fontSize * 0.06)}"
        >${escapeXml(promo)}</text>
    </svg>
    `;
    
    await img
        .composite([{ input: Buffer.from(svg) }])
        .jpeg({ quality: 92 })
        .toFile(output);
}

function escapeXml(str) {
    return str.replace(/[<>&'"]/g, function(c) {
        switch(c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case "'": return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

// ========= COPY BUTTON HANDLER =========
bot.action(/copy_(.+)/, async ctx => {
    const promoCode = ctx.match[1];
    try {
        await ctx.answerCbQuery(`✅ Copied: ${promoCode}`, { show_alert: true });
        await ctx.reply(`📋 Promo code copied: \`${promoCode}\``, { parse_mode: 'Markdown' });
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
        
        // You can modify these paths based on your needs
        const folder = path.join(__dirname, 'assets', 'en', 'bd', 'match');
        fs.mkdirSync(folder, { recursive: true });
        
        const res = await fetch(link.href);
        const buffer = await res.buffer();
        
        const filename = `${Date.now()}.jpg`;
        fs.writeFileSync(path.join(folder, filename), buffer);
        
        ctx.reply(`✅ Template uploaded successfully!\n📁 Location: ${filename}`);
        s.step = 'admin';
    }catch(e){
        console.error('Upload error:', e);
        ctx.reply("❌ Failed to upload image");
        s.step = 'admin';
    }
});

// ========= FALLBACK FOR UNKNOWN MESSAGES =========
bot.on('message', async ctx => {
    const s = getSession(ctx.from.id);
    
    // If in promo step but got non-text
    if(s && s.step === 'promo' && !ctx.message.text){
        return ctx.reply("❌ Please send a valid text promo code");
    }
});

// ========= RUN =========
bot.launch().then(() => {
    console.log("🚀 Bot Running Successfully");
}).catch(err => {
    console.error("Failed to launch bot:", err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
