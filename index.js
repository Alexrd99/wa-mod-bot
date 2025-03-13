const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qr = require('qrcode-terminal');
const schedule = require('node-schedule');
const fs = require('fs');
require('dotenv').config();

const LOCATION_FILE = 'locations.json';
const ANNOUNCEMENT_GROUP = process.env.GROUP_ID;
const PRAYER_NOTIFICATIONS = (process.env.PRAYER_NOTIFICATIONS || 'Imsak,Maghrib,Fajr,Dhuhr,Asr,Isha')
    .split(',').map(p => p.trim());
const PRAYER_TIME_OFFSETS = { Fajr: -18, Dhuhr: 3, Asr: 0, Maghrib: 2, Isha: 14, Imsak: -18 };
const DEFAULT_LOCATION = { city: 'Jakarta', country: 'Indonesia' };

let globalSock = null;
let scheduledJobs = {};
let prayerCache = {};

// Baca file lokasi
function loadLocations() {
    return fs.existsSync(LOCATION_FILE) ? JSON.parse(fs.readFileSync(LOCATION_FILE)) : {};
}

// Simpan lokasi pengguna
function saveLocation(user, city, country) {
    if (!user) {
        console.error('❌ Gagal menyimpan lokasi: User tidak valid');
        return;
    }

    const locations = loadLocations();
    locations[user] = { city, country };

    fs.writeFileSync(LOCATION_FILE, JSON.stringify(locations, null, 2));
    console.log(`✅ Lokasi disimpan untuk ${user}: ${city}, ${country}`);

    schedulePrayerReminders();
}

// Ambil jadwal sholat
async function getPrayerTimes(city, country) {
    const cacheKey = `${city},${country}`;
    if (prayerCache[cacheKey]) return prayerCache[cacheKey];

    try {
        const response = await axios.get(`https://api.aladhan.com/v1/timingsByCity?city=${city}&country=${country}&method=2`);
        let timings = response.data?.data?.timings;
        if (!timings) return null;

        // Sesuaikan offset waktu sholat
        Object.keys(timings).forEach(prayer => {
            let [hour, minute] = timings[prayer].split(':').map(Number);
            minute += PRAYER_TIME_OFFSETS[prayer] || 0;
            if (minute < 0) { hour--; minute += 60; }
            if (hour < 0) hour += 24;
            timings[prayer] = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        });

        prayerCache[cacheKey] = timings;
        return timings;
    } catch (error) {
        console.error('❌ Gagal mengambil jadwal sholat:', error.message);
        return null;
    }
}

