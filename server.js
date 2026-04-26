require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const rateLimit = require('express-rate-limit');

// ========== INITIALISATION ==========
const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true })); // Autorise tous les domaines
app.use(express.urlencoded({ extended: true }));

// Base de données PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Redis pour files d'attente et sessions (optionnel mais recommandé)
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// ========== MODÈLES SIMPLIFIÉS (sans ORM) ==========
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      company_name VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'trial',
      trial_ends_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days',
      subscription_ends_at TIMESTAMP,
      max_devices INT DEFAULT 1,
      webhook_url TEXT,
      webhook_secret VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      phone_number VARCHAR(20),
      session_data JSONB,
      status VARCHAR(50) DEFAULT 'initializing',
      qr_code TEXT,
      last_seen TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      plan VARCHAR(50),
      price DECIMAL(10,2),
      stripe_subscription_id VARCHAR(255),
      status VARCHAR(50),
      start_date TIMESTAMP,
      end_date TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS message_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID REFERENCES devices(id),
      user_id UUID REFERENCES users(id),
      to_number VARCHAR(20),
      message TEXT,
      status VARCHAR(50),
      message_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
};
initDB();

// ========== STOCKAGE DES CLIENTS WHATSAPP (en mémoire) ==========
const whatsappInstances = new Map();

// ========== SERVICE WHATSAPP ==========
class WhatsAppService {
  constructor(deviceId, userId) {
    this.deviceId = deviceId;
    this.userId = userId;
    this.client = null;
    this.isReady = false;
  }

  async initialize() {
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: `device_${this.deviceId}`,
        dataPath: `./sessions/${this.userId}`
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    this.client.on('qr', async (qr) => {
      const qrImage = await QRCode.toDataURL(qr);
      await pool.query('UPDATE devices SET qr_code = $1, status = $2 WHERE id = $3', [qrImage, 'awaiting_scan', this.deviceId]);
      console.log(`📱 QR code generated for device ${this.deviceId}`);
    });

    this.client.on('ready', async () => {
      this.isReady = true;
      const info = this.client.info;
      await pool.query('UPDATE devices SET status = $1, phone_number = $2 WHERE id = $3', ['connected', info.wid.user, this.deviceId]);
      console.log(`✅ WhatsApp ready for device ${this.deviceId} (${info.wid.user})`);
    });

    this.client.on('message', async (message) => {
      await this.handleIncomingMessage(message);
    });

    this.client.on('disconnected', async (reason) => {
      this.isReady = false;
      await pool.query('UPDATE devices SET status = $1 WHERE id = $2', ['disconnected', this.deviceId]);
      console.log(`⚠️ Device ${this.deviceId} disconnected: ${reason}`);
      // Tentative de reconnexion automatique après 5 secondes
      setTimeout(() => this.initialize(), 5000);
    });

    await this.client.initialize();
  }

  async handleIncomingMessage(message) {
    const webhookData = {
      type: 'message',
      deviceId: this.deviceId,
      userId: this.userId,
      from: message.from,
      body: message.body,
      timestamp: message.timestamp,
      hasMedia: message.hasMedia,
      messageId: message.id.id
    };
    // Mettre dans queue Redis pour traitement asynchrone
    await redis.lpush('webhook_queue', JSON.stringify(webhookData));
    await this.processWebhook(webhookData);
  }

  async processWebhook(data) {
    const result = await pool.query('SELECT webhook_url, webhook_secret FROM users WHERE id = $1', [this.userId]);
    const user = result.rows[0];
    if (user && user.webhook_url) {
      try {
        const signature = jwt.sign(data, user.webhook_secret);
        await axios.post(user.webhook_url, data, {
          headers: { 'X-Webhook-Signature': signature }
        });
      } catch (err) {
        console.error('Webhook failed, queuing retry', err.message);
        await redis.lpush('webhook_retry', JSON.stringify({ ...data, retry: 0 }));
      }
    }
  }

  async sendMessage(to, text, options = {}) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    const msg = await this.client.sendMessage(chatId, text, options);
    await pool.query(
      'INSERT INTO message_logs (device_id, user_id, to_number, message, status, message_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [this.deviceId, this.userId, to, text, 'sent', msg.id.id]
    );
    return msg;
  }

  async sendMedia(to, mediaUrl, caption = '') {
    const media = await MessageMedia.fromUrl(mediaUrl);
    return this.sendMessage(to, media, { caption });
  }
}

// ========== MIDDLEWARES ==========
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) throw new Error('User not found');
    req.user = result.rows[0];
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Too many requests, please try again later.'
});

// ========== ROUTES ==========
// 1. Auth
app.post('/api/auth/register', async (req, res) => {
  const { email, password, companyName } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      'INSERT INTO users (email, password, company_name) VALUES ($1, $2, $3) RETURNING id, email, company_name, subscription_status, trial_ends_at, max_devices',
      [email, hashed, companyName]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email, company_name: user.company_name, subscription_status: user.subscription_status, max_devices: user.max_devices } });
});

// 2. WhatsApp Devices
app.post('/api/devices/connect', authenticate, async (req, res) => {
  const user = req.user;
  const activeCount = await pool.query('SELECT COUNT(*) FROM devices WHERE user_id = $1 AND status = $2', [user.id, 'connected']);
  if (parseInt(activeCount.rows[0].count) >= user.max_devices) {
    return res.status(403).json({ error: 'Device limit reached. Upgrade your plan.' });
  }
  const deviceResult = await pool.query('INSERT INTO devices (user_id, status) VALUES ($1, $2) RETURNING id', [user.id, 'initializing']);
  const deviceId = deviceResult.rows[0].id;
  const waService = new WhatsAppService(deviceId, user.id);
  whatsappInstances.set(deviceId, waService);
  waService.initialize().catch(err => console.error('Init error', err));
  res.json({ deviceId, message: 'Device initializing, QR code will appear soon.' });
});

