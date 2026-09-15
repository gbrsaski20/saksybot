require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { createCanvas } = require('canvas');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

// Import Model Database MongoDB
const User = require('./models/User');
const Transaction = require('./models/Transaction');
const ServerConfig = require('./models/ServerConfig');

// 1. Koneksi Database MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sky_control';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Database MongoDB Atlas Terhubung!'))
    .catch(err => console.error('❌ Gagal Koneksi MongoDB:', err.message));

const userCaptchas = new Map();

// Helper Config Server
async function getServerConfig(guildId) {
    let serverCfg = await ServerConfig.findOne({ guildId });
    if (!serverCfg) {
        serverCfg = await ServerConfig.create({
            guildId,
            isPremium: false,
            premiumExpires: null,
            verificationSettings: { enabled: true, verificationChannelId: "", unverifiedRoleId: "", verifiedRoleId: "", ownerRoleId: "", modRoleId: "" },
            autoBanSettings: { enabled: true, maxEmojiCount: 5, forbiddenWords: ["spam", "toxic", "promosi"] }
        });
    }
    return serverCfg;
}

async function isServerPremium(guildId) {
    const serverCfg = await getServerConfig(guildId);
    if (!serverCfg.isPremium) return false;
    if (serverCfg.premiumExpires && new Date(serverCfg.premiumExpires) < new Date()) {
        serverCfg.isPremium = false;
        await serverCfg.save();
        return false;
    }
    return true;
}

// 2. Setup Express, Session Engine & Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'sky_control_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Jam
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// 3. Setup Passport Discord OAuth2
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID || "1549017910553612378",
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || "http://localhost:3000/api/auth/discord/callback",
    scope: ['identify', 'guilds', 'email']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

app.use(passport.initialize());
app.use(passport.session());

// Middleware Proteksi Akses Web
function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login.html');
}

async function requireOwner(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Silakan login terlebih dahulu!' });
    const user = await User.findOne({ username: req.user.username });
    if (user && user.role === 'owner') return next();
    res.status(403).json({ message: 'Akses Ditolak! Khusus role Owner.' });
}

// ==========================================================================
// 4. ROUTE API & DISCORD OAUTH2 (HARUS DI ATAS EXPRESS.STATIC)
// ==========================================================================

// Login via Discord Initiator
app.get('/api/auth/discord', passport.authenticate('discord'));

// Discord OAuth2 Callback
app.get('/api/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/login.html'
}), async (req, res) => {
    try {
        let user = await User.findOne({ username: req.user.username });
        if (!user) {
            const totalUsers = await User.countDocuments();
            const role = totalUsers === 0 ? 'owner' : 'user';
            user = await User.create({
                username: req.user.username,
                email: req.user.email || `${req.user.id}@discord.com`,
                password: 'OAUTH_DISCORD_USER',
                role
            });
        }
        res.redirect('/dashboard.html');
    } catch (err) {
        console.error('Error callback Discord Auth:', err);
        res.redirect('/login.html');
    }
});

// Logout Route
app.get('/api/logout', (req, res) => {
    req.logout(() => {
        req.session.destroy();
        res.redirect('/login.html');
    });
});

// Submit Pembayaran QRIS Manual User
app.post('/api/payment/confirm', requireAuth, async (req, res) => {
    try {
        const { guildId, userEmail, refNumber, amount } = req.body;
        if (!guildId || !userEmail || !refNumber) {
            return res.status(400).json({ message: 'Semua field wajib diisi!' });
        }

        const orderId = 'ORD-' + Date.now();
        await Transaction.create({
            orderId,
            guildId,
            userEmail,
            amount: amount || 25000,
            plan: 'PREMIUM_30_DAYS',
            status: 'PENDING',
            paymentMethod: `QRIS Manual (${refNumber})`
        });

        pushLog(guildId, `💳 Transaksi Baru PENDING: ${orderId} (${userEmail})`, 'info');
        res.json({ success: true, orderId, message: 'Konfirmasi pembayaran berhasil dikirim!' });
    } catch (err) {
        res.status(500).json({ message: 'Gagal menyimpan transaksi!' });
    }
});

