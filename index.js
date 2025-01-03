import moment from 'moment-timezone';
import fetch from 'node-fetch';
import schedule from 'node-schedule';
import { config } from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url'
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
config();

// Validate required environment variables
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH) {
    console.error("Error: ADMIN_USERNAME and ADMIN_PASSWORD_HASH are required in .env file");
    process.exit(1);
}

// Hash function for password
function hashPassword(password) {
    return crypto.createHash('sha256')
        .update(password + process.env.SALT || '')
        .digest('hex');
}

// Load config and validate required fields
const appConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
if (!appConfig.GuidId) {
    console.error("Error: GuidId is required in config.json");
    process.exit(1);
}

const app = express();
const PORT = appConfig.PORT || process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session management
const sessions = new Map();

// Generate session token
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Authentication middleware
function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const session = sessions.get(token);
    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Default session timeout to 1 hour if not configured
    const sessionTimeout = appConfig.auth?.sessionTimeout || 3600000;

    // Check if session has expired
    if (Date.now() - session.timestamp > sessionTimeout) {
        sessions.delete(token);
        return res.status(401).json({ success: false, message: 'Session expired' });
    }

    // Update session timestamp
    session.timestamp = Date.now();
    next();
}

// Login endpoint
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = hashPassword(password);

    if (username === process.env.ADMIN_USERNAME && 
        hashedPassword === process.env.ADMIN_PASSWORD_HASH) {
        const token = generateSessionToken();
        sessions.set(token, { 
            username,
            timestamp: Date.now()
        });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// Logout endpoint
app.post('/api/auth/logout', requireAuth, (req, res) => {
    const token = req.headers['x-auth-token'];
    sessions.delete(token);
    res.json({ success: true });
});

// Check auth status endpoint
app.get('/api/auth/status', (req, res) => {
    const token = req.headers['x-auth-token'];
    const isAuthenticated = token && sessions.has(token);
    res.json({ authenticated: isAuthenticated });
});

// Clean up expired sessions periodically
setInterval(() => {
    const now = Date.now();
    const sessionTimeout = appConfig.auth?.sessionTimeout || 3600000;
    for (const [token, session] of sessions.entries()) {
        if (now - session.timestamp > sessionTimeout) {
            sessions.delete(token);
        }
    }
}, 60000); // Clean up every minute

// Store the latest prayer times in memory
let currentIqamahTimes = null;
let currentPrayerStartTimes = null;
let nextPrayer = null;

// Load config
const TEST_MODE = appConfig.testMode.enabled;
const TEST_START_TIME = moment.tz(appConfig.testMode.startTime, 'HH:mm:ss', appConfig.testMode.timezone);
let timeOffset = TEST_MODE ? moment().diff(TEST_START_TIME) : 0;

// Utility function for consistent logging
function logSection(title) {
    console.log('\n' + '='.repeat(40));
    console.log(`🕌 ${title.toUpperCase()} 🕌`);
    console.log('='.repeat(40));
}

// Utility function to log prayer times in a table
function logPrayerTimesTable(timings, title) {
    console.log(`\n${title}:`);
    console.table(
        Object.entries(timings)
            .filter(([name, time]) => name !== 'sunrise')
            .map(([name, time]) => ({
            'Prayer': name.charAt(0).toUpperCase() + name.slice(1),
            'Time': time
        }))
    );
}

// Add getCurrentTime utility function
function getCurrentTime() {
    if (TEST_MODE) {
        return moment.tz('Europe/London').subtract(timeOffset, 'milliseconds');
    }
    return moment.tz('Europe/London');
}

async function fetchMasjidTimings() {
    try {
        const response = await fetch(`https://time.my-masjid.com/api/TimingsInfoScreen/GetMasjidTimings?GuidId=${appConfig.GuidId}`);
        const data = await response.json();
        const salahTimings = data.model.salahTimings;

        const today = moment.tz('Europe/London');
        const todayDay = today.date();
        const todayMonth = today.month() + 1;

        const todayTimings = salahTimings.filter(obj => obj.day === todayDay && obj.month === todayMonth);

        if (todayTimings.length > 0) {
            return todayTimings[0];
        } else {
            console.error("❌ No timings found for today.");
            return null;
        }
    } catch (error) {
        console.error("❌ Error fetching data:", error);
        return null;
    }
}

async function scheduleNextDay() {
    logSection("Next Day Scheduling");
    const nextMidnight = moment.tz('Europe/London').add(1, 'day').startOf('day');
    console.log(`📅 Next Update: ${nextMidnight.format('HH:mm:ss DD-MM-YYYY')}`);
    
    schedule.scheduleJob(nextMidnight.toDate(), async() => {
        console.log("🔄 Fetching next day's namaz timings.");
        await scheduleNamazTimers();
    });
}

async function scheduleNamazTimers() {
    const timings = await fetchMasjidTimings();

    if (!timings) {
        console.error("❌ Could not fetch today's timings.");
        return;
    }

    const iqamahTimes = {
        fajr: timings.iqamah_Fajr,
        sunrise: timings.shouruq,
        zuhr: timings.iqamah_Zuhr,
        asr: timings.iqamah_Asr,
        maghrib: timings.maghrib,
        isha: timings.iqamah_Isha,
    };

    const prayerStartTimes = {
        fajr: timings.fajr,
        sunrise: timings.shouruq,
        zuhr: timings.zuhr,
        asr: timings.asr,
        maghrib: timings.maghrib,
        isha: timings.isha,
    };

    currentIqamahTimes = iqamahTimes;
    currentPrayerStartTimes = prayerStartTimes
    updateNextPrayer();

    const prayerAnnouncementTimes = Object.entries(iqamahTimes).reduce((acc, [prayerName, time]) => {
        const updatedTime = moment(time, 'HH:mm').subtract(15, 'minutes').format('HH:mm');
        acc[prayerName] = updatedTime; return acc; }, {});

    logSection("Today's Prayer Iqamah Timings");
    logPrayerTimesTable(iqamahTimes, "Iqamah Times");

    logSection("Today's Prayer Times");
    logPrayerTimesTable(prayerAnnouncementTimes, "Announcement Times");

    const now = getCurrentTime();
    console.log(`⏰ Current Date/Time: ${now.format('HH:mm:ss DD-MM-YYYY')}`);


    if (appConfig.features.azanEnabled) {
        logSection("Scheduling Prayer Iqamah Times");
        await Promise.all(Object.entries(iqamahTimes).map(([prayerName, time]) => 
            scheduleAzanTimer(prayerName, time)
        ));
    } else {
        console.log("⏸️ Azan timer is disabled");
    }

    if (appConfig.features.announcementEnabled) {
        logSection("Scheduling Prayer Announcement Times");
        await Promise.all(Object.entries(prayerAnnouncementTimes).map(([prayerName, time]) => 
            scheduleAzanAnnouncementTimer(prayerName, time)
        ));
    } else {
        console.log("⏸️ Announcement timer is disabled");
    }

    // Schedule next day's timings at midnight
    await scheduleNextDay();
}

async function scheduleAzanTimer(prayerName, time) {
    if(["sunrise"].includes(prayerName)) 
        return;

    const [hour, minute] = time.split(':').map(Number);
    const now = getCurrentTime();

    const prayerTime = moment.tz('Europe/London');
    prayerTime.set({ hour, minute, second: 0 });
    
    if (prayerTime > now) {
        console.log(`🕰️ Scheduling ${prayerName.toUpperCase()} prayer at ${time}`);
        schedule.scheduleJob(prayerTime.toDate(), async () => {
            playAzanAlexa(prayerName === 'fajr');
            console.log(`${prayerName} prayer time.`);
        });
    } else {
        console.log(`⏩ ${prayerName.toUpperCase()} prayer time has already passed.`);
    }
}

async function scheduleAzanAnnouncementTimer(prayerName, time) {

    if(["fajr", "sunrise"].includes(prayerName)) 
        return;

    const [hour, minute] = time.split(':').map(Number);
    const now = getCurrentTime();

    const prayerAnnouncementTime = moment.tz('Europe/London');
    prayerAnnouncementTime.set({ hour, minute, second: 0 });

    if(prayerAnnouncementTime < now) {
        console.log(`⏩ ${prayerName.toUpperCase()} prayer announcement time has already passed.`);
        return;
    }

    console.log(`📢 Scheduling ${prayerName.toUpperCase()} announcement at ${time}`);
    
    schedule.scheduleJob(prayerAnnouncementTime.toDate(), async () => {
        await playPrayerAnnoucement(prayerName);

        console.log(`📣 ${prayerName.toUpperCase()} announcement time.`);
    });
}

async function playAzanAlexa(isFajr = false) {
    if(TEST_MODE || !appConfig.features.azanEnabled) 
        return console.log(`Azan not played - ${TEST_MODE ? 'Test Mode' : 'Azan feature disabled'}`);
    
    const url = 'https://api-v2.voicemonkey.io/announcement';
    const baseAudioUrl = 'https://la-ilaha-illa-allah.netlify.app';
    
    const voice_monkey_token = process.env.VOICEMONKEY_TOKEN;
    
    if (!voice_monkey_token) {
        console.error("Error: Voice Monkey API token is missing!");
        return;
    }

    const payload = {
        token: voice_monkey_token, 
        device: 'voice-monkey-speaker-1',
        audio: baseAudioUrl + (isFajr ? '/mp3/fajr-azan.mp3' : '/mp3/azan.mp3'),
    };

    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        console.log('Azan triggered successfully:', data);
    })
    .catch(error => {
        console.error('Error triggering azan:', error);
    });
}