app.get('/api/devices', authenticate, async (req, res) => {
  const result = await pool.query('SELECT id, phone_number, status, qr_code, last_seen FROM devices WHERE user_id = $1', [req.user.id]);
  res.json(result.rows);
});

app.get('/api/devices/:deviceId/qr', authenticate, async (req, res) => {
  const result = await pool.query('SELECT qr_code FROM devices WHERE id = $1 AND user_id = $2', [req.params.deviceId, req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
  res.json({ qr: result.rows[0].qr_code });
});

app.post('/api/devices/:deviceId/send', authenticate, rateLimiter, async (req, res) => {
  const { deviceId } = req.params;
  const { to, message, type = 'text', mediaUrl } = req.body;
  const deviceCheck = await pool.query('SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND status = $3', [deviceId, req.user.id, 'connected']);
  if (deviceCheck.rows.length === 0) return res.status(400).json({ error: 'Device not connected or not found' });
  const waService = whatsappInstances.get(deviceId);
  if (!waService || !waService.isReady) return res.status(503).json({ error: 'WhatsApp session not ready' });
  try {
    let result;
    if (type === 'media' && mediaUrl) {
      result = await waService.sendMedia(to, mediaUrl, message);
    } else {
      result = await waService.sendMessage(to, message);
    }
    res.json({ success: true, messageId: result.id.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Webhook configuration
app.post('/api/webhook/configure', authenticate, async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });
  const secret = uuidv4();
  await pool.query('UPDATE users SET webhook_url = $1, webhook_secret = $2 WHERE id = $3', [webhookUrl, secret, req.user.id]);
  res.json({ success: true, webhookSecret: secret });
});

// 4. Subscription (Stripe)
app.post('/api/subscription/create', authenticate, async (req, res) => {
  const { planId, paymentMethodId } = req.body;
  const plans = {
    basic: { name: 'Basic', price: 29, maxDevices: 1, stripePriceId: process.env.STRIPE_PRICE_BASIC },
    pro: { name: 'Pro', price: 99, maxDevices: 5, stripePriceId: process.env.STRIPE_PRICE_PRO },
    enterprise: { name: 'Enterprise', price: 299, maxDevices: 20, stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE }
  };
  const plan = plans[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  
  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, payment_method: paymentMethodId });
    customerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
  }
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: plan.stripePriceId }],
    trial_period_days: planId === 'basic' ? 7 : 0
  });
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, price, stripe_subscription_id, status, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
    [req.user.id, planId, plan.price, subscription.id, 'active', endDate]
  );
  await pool.query('UPDATE users SET subscription_status = $1, max_devices = $2, subscription_ends_at = $3 WHERE id = $4',
    ['active', plan.maxDevices, endDate, req.user.id]);
  res.json({ success: true, plan: planId, endDate });
});

app.get('/api/subscription/status', authenticate, async (req, res) => {
  const user = req.user;
  const remainingDays = user.subscription_ends_at
    ? Math.max(0, Math.ceil((new Date(user.subscription_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : 0;
  res.json({
    status: user.subscription_status,
    maxDevices: user.max_devices,
    trialEndsAt: user.trial_ends_at,
    subscriptionEndsAt: user.subscription_ends_at,
    daysLeft: remainingDays
  });
});

// 5. Admin (statistiques simples)
app.get('/api/admin/stats', authenticate, async (req, res) => {
  if (req.user.email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: 'Admin only' });
  const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
  const activeSubs = await pool.query("SELECT COUNT(*) FROM users WHERE subscription_status = 'active'");
  const connectedDevices = await pool.query("SELECT COUNT(*) FROM devices WHERE status = 'connected'");
  const messagesToday = await pool.query("SELECT COUNT(*) FROM message_logs WHERE created_at::date = NOW()::date");
  res.json({
    totalUsers: parseInt(totalUsers.rows[0].count),
    activeSubscriptions: parseInt(activeSubs.rows[0].count),
    connectedDevices: parseInt(connectedDevices.rows[0].count),
    messagesToday: parseInt(messagesToday.rows[0].count)
  });
});

// 6. Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ========== WORKER POUR WEBHOOKS (exécuté en arrière-plan) ==========
const startWebhookWorker = async () => {
  while (true) {
    try {
      const data = await redis.brpop('webhook_queue', 0);
      if (data) {
        const webhookData = JSON.parse(data[1]);
        await processWebhookWithRetry(webhookData);
      }
    } catch (err) {
      console.error('Worker error', err);
    }
  }
};

const processWebhookWithRetry = async (data) => {
  const result = await pool.query('SELECT webhook_url, webhook_secret FROM users WHERE id = $1', [data.userId]);
  const user = result.rows[0];
  if (user && user.webhook_url) {
    try {
      const signature = jwt.sign(data, user.webhook_secret);
      await axios.post(user.webhook_url, data, { headers: { 'X-Webhook-Signature': signature }, timeout: 5000 });
    } catch (err) {
      console.log(`Webhook retry scheduled for ${data.messageId}`);
      await redis.lpush('webhook_retry', JSON.stringify({ ...data, retry: (data.retry || 0) + 1 }));
      if ((data.retry || 0) < 3) {
        setTimeout(() => processWebhookWithRetry(data), 5000 * (data.retry + 1));
      }
    }
  }
};

// Lancer le worker
if (process.env.NODE_ENV !== 'test') {
  startWebhookWorker();
}

// ========== DÉMARRAGE ==========
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