// Owner API: Ambil Semua Transaksi
app.get('/api/owner/transactions', requireOwner, async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ createdAt: -1 });
        res.json(transactions);
    } catch (err) {
        res.status(500).json({ message: 'Gagal mengambil data transaksi.' });
    }
});

// Owner API: Approve Pembayaran & Upgrade Server
app.post('/api/owner/approve', requireOwner, async (req, res) => {
    try {
        const { orderId, guildId } = req.body;
        await Transaction.findOneAndUpdate({ orderId }, { status: 'SUCCESS' });

        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + 30); // 30 Hari Premium

        await ServerConfig.findOneAndUpdate(
            { guildId },
            { isPremium: true, premiumExpires: expireDate },
            { upsert: true }
        );

        pushLog(guildId, `🎉 Transaksi ${orderId} APPROVED oleh Owner! Server aktif PREMIUM 30 Hari.`, 'info');
        emitServerData(guildId);
        res.json({ success: true, message: 'Server berhasil di-upgrade ke PREMIUM!' });
    } catch (err) {
        res.status(500).json({ message: 'Gagal me-approve transaksi!' });
    }
});

// Protected File Routes
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/owner.html', requireOwner, (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner.html')));

// ==========================================================================
// 5. STATIC FILES (PILIHAN FILE FISIK DARI FOLDER PUBLIC)
// ==========================================================================
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================================
// 6. DISCORD BOT ENGINE & REALTIME SOCKET.IO
// ==========================================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildBans
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember]
});

function pushLog(guildId, message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    io.emit('newLog', { guildId, message, type });
}

// Broadcast daftar server yang terisolasi (HANYA server tempat user login menjadi Admin)
function broadcastServerList(socket) {
    const req = socket.request;
    const sessionUser = req.session.passport ? req.session.passport.user : null;
    if (!sessionUser || !sessionUser.guilds) return;

    // Filter: User memegang hak Administrator (0x8) ATAU Manage Guild (0x20) DAN Bot ada di server tsb
    const userAdminGuilds = sessionUser.guilds.filter(g => (g.permissions & 0x8) === 0x8 || (g.permissions & 0x20) === 0x20);

    const allowedGuilds = client.guilds.cache
        .filter(g => userAdminGuilds.some(ug => ug.id === g.id))
        .map(g => ({
            id: g.id,
            name: g.name,
            icon: g.iconURL({ size: 64 }) || null,
            memberCount: g.memberCount
        }));

    socket.emit('guildsList', allowedGuilds);
}

async function emitServerData(guildId, socket = io) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const serverCfg = await getServerConfig(guildId);
    const isPremium = await isServerPremium(guildId);

    try {
        const totalMembers = guild.memberCount;
        const onlineCount = guild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size;

        socket.emit('serverDataUpdate', {
            guildId: guild.id,
            serverName: guild.name,
            onlineCount,
            totalMembers,
            config: serverCfg,
            isPremium,
            online: client.isReady()
        });
    } catch (err) {
        console.error(`Error emitting server data: ${err.message}`);
    }
}

async function fetchAndEmitMembers(guildId, socket = io) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return socket.emit('membersList', []);

    try {
        const members = await guild.members.fetch({ time: 10000 }).catch(() => guild.members.cache);
        const memberArray = members.map(m => ({
            id: m.id,
            username: m.user ? m.user.tag : 'Unknown User',
            joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
            status: (m.presence && m.presence.status !== 'offline') ? 'online' : 'offline'
        }));
        socket.emit('membersList', memberArray);
    } catch (err) {
        socket.emit('membersList', []);
    }
}