// Menjadwalkan pengingat sholat
async function schedulePrayerReminders() {
    if (!globalSock) return;

    const locations = loadLocations();
    for (const user of Object.keys(locations)) {
        if (!user) continue;

        const { city, country } = locations[user] || DEFAULT_LOCATION;
        console.log(`⏳ Menjadwalkan pengingat untuk ${user} di ${city}`);

        // Hapus jadwal lama jika ada
        if (scheduledJobs[user]) Object.values(scheduledJobs[user]).forEach(job => job.cancel());
        scheduledJobs[user] = {};

        const prayerTimes = await getPrayerTimes(city, country);
        if (!prayerTimes) continue;

        Object.entries(prayerTimes).forEach(([prayer, time]) => {
            if (!PRAYER_NOTIFICATIONS.includes(prayer)) return;
            let [hour, minute] = time.split(":").map(Number);

            scheduledJobs[user][prayer] = schedule.scheduleJob({ hour, minute }, () => {
                globalSock.sendMessage(user, `🕌 *${prayer}* - ${time} di ${city}\n Jangan Lupa Sholat ${prayer}`);
            });
            // Jika waktu Imsak, tambahkan pengingat sahur 30 menit sebelumnya
            if (prayer === "Imsak") {
                let sahurHour = hour;
                let sahurMinute = minute - 30;
                if (sahurMinute < 0) {
                    sahurMinute += 60;
                    sahurHour -= 1;
                }
                let sahurTime = `${sahurHour.toString().padStart(2, '0')}:${sahurMinute.toString().padStart(2, '0')}`;
                scheduledJobs[user]["Sahur"] = schedule.scheduleJob({ hour: sahurHour, minute: sahurMinute }, () => {
                    globalSock.sendMessage(ANNOUNCEMENT_GROUP, `🍽️ Pengingat Sahur! Waktu sahur di ${city} akan berakhir dalam 30 menit. Segera selesaikan makan Anda!`);
                });
            }
            // Pengingat 5 menit sebelum berbuka
            if (prayer === "Maghrib") {
                let bukaHour = hour;
                let bukaMinute = minute - 5;
                if (bukaMinute < 0) {
                    bukaMinute += 60;
                    bukaHour -= 1;
                }
                let bukaTime = `${bukaHour.toString().padStart(2, '0')}:${bukaMinute.toString().padStart(2, '0')}`;
                scheduledJobs[user]["Berbuka"] = schedule.scheduleJob({ hour: bukaHour, minute: bukaMinute }, () => {
                    globalSock.sendMessage(ANNOUNCEMENT_GROUP, `🍛🍴 Pengingat Berbuka! Waktu berbuka di ${city} akan tiba dalam 5 menit. Siapkan makanan dan minuman Anda!`);
                });
            }
            // Pengingat berbuka puasa
            if (prayer === "Maghrib") {
                scheduledJobs[user]["SelamatBerbuka"] = schedule.scheduleJob({ hour, minute }, () => {
                    globalSock.sendMessage(ANNOUNCEMENT_GROUP, `🌙 Selamat Berbuka Puasa! untuk di ${city}, Semoga berkah dan penuh rahmat. 🍽️`);
                });
            }
        });
    }
}

// Menangani pesan masuk
async function handleIncomingMessage(message) {
    if (!message || !message.messages || !message.messages.length) return;

    for (const msg of message.messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) {
            console.error('❌ Tidak ada remoteJid');
            return;
        }

        let text = '';
        if (msg.message?.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message?.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        }

        if (!text) {
            console.log('⚠️ Tidak ada teks dalam pesan');
            return;
        }

        if (text.startsWith('!setlokasi ')) {
            const parts = text.replace('!setlokasi ', '').split(',');
            if (parts.length === 2) {
                const city = parts[0].trim();
                const country = parts[1].trim();
                saveLocation(remoteJid, city, country);
                await globalSock.sendMessage(remoteJid, `📍 Lokasi diatur ke ${city}, ${country}. Jadwal sholat akan diperbarui.`);
            } else {
                await globalSock.sendMessage(remoteJid, '❌ Format salah. Gunakan: !setlokasi Kota, Negara');
            }
        } else if (text === '!jadwalsholat') {
            const locations = loadLocations();
            const { city, country } = locations[remoteJid] || DEFAULT_LOCATION;
            const prayerTimes = await getPrayerTimes(city, country);
            if (prayerTimes) {
                let response = `🕌 Jadwal Sholat di ${city}, ${country}:\n`;
                Object.entries(prayerTimes).forEach(([prayer, time]) => {
                    response += `- *${prayer}*: ${time}\n`;
                });
                await globalSock.sendMessage(remoteJid, response);
            } else {
                await globalSock.sendMessage(remoteJid, '❌ Gagal mengambil jadwal sholat. Coba lagi nanti.');
            }
        }
    }
}

// Jalankan bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state });
    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleIncomingMessage);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr: qrCode } = update;
        if (qrCode) {
            qr.generate(qrCode, { small: true });
            console.log('📌 Scan QR Code untuk menghubungkan bot.');
        }
        if (connection === 'open') {
            console.log('✅ Bot terhubung!');
            schedulePrayerReminders();
        } else if (connection === 'close') {
            console.log('❌ Koneksi terputus, mencoba menyambung kembali...');
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            } else {
                console.log('⚠️ Bot keluar, perlu autentikasi ulang!');
            }
        }
    });
}

startBot();
