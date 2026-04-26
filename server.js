// server.js - Serveur complet PALGA TOOLS + WhatsApp API
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIGURATION SUPABASE (codée en dur) ============
const supabaseUrl = 'https://nuiohpzybysaqawdqvvl.supabase.co';
const supabaseKey = 'sb_publishable_02wVBCiyI9-1PV8SXY3Grw_9_dWF-fi';
const supabase = createClient(supabaseUrl, supabaseKey);

// Clé JWT pour webhooks et sessions (fixe pour l'exemple)
const JWT_SECRET = 'PALGA_WHATSAPP_SECRET_KEY_2024';

// ============ MIDDLEWARE ============
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

// Limiteur de requêtes pour les envois WhatsApp
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Trop de messages, veuillez patienter.'
});

// ============ INITIALISATION DE LA BASE DE DONNÉES ============
async function initDatabase() {
  // Tables existantes (votre code)
  await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        whatsapp TEXT,
        credit FLOAT DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        plan TEXT DEFAULT 'free',
        subscription_ends_at TIMESTAMP,
        webhook_url TEXT,
        webhook_secret TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price FLOAT NOT NULL,
        commands TEXT,
        is_active INTEGER DEFAULT 1
      );
      
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount FLOAT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS recharge_transactions (
        id SERIAL PRIMARY KEY,
        transaction_id TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        amount_requested INTEGER NOT NULL,
        credits_amount INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        transaction_message TEXT,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- NOUVELLES TABLES POUR WHATSAPP
      CREATE TABLE IF NOT EXISTS whatsapp_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        phone_number TEXT,
        status TEXT DEFAULT 'initializing',
        qr_code TEXT,
        session_data JSONB,
        last_seen TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id UUID REFERENCES whatsapp_devices(id),
        user_id TEXT REFERENCES users(user_id),
        direction TEXT CHECK (direction IN ('outgoing', 'incoming')),
        to_number TEXT,
        from_number TEXT,
        message TEXT,
        message_id TEXT,
        status TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        price_credits INTEGER NOT NULL,
        messages_per_month INTEGER NOT NULL,
        devices_allowed INTEGER NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
      
      INSERT INTO plans (name, price_credits, messages_per_month, devices_allowed)
      VALUES ('free', 0, 100, 1), ('basic', 50, 2000, 2), ('pro', 150, 10000, 5)
      ON CONFLICT (name) DO NOTHING;
    `
  });

  await createDefaultAdmin();
  await createDefaultDemo();
  await createDefaultServices();
  console.log('✅ Base de données initialisée');
}

async function createDefaultAdmin() {
  const adminId = generateUserId();
  const hashedAdminPw = bcrypt.hashSync('Admin123', 10);
  const { data: existing } = await supabase.from('users').select('*').eq('username', 'administrateur').maybeSingle();
  if (!existing) {
    await supabase.from('users').insert([{
      user_id: adminId, username: 'administrateur', password: hashedAdminPw,
      email: 'admin@palga.com', credit: 1000, is_admin: 1, plan: 'pro',
      subscription_ends_at: new Date(Date.now() + 365 * 24 * 3600 * 1000)
    }]);
    console.log('✅ Admin créé');
  }
}

async function createDefaultDemo() {
  const demoId = generateUserId();
  const hashedDemoPw = bcrypt.hashSync('Demo123', 10);
  const { data: existing } = await supabase.from('users').select('*').eq('username', 'DEMO').maybeSingle();
  if (!existing) {
    await supabase.from('users').insert([{
      user_id: demoId, username: 'DEMO', password: hashedDemoPw,
      email: 'demo@palga.com', credit: 100, is_admin: 0, plan: 'free'
    }]);
    console.log('✅ Utilisateur DEMO créé');
  }
}

async function createDefaultServices() {
  const services = [
    { name: 'FRP Bypass Standard', description: 'Déblocage compte Google', price: 10, commands: '["adb shell content insert --uri content://settings/secure --bind name:s:user_setup_complete --bind value:s:1"]', is_active: 1 },
    { name: 'FRP Bypass Avancé', description: 'Pour Samsung/Huawei', price: 15, commands: '["adb shell settings put global setup_wizard_has_run 1"]', is_active: 1 },
    { name: 'MDM Removal', description: 'Suppression MDM complet', price: 20, commands: '["adb shell pm uninstall -k --user 0 com.android.mdm"]', is_active: 0 },
    { name: 'Web Bypass', description: 'Ouverture du clavier d\'appel', price: 10, commands: '["open_dialer"]', is_active: 1 }
  ];
  for (const service of services) {
    const { data: existing } = await supabase.from('services').select('*').eq('name', service.name).maybeSingle();
    if (!existing) await supabase.from('services').insert([service]);
  }
}

function generateUserId() {
  return 'PALGA' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ============ STOCKAGE DES SESSIONS WHATSAPP ============
const whatsappInstances = new Map();

// ============ SERVICE WHATSAPP ============
class WhatsAppService {
  constructor(deviceId, userId) {
    this.deviceId = deviceId;
    this.userId = userId;
    this.client = null;
    this.isReady = false;
  }

  async initialize() {
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: `device_${this.deviceId}`, dataPath: `./sessions/${this.userId}` }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
    });

    this.client.on('qr', async (qr) => {
      const qrImage = await QRCode.toDataURL(qr);
      await supabase.from('whatsapp_devices').update({ qr_code: qrImage, status: 'awaiting_scan' }).eq('id', this.deviceId);
      console.log(`📱 QR code pour device ${this.deviceId}`);
    });

    this.client.on('ready', async () => {
      this.isReady = true;
      const info = this.client.info;
      await supabase.from('whatsapp_devices').update({ status: 'connected', phone_number: info.wid.user, last_seen: new Date() }).eq('id', this.deviceId);
      console.log(`✅ WhatsApp prêt pour ${info.wid.user}`);
    });

    this.client.on('message', async (message) => {
      await this.handleIncomingMessage(message);
    });

    this.client.on('disconnected', async () => {
      this.isReady = false;
      await supabase.from('whatsapp_devices').update({ status: 'disconnected' }).eq('id', this.deviceId);
      setTimeout(() => this.initialize(), 10000);
    });

    await this.client.initialize();
  }

  async handleIncomingMessage(message) {
    const device = await supabase.from('whatsapp_devices').select('user_id').eq('id', this.deviceId).single();
    const webhookData = {
      type: 'message', deviceId: this.deviceId, userId: device.data.user_id,
      from: message.from, body: message.body, timestamp: message.timestamp,
      messageId: message.id.id
    };
    await supabase.from('whatsapp_messages').insert([{
      device_id: this.deviceId, user_id: device.data.user_id, direction: 'incoming',
      from_number: message.from, message: message.body, message_id: message.id.id, status: 'received'
    }]);
    await this.processWebhook(webhookData);
  }

  async processWebhook(data) {
    const { data: user } = await supabase.from('users').select('webhook_url, webhook_secret').eq('user_id', data.userId).single();
    if (user?.webhook_url) {
      const signature = jwt.sign(data, user.webhook_secret || JWT_SECRET);
      try {
        await axios.post(user.webhook_url, data, { headers: { 'X-Webhook-Signature': signature }, timeout: 5000 });
      } catch (err) { console.error('Webhook échoué', err.message); }
    }
  }

  async sendMessage(to, text) {
    if (!this.isReady) throw new Error('WhatsApp non prêt');
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    const msg = await this.client.sendMessage(chatId, text);
    await supabase.from('whatsapp_messages').insert([{
      device_id: this.deviceId, user_id: this.userId, direction: 'outgoing',
      to_number: to, message: text, message_id: msg.id.id, status: 'sent'
    }]);
    return msg;
  }
}

// ============ MIDDLEWARE AUTHENTIFICATION ============
async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data: user, error } = await supabase.from('users').select('*').eq('user_id', decoded.userId).single();
    if (error || !user) throw new Error();
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// Vérification des droits d'envoi (crédits ou abonnement)
async function checkMessageQuota(userId) {
  const { data: user } = await supabase.from('users').select('credit, plan, subscription_ends_at').eq('user_id', userId).single();
  const currentMonth = new Date();
  const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const { count: messagesSent } = await supabase.from('whatsapp_messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId).eq('direction', 'outgoing')
    .gte('created_at', startOfMonth.toISOString());

  // Chercher le plan
  const { data: plan } = await supabase.from('plans').select('messages_per_month').eq('name', user.plan).single();
  const monthlyLimit = plan?.messages_per_month || 100;

  // Si abonnement actif (subscription_ends_at > now)
  const hasActiveSub = user.subscription_ends_at && new Date(user.subscription_ends_at) > new Date();
  if (hasActiveSub) {
    if (messagesSent >= monthlyLimit) return { allowed: false, reason: 'Limite mensuelle atteinte' };
    return { allowed: true, useCredits: false };
  } else {
    // Mode pay-as-you-go : 1 crédit par message
    if (user.credit < 1) return { allowed: false, reason: 'Crédits insuffisants' };
    return { allowed: true, useCredits: true };
  }
}

// ============ ROUTES EXISTANTES (PALGA TOOLS) ============
app.get('/', (req, res) => res.json({ status: 'online', service: 'PALGA TOOLS + WhatsApp API' }));

app.post('/api/register', async (req, res) => {
  const { username, password, email, whatsapp } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Nom d\'utilisateur et mot de passe requis' });
  const { data: existing } = await supabase.from('users').select('username').eq('username', username).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
  const user_id = generateUserId();
  const hashedPassword = bcrypt.hashSync(password, 10);
  const { error } = await supabase.from('users').insert([{ user_id, username, password: hashedPassword, email, whatsapp, credit: 0 }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, user_id, username });
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  const { data: user, error } = await supabase.from('users').select('*').or(`username.eq.${identifier},user_id.eq.${identifier}`).maybeSingle();
  if (error || !user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Identifiants incorrects' });
  await supabase.from('users').update({ last_login: new Date() }).eq('user_id', user.user_id);
  const token = jwt.sign({ userId: user.user_id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user_id: user.user_id, username: user.username, email: user.email, whatsapp: user.whatsapp, credit: user.credit, is_admin: user.is_admin });
});

app.get('/api/user/:userId/credit', async (req, res) => {
  const { userId } = req.params;
  const { data: user } = await supabase.from('users').select('user_id, username, credit').or(`user_id.eq.${userId},username.eq.${userId}`).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  res.json(user);
});

app.get('/api/services', async (req, res) => {
  const { data: services } = await supabase.from('services').select('*').eq('is_active', 1);
  res.json(services || []);
});

// Vérification de transaction (inchangée)
function verifyTransactionMessage(message, requestedAmount, phoneNumber) {
  const errors = [];
  if (!message.includes('Votre paiement')) errors.push('Message de confirmation invalide');
  if (!message.includes('ISSIAKA BOKOUM')) errors.push('Nom du bénéficiaire incorrect');
  const amountMatch = message.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\s*FCFA/);
  let paidAmount = null;
  if (amountMatch) paidAmount = parseFloat(amountMatch[1].replace(/[.,]/g, '')) / 100;
  if (!paidAmount) errors.push('Montant non trouvé');
  const expectedAmount = requestedAmount * 100;
  if (paidAmount && Math.abs(paidAmount - expectedAmount) > 1) errors.push(`Montant incorrect: attendu ${expectedAmount} FCFA, reçu ${paidAmount} FCFA`);
  const transIdMatch = message.match(/Trans id:\s*([A-Z0-9.]+)/i);
  const transId = transIdMatch ? transIdMatch[1] : null;
  if (!transId) errors.push('Transaction ID non trouvé');
  if (transId && !transId.startsWith('MP')) errors.push('Format de transaction ID invalide');
  const datePattern = /MP(\d{2})(\d{2})(\d{2})\.(\d{2})(\d{2})/;
  const dateMatch = transId?.match(datePattern);
  if (dateMatch) {
    const year = 2000 + parseInt(dateMatch[1]), month = parseInt(dateMatch[2]), day = parseInt(dateMatch[3]), hour = parseInt(dateMatch[4]), minute = parseInt(dateMatch[5]);
    const transactionDate = new Date(year, month-1, day, hour, minute);
    const now = new Date();
    if (transactionDate.toDateString() !== now.toDateString()) errors.push('Transaction pas du jour');
    const timeDiff = (now - transactionDate) / 60000;
    if (timeDiff > 2) errors.push(`Transaction trop ancienne (${Math.floor(timeDiff)} min)`);
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, data: { transId, paidAmount, transactionDate: new Date() } };
}

app.post('/api/verify-recharge', async (req, res) => {
  const { user_id, credits_amount, phone_number, transaction_message } = req.body;
  if (!user_id || !credits_amount || !phone_number || !transaction_message)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (![10,20].includes(credits_amount)) return res.status(400).json({ error: 'Crédits invalides (10 ou 20)' });
  const { data: user } = await supabase.from('users').select('user_id, credit').or(`user_id.eq.${user_id},username.eq.${user_id}`).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  const { data: existing } = await supabase.from('recharge_transactions').select('transaction_id').eq('transaction_id', transaction_message.substring(0,100)).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Transaction déjà utilisée' });
  const verification = verifyTransactionMessage(transaction_message, credits_amount, phone_number);
  if (!verification.valid) {
    await supabase.from('recharge_transactions').insert([{ transaction_id: transaction_message.substring(0,100), user_id: user.user_id, phone_number, amount_requested: credits_amount, credits_amount, status: 'fraud_attempt', transaction_message: transaction_message.substring(0,500) }]);
    return res.status(400).json({ error: verification.errors.join(', ') });
  }
  const newCredit = user.credit + credits_amount;
  await supabase.from('users').update({ credit: newCredit }).eq('user_id', user.user_id);
  await supabase.from('recharge_transactions').insert([{ transaction_id: verification.data.transId, user_id: user.user_id, phone_number, amount_requested: credits_amount, credits_amount, status: 'completed', transaction_message: transaction_message.substring(0,500), verified_at: new Date() }]);
  await supabase.from('transactions').insert([{ user_id: user.user_id, type: 'recharge', amount: credits_amount, description: `Recharge ${credits_amount} crédits - ${verification.data.transId}` }]);
  res.json({ success: true, new_credit: newCredit, added_credits: credits_amount, transaction_id: verification.data.transId });
});

app.get('/api/check-transaction/:transId', async (req, res) => {
  const { transId } = req.params;
  const { data: tx } = await supabase.from('recharge_transactions').select('*').eq('transaction_id', transId).maybeSingle();
  res.json(tx ? { exists: true, status: tx.status, user_id: tx.user_id, amount: tx.credits_amount } : { exists: false });
});

app.post('/api/service/frp-bypass', async (req, res) => {
  const { user_id, service_id } = req.body;
  const { data: service } = await supabase.from('services').select('*').eq('id', service_id).eq('is_active',1).maybeSingle();
  if (!service) return res.status(404).json({ error: 'Service non trouvé' });
  const { data: user } = await supabase.from('users').select('credit').eq('user_id', user_id).maybeSingle();
  if (!user || user.credit < service.price) return res.status(400).json({ error: `Crédits insuffisants, besoin de ${service.price}` });
  const newCredit = user.credit - service.price;
  await supabase.from('users').update({ credit: newCredit }).eq('user_id', user_id);
  await supabase.from('transactions').insert([{ user_id, type: 'service', amount: service.price, description: service.name }]);
  let commands = [];
  try { commands = JSON.parse(service.commands); } catch(e) { commands = [service.commands]; }
  res.json({ success: true, remaining_credit: newCredit, commands, service_name: service.name });
});

app.post('/api/service/web-bypass', async (req, res) => {
  const { user_id } = req.body;
  const { data: user } = await supabase.from('users').select('credit').or(`user_id.eq.${user_id},username.eq.${user_id}`).maybeSingle();
  if (!user || user.credit < 10) return res.status(400).json({ error: `Crédits insuffisants, besoin de 10` });
  const newCredit = user.credit - 10;
  await supabase.from('users').update({ credit: newCredit }).eq('user_id', user.user_id);
  await supabase.from('transactions').insert([{ user_id: user.user_id, type: 'service', amount: 10, description: 'Web Bypass' }]);
  res.json({ success: true, remaining_credit: newCredit, message: "Web Bypass effectué!", action: "open_dialer", intent_url: "tel:" });
});

// ============ ROUTES ADMIN (inchangées) ============
app.get('/api/admin/users', async (req, res) => {
  const { admin_id } = req.query;
  const { data: admin } = await supabase.from('users').select('is_admin').eq('user_id', admin_id).maybeSingle();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Non autorisé' });
  const { data: users } = await supabase.from('users').select('user_id, username, email, whatsapp, credit, is_admin, plan, subscription_ends_at, created_at, last_login').order('created_at', { ascending: false });
  res.json(users || []);
});

app.post('/api/admin/add-credit', async (req, res) => {
  const { admin_id, user_id, amount, description } = req.body;
  const { data: admin } = await supabase.from('users').select('is_admin').eq('user_id', admin_id).maybeSingle();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Non autorisé' });
  const { data: user } = await supabase.from('users').select('credit').eq('user_id', user_id).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  const newCredit = user.credit + amount;
  await supabase.from('users').update({ credit: newCredit }).eq('user_id', user_id);
  await supabase.from('transactions').insert([{ user_id, type: 'admin_credit', amount, description: description || 'Ajout par admin' }]);
  res.json({ success: true, new_credit: newCredit });
});

app.get('/api/admin/stats', async (req, res) => {
  const { admin_id } = req.query;
  const { data: admin } = await supabase.from('users').select('is_admin').eq('user_id', admin_id).maybeSingle();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Non autorisé' });
  const { count: total_users } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { data: creditData } = await supabase.from('users').select('credit');
  const total_credit = creditData?.reduce((s,u) => s + (u.credit||0), 0) || 0;
  const { count: total_transactions } = await supabase.from('transactions').select('*', { count: 'exact', head: true });
  const { count: services_used } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('type', 'service');
  const { count: fraud_attempts } = await supabase.from('recharge_transactions').select('*', { count: 'exact', head: true }).eq('status', 'fraud_attempt');
  res.json({ total_users: total_users||0, total_credit, total_transactions: total_transactions||0, services_used: services_used||0, fraud_attempts: fraud_attempts||0 });
});

app.get('/api/admin/recharge-transactions', async (req, res) => {
  const { admin_id } = req.query;
  const { data: admin } = await supabase.from('users').select('is_admin').eq('user_id', admin_id).maybeSingle();
  if (!admin?.is_admin) return res.status(403).json({ error: 'Non autorisé' });
  const { data: tx } = await supabase.from('recharge_transactions').select('*').order('created_at', { ascending: false }).limit(100);
  res.json(tx || []);
});

app.get('/api/user/:userId/transactions', async (req, res) => {
  const { userId } = req.params;
  const { data: tx } = await supabase.from('transactions').select('type, amount, description, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
  res.json(tx || []);
});

// ============ NOUVELLES ROUTES WHATSAPP ============
app.get('/api/plans', async (req, res) => {
  const { data: plans } = await supabase.from('plans').select('*').eq('is_active', true);
  res.json(plans);
});

app.post('/api/subscribe', authenticate, async (req, res) => {
  const { planName } = req.body; // 'basic' ou 'pro'
  const user = req.user;
  const { data: plan } = await supabase.from('plans').select('*').eq('name', planName).eq('is_active', true).single();
  if (!plan) return res.status(400).json({ error: 'Plan invalide' });
  if (user.credit < plan.price_credits) return res.status(400).json({ error: `Crédits insuffisants, besoin de ${plan.price_credits}` });
  const newCredit = user.credit - plan.price_credits;
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + 1);
  await supabase.from('users').update({ credit: newCredit, plan: planName, subscription_ends_at: endDate.toISOString() }).eq('user_id', user.user_id);
  await supabase.from('transactions').insert([{ user_id: user.user_id, type: 'subscription', amount: plan.price_credits, description: `Abonnement ${plan.name} - 1 mois` }]);
  res.json({ success: true, new_credit: newCredit, plan: planName, expires_at: endDate });
});

// Connecter un appareil WhatsApp
app.post('/api/whatsapp/connect', authenticate, async (req, res) => {
  const user = req.user;
  const { data: plan } = await supabase.from('plans').select('devices_allowed').eq('name', user.plan).single();
  const maxDevices = plan?.devices_allowed || 1;
  const { count: deviceCount } = await supabase.from('whatsapp_devices').select('*', { count: 'exact', head: true }).eq('user_id', user.user_id).eq('status', 'connected');
  if (deviceCount >= maxDevices) return res.status(403).json({ error: `Limite de ${maxDevices} appareil(s) atteinte pour votre plan` });
  const { data: newDevice, error } = await supabase.from('whatsapp_devices').insert([{ user_id: user.user_id, status: 'initializing' }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const waService = new WhatsAppService(newDevice.id, user.user_id);
  whatsappInstances.set(newDevice.id, waService);
  waService.initialize().catch(err => console.error(err));
  res.json({ deviceId: newDevice.id, message: 'Appareil en initialisation, récupérez le QR code' });
});

// Lister les appareils
app.get('/api/whatsapp/devices', authenticate, async (req, res) => {
  const { data: devices } = await supabase.from('whatsapp_devices').select('id, phone_number, status, qr_code, last_seen, created_at').eq('user_id', req.user.user_id);
  res.json(devices || []);
});

// Récupérer QR code d'un appareil
app.get('/api/whatsapp/devices/:deviceId/qr', authenticate, async (req, res) => {
  const { data: device } = await supabase.from('whatsapp_devices').select('qr_code, status').eq('id', req.params.deviceId).eq('user_id', req.user.user_id).single();
  if (!device) return res.status(404).json({ error: 'Appareil non trouvé' });
  res.json({ qr: device.qr_code, status: device.status });
});

// Envoyer un message
app.post('/api/whatsapp/send', authenticate, messageLimiter, async (req, res) => {
  const { deviceId, to, message } = req.body;
  if (!deviceId || !to || !message) return res.status(400).json({ error: 'deviceId, to et message requis' });
  const { data: device, error } = await supabase.from('whatsapp_devices').select('id, status').eq('id', deviceId).eq('user_id', req.user.user_id).single();
  if (error || !device || device.status !== 'connected') return res.status(400).json({ error: 'Appareil non connecté' });
  const quota = await checkMessageQuota(req.user.user_id);
  if (!quota.allowed) return res.status(402).json({ error: quota.reason });
  const waService = whatsappInstances.get(deviceId);
  if (!waService || !waService.isReady) return res.status(503).json({ error: 'WhatsApp non prêt' });
  try {
    const result = await waService.sendMessage(to, message);
    if (quota.useCredits) {
      const newCredit = req.user.credit - 1;
      await supabase.from('users').update({ credit: newCredit }).eq('user_id', req.user.user_id);
    }
    res.json({ success: true, messageId: result.id.id, remaining_credit: quota.useCredits ? req.user.credit - 1 : req.user.credit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configurer webhook
app.post('/api/whatsapp/webhook', authenticate, async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl requis' });
  const secret = crypto.randomBytes(20).toString('hex');
  await supabase.from('users').update({ webhook_url: webhookUrl, webhook_secret: secret }).eq('user_id', req.user.user_id);
  res.json({ success: true, webhookSecret: secret });
});

// Déconnecter un appareil
app.delete('/api/whatsapp/devices/:deviceId', authenticate, async (req, res) => {
  const { data: device } = await supabase.from('whatsapp_devices').select('id').eq('id', req.params.deviceId).eq('user_id', req.user.user_id).single();
  if (!device) return res.status(404).json({ error: 'Appareil non trouvé' });
  const waService = whatsappInstances.get(req.params.deviceId);
  if (waService && waService.client) await waService.client.destroy();
  whatsappInstances.delete(req.params.deviceId);
  await supabase.from('whatsapp_devices').update({ status: 'disconnected', qr_code: null }).eq('id', req.params.deviceId);
  res.json({ success: true });
});

// ============ DÉMARRAGE ============
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Serveur PALGA TOOLS + WhatsApp démarré sur http://localhost:${PORT}`);
    console.log(`📡 API disponible`);
  });
}).catch(err => {
  console.error('Erreur au démarrage:', err);
  app.listen(PORT, () => console.log(`Serveur démarré sur port ${PORT}`));
});