async function playPrayerAnnoucement(prayerName) {
    if(TEST_MODE || !appConfig.features.announcementEnabled) 
        return console.log(`Announcement not played - ${TEST_MODE ? 'Test Mode' : 'Announcement feature disabled'}`);

    const prayerToAnnouncmentFile = {
        fajr: 't-minus-15-fajr.mp3',
        zuhr: 't-minus-15-dhuhr.mp3',
        asr: 't-minus-15-asr.mp3',
        maghrib: 't-minus-15-maghrib.mp3',
        isha: 't-minus-15-isha.mp3',
    };

    const url = 'https://api-v2.voicemonkey.io/announcement';
    const baseAudioUrl = 'https://la-ilaha-illa-allah.netlify.app/mp3/';

    const voice_monkey_token = process.env.VOICEMONKEY_TOKEN;
    
    if (!voice_monkey_token) {
        console.error("Error: Voice Monkey API token is missing!");
        return;
    }

    const payload = {
        token: voice_monkey_token, 
        device: 'voice-monkey-speaker-1',
        audio: baseAudioUrl + prayerToAnnouncmentFile[prayerName],
    };

    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        console.log('Azan announcment triggered successfully:', data);
    })
    .catch(error => {
        console.error('Error triggering azan announcment:', error);
    });
}