async function fetchAndEmitBans(guildId, socket = io) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return socket.emit('bansList', []);

    try {
        const bans = await guild.bans.fetch();
        const banArray = bans.map(b => ({
            id: b.user.id,
            username: b.user.tag,
            reason: b.reason || 'Tidak ada alasan'
        }));
        socket.emit('bansList', banArray);
    } catch (err) {
        socket.emit('bansList', []);
    }
}

function generateCaptcha() {
    const canvas = createCanvas(250, 80);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let captchaCode = '';
    for (let i = 0; i < 6; i++) {
        captchaCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    for (let i = 0; i < 6; i++) {
        ctx.strokeStyle = '#1e293b';
        ctx.beginPath();
        ctx.moveTo(Math.random() * canvas.width, Math.random() * canvas.height);
        ctx.lineTo(Math.random() * canvas.width, Math.random() * canvas.height);
        ctx.stroke();
    }

    ctx.font = 'bold 36px sans-serif';
    ctx.fillStyle = '#2dd4e8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(captchaCode, canvas.width / 2, canvas.height / 2);

    return { buffer: canvas.toBuffer(), code: captchaCode };
}

client.once('clientReady', () => {
    console.log(`🤖 SKY CONTROL online sebagai ${client.user.tag}`);
});

client.on('guildMemberAdd', async (member) => {
    const serverCfg = await getServerConfig(member.guild.id);
    const { enabled, unverifiedRoleId, verificationChannelId } = serverCfg.verificationSettings;

    emitServerData(member.guild.id);
    fetchAndEmitMembers(member.guild.id);

    if (!enabled) return;

    try {
        if (unverifiedRoleId) await member.roles.add(unverifiedRoleId).catch(() => null);

        const channel = member.guild.channels.cache.get(verificationChannelId);
        if (channel) {
            const { buffer, code } = generateCaptcha();
            const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });

            const sentMsg = await channel.send({
                content: `Selamat datang <@${member.id}>!\nKetik kode captcha di bawah ini:`,
                files: [attachment]
            }).catch(() => null);

            if (sentMsg) {
                userCaptchas.set(`${member.guild.id}_${member.id}`, { code, botMsgId: sentMsg.id });
            }
            pushLog(member.guild.id, `Captcha dikirim untuk: ${member.user.tag}`, 'info');
        }
    } catch (err) {
        pushLog(member.guild.id, `Gagal captcha: ${err.message}`, 'warn');
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const serverCfg = await getServerConfig(guildId);
    const isPremium = await isServerPremium(guildId);
    const { ownerRoleId, modRoleId } = serverCfg.verificationSettings;

    const isOwnerOrMod = message.member && message.member.roles.cache.some(r => 
        (ownerRoleId && r.id === ownerRoleId) || (modRoleId && r.id === modRoleId)
    );
    if (isOwnerOrMod) return;

    const { enabled: verifEnabled, unverifiedRoleId, verifiedRoleId, verificationChannelId } = serverCfg.verificationSettings;
    const { enabled: autoBanEnabled, maxEmojiCount, forbiddenWords } = serverCfg.autoBanSettings;

    if (verifEnabled && message.channel.id === verificationChannelId) {
        const captchaKey = `${guildId}_${message.author.id}`;
        const captchaData = userCaptchas.get(captchaKey);

        if (captchaData) {
            const inputCode = message.content.trim().toUpperCase();
            setTimeout(() => { if (message.deletable) message.delete().catch(() => null); }, 500);

            if (inputCode === captchaData.code) {
                if (unverifiedRoleId) await message.member.roles.remove(unverifiedRoleId).catch(() => null);
                if (verifiedRoleId) await message.member.roles.add(verifiedRoleId).catch(() => null);
                if (captchaData.botMsgId) {
                    const botMsg = await message.channel.messages.fetch(captchaData.botMsgId).catch(() => null);
                    if (botMsg && botMsg.deletable) await botMsg.delete().catch(() => null);
                }
                userCaptchas.delete(captchaKey);
                await message.channel.send(`✅ Verifikasi berhasil <@${message.author.id}>!`)
                    .then(m => setTimeout(() => m.delete().catch(() => null), 4000)).catch(() => null);
                pushLog(guildId, `Verifikasi BERHASIL: ${message.author.tag}`, 'info');
            } else {
                await message.channel.send(`❌ Kode Captcha salah!`)
                    .then(m => setTimeout(() => m.delete().catch(() => null), 4000)).catch(() => null);
            }
            return;
        } else {
            setTimeout(() => { if (message.deletable) message.delete().catch(() => null); }, 500);
            return;
        }
    }

    if (autoBanEnabled) {
        const regexEmoji = /<a?:[a-zA-Z0-9_]+:[0-9]+>|(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
        const emojiMatch = message.content.match(regexEmoji) || [];
        const activeForbiddenWords = isPremium ? forbiddenWords : forbiddenWords.slice(0, 3);
        const hasForbiddenWord = activeForbiddenWords.some(word => word.length > 0 && message.content.toLowerCase().includes(word.toLowerCase()));

        if (emojiMatch.length > maxEmojiCount) {
            pushLog(guildId, `Auto Ban: ${message.author.tag} spam emoji.`, 'warn');
            await triggerBan(message.guild, message.author.id, `Spam Emoji`, message);
        } else if (hasForbiddenWord) {
            pushLog(guildId, `Auto Ban: ${message.author.tag} kata terlarang.`, 'warn');
            await triggerBan(message.guild, message.author.id, `Kata terlarang`, message);
        }
    }
});

async function triggerBan(guild, userId, reason, messageObj = null) {
    try {
        if (messageObj && messageObj.deletable) await messageObj.delete().catch(() => null);
        await guild.members.ban(userId, { reason });
        pushLog(guild.id, `AUTO BAN ID ${userId}: ${reason}`, 'ban');
        fetchAndEmitMembers(guild.id);
        fetchAndEmitBans(guild.id);
    } catch (err) {
        pushLog(guild.id, `Gagal Auto Ban: ${err.message}`, 'warn');
    }
}

// Socket.io Realtime Sync Handlers
io.on('connection', (socket) => {
    broadcastServerList(socket);

    socket.on('selectServer', async (guildId) => {
        await emitServerData(guildId, socket);
        await fetchAndEmitMembers(guildId, socket);
        await fetchAndEmitBans(guildId, socket);
    });

    socket.on('getMembers', (guildId) => fetchAndEmitMembers(guildId, socket));
    socket.on('getBans', (guildId) => fetchAndEmitBans(guildId, socket));

    socket.on('updateConfig', async ({ guildId, autoBanSettings, verificationSettings }) => {
        if (!guildId) return;
        await ServerConfig.findOneAndUpdate({ guildId }, { autoBanSettings, verificationSettings }, { upsert: true });
        pushLog(guildId, 'Pengaturan server diperbarui via Dashboard.', 'info');
        emitServerData(guildId, socket);
    });

    socket.on('modAction', async ({ guildId, action, userId, reason }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        try {
            const member = await guild.members.fetch(userId).catch(() => null);
            switch (action) {
                case 'warn': if (member) await member.send(`⚠️ Peringatan: ${reason}`).catch(() => null); break;
                case 'kick': if (member) await member.kick(reason); fetchAndEmitMembers(guildId); break;
                case 'ban': await guild.members.ban(userId, { reason }); fetchAndEmitMembers(guildId); fetchAndEmitBans(guildId); break;
                case 'unban': await guild.members.unban(userId, reason); fetchAndEmitBans(guildId); break;
                case 'timeout': if (member) await member.timeout(5 * 60 * 1000, reason); break;
            }
        } catch (err) {
            pushLog(guildId, `Gagal aksi mod: ${err.message}`, 'warn');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` SKY CONTROL Server: http://localhost:${PORT}`);
    console.log(`=================================================`);
});

client.login(process.env.DISCORD_TOKEN);