// Function to determine the next prayer
function updateNextPrayer() {
    if (!currentIqamahTimes) return;

    const now = getCurrentTime();
    let nextPrayerName = null;
    let nextPrayerTime = null;

    for (const [prayer, time] of Object.entries(currentPrayerStartTimes)) {
        const prayerTime = moment.tz(time, 'HH:mm', 'Europe/London');
        if (prayerTime.isAfter(now)) {
            nextPrayerName = prayer;
            nextPrayerTime = prayerTime;
            break;
        }
    }

    nextPrayer = nextPrayerName ? {
        name: nextPrayerName,
        time: nextPrayerTime.format('HH:mm'),
        countdown: moment.duration(nextPrayerTime.diff(now)).asMilliseconds()
    } : null;
}

// API Endpoints
app.get('/api/prayer-times', (req, res) => {
    res.json({
        iqamahTimes: currentIqamahTimes,
        startTimes: currentPrayerStartTimes,
        nextPrayer: nextPrayer,
        currentTime: getCurrentTime().format('HH:mm:ss')
    });
});

// Create a Set to store all active SSE clients
const clients = new Set();

// Store logs in memory
const logStore = {
    logs: [],
    errors: [],
    maxLogs: 1000, // Keep last 1000 logs
    
    addLog(type, message) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
        const logEntry = {
            type,
            message,
            timestamp
        };
        
        this.logs.push(logEntry);
        if (type === 'error') {
            this.errors.push(logEntry);
        }
        
        // Keep only last maxLogs entries
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }
        if (this.errors.length > this.maxLogs) {
            this.errors = this.errors.slice(-this.maxLogs);
        }
        
        return logEntry;
    },
    
    clear() {
        this.logs = [];
        this.errors = [];
        broadcastLogs({
            type: 'system',
            message: 'Logs cleared'
        });
    },
    
    getLast(n = 15) {
        return this.logs.slice(-n);
    },
    
    getLastError() {
        return this.errors[this.errors.length - 1];
    }
};

// Function to broadcast logs to all connected clients
function broadcastLogs(logData) {
    const deadClients = new Set();
    
    clients.forEach(client => {
        try {
            client.write(`data: ${JSON.stringify(logData)}\n\n`);
        } catch (error) {
            console.error('Error sending to client:', error.message);
            deadClients.add(client);
        }
    });
    
    // Cleanup dead clients
    deadClients.forEach(client => {
        clients.delete(client);
    });
}

// Override console.log to capture and broadcast logs
const originalConsoleLog = console.log;
console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    const logMessage = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : arg.toString()
    ).join(' ');
    
    const logEntry = logStore.addLog('log', logMessage);
    broadcastLogs(logEntry);
};

// Override console.error to capture and broadcast errors
const originalConsoleError = console.error;
console.error = function(...args) {
    originalConsoleError.apply(console, args);
    const logMessage = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : arg.toString()
    ).join(' ');
    
    const logEntry = logStore.addLog('error', logMessage);
    broadcastLogs(logEntry);
};

// SSE endpoint for real-time logs
app.get('/api/logs/stream', async (req, res) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    
    // Send initial heartbeat
    res.write('data: {"type":"connected","message":"Connected to log stream"}\n\n');
    
    // Send existing logs
    logStore.logs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });
    
    // Add client to the Set
    clients.add(res);

    // Set up ping interval
    const pingInterval = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch (error) {
            clearInterval(pingInterval);
            clients.delete(res);
        }
    }, 30000); // Send ping every 30 seconds

    // Handle client disconnect
    req.on('close', () => {
        clearInterval(pingInterval);
        clients.delete(res);
    });

    // Handle connection errors
    req.on('error', () => {
        clearInterval(pingInterval);
        clients.delete(res);
    });

    // Handle response errors
    res.on('error', () => {
        clearInterval(pingInterval);
        clients.delete(res);
    });
});

// Add new API endpoints for log management
app.post('/api/logs/clear', requireAuth, (req, res) => {
    logStore.clear();
    res.json({ success: true });
});

app.get('/api/logs/last', (req, res) => {
    const count = parseInt(req.query.count) || 15;
    res.json(logStore.getLast(count));
});

app.get('/api/logs/last-error', (req, res) => {
    const lastError = logStore.getLastError();
    res.json(lastError || { type: 'info', message: 'No errors found' });
});

// Add new API endpoint for test mode config
app.get('/api/test-mode', (req, res) => {
    res.json({
        enabled: TEST_MODE,
        startTime: TEST_START_TIME.format('HH:mm:ss'),
        currentOffset: timeOffset,
        timezone: appConfig.testMode.timezone
    });
});

// Add new API endpoints for feature management
app.get('/api/features', (req, res) => {
    res.json(appConfig.features);
});

app.post('/api/features/toggle/:feature', requireAuth, (req, res) => {
    const { feature } = req.params;
    if (feature in appConfig.features) {
        appConfig.features[feature] = !appConfig.features[feature];
        fs.writeFileSync('./config.json', JSON.stringify(appConfig, null, 4));
        scheduleNamazTimers();
        res.json({ success: true, state: appConfig.features[feature] });
    } else {
        res.status(400).json({ success: false, message: 'Invalid feature' });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the Express server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (TEST_MODE) {
        console.log(`🧪 Test Mode Enabled - Time set to ${TEST_START_TIME.format('HH:mm:ss')}`);
    }
});

// Handle server errors
server.on('error', (error) => {
    console.error('Server error:', error.message);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
        process.exit(1);
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error.message);
    // Keep the process running unless it's a critical error
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Keep the process running unless it's a critical error
});

// Update next prayer info every minute
setInterval(updateNextPrayer, 60000);

// Start the scheduling
scheduleNamazTimers();