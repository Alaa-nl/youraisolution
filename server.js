require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const bcrypt = require('bcrypt');
const session = require('express-session');
const database = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database and queries
database.initializeDatabase();
const queries = database.queries;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Twilio client (only if credentials are configured)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC') &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('Twilio client initialized successfully');
  } catch (error) {
    console.warn('Failed to initialize Twilio client:', error.message);
  }
} else {
  console.warn('Twilio credentials not configured. Voice calls will not work.');
}

// Configuration: Set to false for testing, true for production
const ENABLE_TRIAL_RESTRICTIONS = process.env.ENABLE_TRIAL_RESTRICTIONS === 'true' || false;

// In-memory storage for call sessions and trial tracking
const callSessions = new Map(); // CallSid -> { businessInfo, conversationHistory, startTime, businessName, from, lastLanguage }
const trialPhoneNumbers = new Set(); // Phone numbers that have used their free trial
const businessSessions = new Map(); // SessionId -> { businessInfo, createdAt, sessionId }
const twilioNumberToSession = new Map(); // Twilio number -> SessionId mapping for multi-number support

// Language to Polly voice mapping (for text-to-speech)
const LANGUAGE_VOICE_MAP = {
  'nl-NL': { language: 'nl-NL', voice: 'Polly.Lotte' },
  'en-US': { language: 'en-US', voice: 'Polly.Salli' },
  'en-GB': { language: 'en-GB', voice: 'Polly.Amy' },
  'de-DE': { language: 'de-DE', voice: 'Polly.Marlene' },
  'fr-FR': { language: 'fr-FR', voice: 'Polly.Celine' },
  'es-ES': { language: 'es-ES', voice: 'Polly.Conchita' },
  'tr-TR': { language: 'tr-TR', voice: 'Polly.Filiz' },
  'it-IT': { language: 'it-IT', voice: 'Polly.Carla' },
  'pl-PL': { language: 'pl-PL', voice: 'Polly.Ewa' },
  'pt-BR': { language: 'pt-BR', voice: 'Polly.Vitoria' },
  'ar-SA': { language: 'arb', voice: 'Polly.Zeina' } // Note: Polly uses 'arb' for Arabic
};

// Language to Twilio speech recognition mapping (for speech-to-text in Gather)
// These are the language codes that Twilio's speech recognition engine expects
const SPEECH_RECOGNITION_MAP = {
  'nl-NL': 'nl-NL',
  'en-US': 'en-US',
  'en-GB': 'en-GB',
  'de-DE': 'de-DE',
  'fr-FR': 'fr-FR',
  'es-ES': 'es-ES',
  'tr-TR': 'tr-TR',
  'it-IT': 'it-IT',
  'pl-PL': 'pl-PL',
  'pt-BR': 'pt-BR',
  'ar-SA': 'ar-SA' // Arabic speech recognition
};

console.log(`Trial restrictions: ${ENABLE_TRIAL_RESTRICTIONS ? 'ENABLED' : 'DISABLED (Testing Mode)'}`);

// Language handoff helper functions for professional transitions
const COLLEAGUE_NAMES = {
  'nl-NL': 'Sophie',
  'en-US': 'Emma',
  'en-GB': 'Emily',
  'de-DE': 'Anna',
  'fr-FR': 'Marie',
  'es-ES': 'Sofia',
  'tr-TR': 'Ayşe',
  'it-IT': 'Giulia',
  'pl-PL': 'Zofia',
  'pt-BR': 'Maria',
  'ar-SA': 'Layla'
};

const LANGUAGE_NAMES = {
  'nl-NL': { 'nl-NL': 'Nederlands', 'en-US': 'Dutch', 'de-DE': 'Niederländisch', 'fr-FR': 'Néerlandais', 'es-ES': 'Holandés', 'tr-TR': 'Flemenkçe', 'it-IT': 'Olandese', 'pl-PL': 'Niderlandzki', 'pt-BR': 'Holandês', 'ar-SA': 'الهولندية' },
  'en-US': { 'nl-NL': 'Engels', 'en-US': 'English', 'de-DE': 'Englisch', 'fr-FR': 'Anglais', 'es-ES': 'Inglés', 'tr-TR': 'İngilizce', 'it-IT': 'Inglese', 'pl-PL': 'Angielski', 'pt-BR': 'Inglês', 'ar-SA': 'الإنجليزية' },
  'en-GB': { 'nl-NL': 'Engels', 'en-US': 'English', 'de-DE': 'Englisch', 'fr-FR': 'Anglais', 'es-ES': 'Inglés', 'tr-TR': 'İngilizce', 'it-IT': 'Inglese', 'pl-PL': 'Angielski', 'pt-BR': 'Inglês', 'ar-SA': 'الإنجليزية' },
  'de-DE': { 'nl-NL': 'Duits', 'en-US': 'German', 'de-DE': 'Deutsch', 'fr-FR': 'Allemand', 'es-ES': 'Alemán', 'tr-TR': 'Almanca', 'it-IT': 'Tedesco', 'pl-PL': 'Niemiecki', 'pt-BR': 'Alemão', 'ar-SA': 'الألمانية' },
  'fr-FR': { 'nl-NL': 'Frans', 'en-US': 'French', 'de-DE': 'Französisch', 'fr-FR': 'Français', 'es-ES': 'Francés', 'tr-TR': 'Fransızca', 'it-IT': 'Francese', 'pl-PL': 'Francuski', 'pt-BR': 'Francês', 'ar-SA': 'الفرنسية' },
  'es-ES': { 'nl-NL': 'Spaans', 'en-US': 'Spanish', 'de-DE': 'Spanisch', 'fr-FR': 'Espagnol', 'es-ES': 'Español', 'tr-TR': 'İspanyolca', 'it-IT': 'Spagnolo', 'pl-PL': 'Hiszpański', 'pt-BR': 'Espanhol', 'ar-SA': 'الإسبانية' },
  'tr-TR': { 'nl-NL': 'Turks', 'en-US': 'Turkish', 'de-DE': 'Türkisch', 'fr-FR': 'Turc', 'es-ES': 'Turco', 'tr-TR': 'Türkçe', 'it-IT': 'Turco', 'pl-PL': 'Turecki', 'pt-BR': 'Turco', 'ar-SA': 'التركية' },
  'it-IT': { 'nl-NL': 'Italiaans', 'en-US': 'Italian', 'de-DE': 'Italienisch', 'fr-FR': 'Italien', 'es-ES': 'Italiano', 'tr-TR': 'İtalyanca', 'it-IT': 'Italiano', 'pl-PL': 'Włoski', 'pt-BR': 'Italiano', 'ar-SA': 'الإيطالية' },
  'pl-PL': { 'nl-NL': 'Pools', 'en-US': 'Polish', 'de-DE': 'Polnisch', 'fr-FR': 'Polonais', 'es-ES': 'Polaco', 'tr-TR': 'Lehçe', 'it-IT': 'Polacco', 'pl-PL': 'Polski', 'pt-BR': 'Polonês', 'ar-SA': 'البولندية' },
  'pt-BR': { 'nl-NL': 'Portugees', 'en-US': 'Portuguese', 'de-DE': 'Portugiesisch', 'fr-FR': 'Portugais', 'es-ES': 'Portugués', 'tr-TR': 'Portekizce', 'it-IT': 'Portoghese', 'pl-PL': 'Portugalski', 'pt-BR': 'Português', 'ar-SA': 'البرتغالية' },
  'ar-SA': { 'nl-NL': 'Arabisch', 'en-US': 'Arabic', 'de-DE': 'Arabisch', 'fr-FR': 'Arabe', 'es-ES': 'Árabe', 'tr-TR': 'Arapça', 'it-IT': 'Arabo', 'pl-PL': 'Arabski', 'pt-BR': 'Árabe', 'ar-SA': 'العربية' }
};

// Generate handoff message in the current language
function getHandoffMessage(currentLang, newLang) {
  const languageName = LANGUAGE_NAMES[newLang]?.[currentLang] || 'that language';
  const colleagueName = COLLEAGUE_NAMES[newLang] || 'my colleague';

  const templates = {
    'nl-NL': `Natuurlijk! Een moment alsjeblieft, ik verbind u door met mijn collega die ${languageName} spreekt.`,
    'en-US': `Of course! One moment please, I'll connect you with my colleague who speaks ${languageName}.`,
    'en-GB': `Of course! One moment please, I'll connect you with my colleague who speaks ${languageName}.`,
    'de-DE': `Natürlich! Einen Moment bitte, ich verbinde Sie mit meinem Kollegen, der ${languageName} spricht.`,
    'fr-FR': `Bien sûr! Un instant s'il vous plaît, je vous mets en relation avec mon collègue qui parle ${languageName}.`,
    'es-ES': `¡Por supuesto! Un momento por favor, le conecto con mi colega que habla ${languageName}.`,
    'tr-TR': `Tabii ki! Bir dakika lütfen, sizi ${languageName} konuşan meslektaşımla bağlıyorum.`,
    'it-IT': `Certo! Un momento per favore, la metto in contatto con il mio collega che parla ${languageName}.`,
    'pl-PL': `Oczywiście! Chwileczkę, połączę Pana z moim kolegą mówiącym po ${languageName}.`,
    'pt-BR': `Claro! Um momento por favor, vou conectá-lo com meu colega que fala ${languageName}.`,
    'ar-SA': `بالطبع! لحظة من فضلك، سأوصلك بزميلي الذي يتحدث ${languageName}.`
  };

  return templates[currentLang] || templates['en-US'];
}

// Generate greeting from new colleague in their language
function getColleagueGreeting(newLang, businessName) {
  const colleagueName = COLLEAGUE_NAMES[newLang] || 'Emma';

  const templates = {
    'nl-NL': `Hallo! Ik ben ${colleagueName}. Hoe kan ik u helpen?`,
    'en-US': `Hello! I'm ${colleagueName}. How can I help you?`,
    'en-GB': `Hello! I'm ${colleagueName}. How can I help you?`,
    'de-DE': `Hallo! Ich bin ${colleagueName}. Wie kann ich Ihnen helfen?`,
    'fr-FR': `Bonjour! Je suis ${colleagueName}. Comment puis-je vous aider?`,
    'es-ES': `¡Hola! Soy ${colleagueName}. ¿Cómo puedo ayudarte?`,
    'tr-TR': `Merhaba! Ben ${colleagueName}. Size nasıl yardımcı olabilirim?`,
    'it-IT': `Ciao! Sono ${colleagueName}. Come posso aiutarti?`,
    'pl-PL': `Cześć! Jestem ${colleagueName}. Jak mogę pomóc?`,
    'pt-BR': `Olá! Eu sou ${colleagueName}. Como posso ajudá-lo?`,
    'ar-SA': `مرحباً! أنا ${colleagueName}. كيف يمكنني مساعدتك؟`
  };

  return templates[newLang] || templates['en-US'];
}

// Helper function to get active session (most recent within last 30 minutes)
function getActiveSession() {
  const now = Date.now();
  const thirtyMinutesAgo = now - (30 * 60 * 1000);

  let mostRecentSession = null;
  let mostRecentTime = 0;

  for (const [sessionId, data] of businessSessions.entries()) {
    if (data.createdAt > thirtyMinutesAgo && data.createdAt > mostRecentTime) {
      mostRecentSession = sessionId;
      mostRecentTime = data.createdAt;
    }
  }

  return mostRecentSession;
}

// Clean up old sessions (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  for (const [sessionId, data] of businessSessions.entries()) {
    if (data.createdAt < oneHourAgo) {
      console.log(`Cleaning up old session: ${sessionId} for business: ${data.businessInfo.businessName}`);
      businessSessions.delete(sessionId);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-ai-solution-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// API authentication middleware (for API routes)
function requireAuthAPI(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Niet geautoriseerd' });
  }
  next();
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Serve static pages
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/login', (req, res) => {
  // If already logged in, redirect to dashboard
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard/setup', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  // For now, redirect to setup if not completed
  const customer = queries.findCustomerById.get(req.session.userId);
  const businessProfile = queries.findBusinessByCustomerId.get(req.session.userId);

  if (!businessProfile || !businessProfile.is_setup_complete) {
    return res.redirect('/dashboard/setup');
  }

  // TODO: Create actual dashboard page
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dashboard - Your AI Solution</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50">
      <nav class="bg-white shadow-sm">
        <div class="max-w-7xl mx-auto px-4 py-4">
          <div class="flex justify-between items-center">
            <h1 class="text-xl font-bold text-blue-600">Your AI Solution</h1>
            <div class="space-x-4">
              <span>${customer.email}</span>
              <a href="/api/logout" class="text-gray-700 hover:text-blue-600">Uitloggen</a>
            </div>
          </div>
        </div>
      </nav>
      <div class="max-w-7xl mx-auto px-4 py-12">
        <h2 class="text-3xl font-bold mb-4">Welkom bij Your AI Solution!</h2>
        <p class="text-gray-600">Uw dashboard komt binnenkort beschikbaar.</p>
        <div class="mt-8">
          <a href="/dashboard/setup" class="bg-blue-600 text-white px-6 py-3 rounded-lg inline-block">Configuratie aanpassen</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Signup API
app.post('/api/signup', async (req, res) => {
  try {
    const { business_name, email, password, confirm_password, plan, terms } = req.body;

    // Validation
    if (!business_name || !email || !password || !confirm_password) {
      return res.status(400).json({ error: 'Vul alle verplichte velden in' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 karakters bevatten' });
    }

    if (password !== confirm_password) {
      return res.status(400).json({ error: 'Wachtwoorden komen niet overeen' });
    }

    if (!terms) {
      return res.status(400).json({ error: 'U moet akkoord gaan met de algemene voorwaarden' });
    }

    // Check if email already exists
    const existingCustomer = queries.findCustomerByEmail.get(email);
    if (existingCustomer) {
      return res.status(400).json({ error: 'Dit emailadres is al geregistreerd' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create customer
    const result = queries.createCustomer.run(email, hashedPassword, business_name, plan || 'professional');
    const customerId = result.lastInsertRowid;

    // Create business profile
    queries.createBusinessProfile.run(customerId, business_name);

    // Log in the user
    req.session.userId = customerId;
    req.session.userEmail = email;

    console.log(`[SIGNUP] New customer registered: ${email} (ID: ${customerId})`);

    // Send welcome email (log for now)
    console.log(`[EMAIL] Welcome email would be sent to: ${email}`);

    res.json({ success: true, redirect: '/dashboard/setup' });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Er is een fout opgetreden. Probeer het opnieuw.' });
  }
});

// Login API
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Vul alle velden in' });
    }

    // Find customer
    const customer = queries.findCustomerByEmail.get(email);
    if (!customer) {
      return res.status(401).json({ error: 'Ongeldige inloggegevens' });
    }

    // Check password
    const passwordMatch = await bcrypt.compare(password, customer.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Ongeldige inloggegevens' });
    }

    // Log in the user
    req.session.userId = customer.id;
    req.session.userEmail = customer.email;

    console.log(`[LOGIN] Customer logged in: ${email} (ID: ${customer.id})`);

    // Check if setup is complete
    const businessProfile = queries.findBusinessByCustomerId.get(customer.id);
    const redirect = (!businessProfile || !businessProfile.is_setup_complete) ? '/dashboard/setup' : '/dashboard';

    res.json({ success: true, redirect });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Er is een fout opgetreden. Probeer het opnieuw.' });
  }
});

// Logout API
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/login');
  });
});

// Get setup progress
app.get('/api/setup/progress', requireAuthAPI, (req, res) => {
  try {
    const progress = queries.findSetupProgress.get(req.session.userId);

    if (!progress) {
      return res.json({ progress: null });
    }

    res.json({ progress });
  } catch (error) {
    console.error('Error fetching setup progress:', error);
    res.status(500).json({ error: 'Er is een fout opgetreden' });
  }
});

// Save setup progress
app.post('/api/setup/progress', requireAuthAPI, (req, res) => {
  try {
    const { current_step, step1_data, step2_data, step3_data, step4_data } = req.body;

    const existing = queries.findSetupProgress.get(req.session.userId);

    if (existing) {
      queries.updateSetupProgress.run(
        current_step || existing.current_step,
        step1_data || existing.step1_data,
        step2_data || existing.step2_data,
        step3_data || existing.step3_data,
        step4_data || existing.step4_data,
        req.session.userId
      );
    } else {
      queries.createSetupProgress.run(req.session.userId, step1_data || '{}');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving setup progress:', error);
    res.status(500).json({ error: 'Er is een fout opgetreden' });
  }
});

// Complete setup
app.post('/api/setup/complete', requireAuthAPI, async (req, res) => {
  try {
    const {
      business_name,
      business_type,
      address,
      website,
      owner_phone,
      description,
      opening_hours,
      languages,
      special_rules,
      greeting_message,
      backup_phone,
      connection_method
    } = req.body;

    // Update business profile
    queries.updateBusinessProfile.run(
      business_name,
      business_type,
      address,
      website || '',
      owner_phone,
      description,
      opening_hours,
      languages,
      special_rules || '',
      greeting_message || '',
      backup_phone || owner_phone,
      connection_method,
      1, // is_setup_complete
      req.session.userId
    );

    console.log(`[SETUP] Setup completed for customer ID: ${req.session.userId}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Error completing setup:', error);
    res.status(500).json({ error: 'Er is een fout opgetreden' });
  }
});

// API endpoint to setup business info
app.post('/api/setup', (req, res) => {
  const businessInfo = req.body;

  // Validate required fields
  if (!businessInfo.businessName || !businessInfo.businessType ||
      !businessInfo.description || !businessInfo.openingHours ||
      !businessInfo.languages || businessInfo.languages.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Generate a session ID for this business
  const sessionId = generateSessionId();
  const sessionData = {
    businessInfo: businessInfo,
    createdAt: Date.now(),
    sessionId: sessionId
  };

  businessSessions.set(sessionId, sessionData);

  console.log(`[SESSION CREATED] ID: ${sessionId}`);
  console.log(`[SESSION CREATED] Business: ${businessInfo.businessName} (${businessInfo.businessType})`);
  console.log(`[SESSION CREATED] Active sessions: ${businessSessions.size}`);

  // Return success with session ID
  res.json({ success: true, sessionId: sessionId });
});

// API endpoint to get phone number for trial
app.get('/api/phone-number', (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId || !businessSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid session' });
  }

  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
    return res.status(500).json({
      error: 'Twilio is not configured. Please add your Twilio credentials to the .env file to enable phone calls.'
    });
  }

  res.json({
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    sessionId: sessionId
  });
});

// API endpoint for chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message, businessInfo, conversationHistory = [] } = req.body;

    if (!message || !businessInfo) {
      return res.status(400).json({ error: 'Message and business info are required' });
    }

    // Check if API key is configured
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'API key not configured. Please add ANTHROPIC_API_KEY to your .env file'
      });
    }

    // Build system prompt based on business info
    const systemPrompt = buildSystemPrompt(businessInfo);

    // Build conversation messages
    const messages = [
      ...conversationHistory,
      {
        role: 'user',
        content: message
      }
    ];

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });

    // Extract reply
    const reply = response.content[0].text;

    // Update conversation history
    const updatedHistory = [
      ...conversationHistory,
      {
        role: 'user',
        content: message
      },
      {
        role: 'assistant',
        content: reply
      }
    ];

    res.json({
      reply: reply,
      conversationHistory: updatedHistory
    });

  } catch (error) {
    console.error('Error calling Claude API:', error);

    if (error.status === 401) {
      res.status(500).json({ error: 'Invalid API key. Please check your ANTHROPIC_API_KEY in .env file' });
    } else if (error.status === 429) {
      res.status(500).json({ error: 'Rate limit exceeded. Please try again in a moment.' });
    } else {
      res.status(500).json({ error: 'Error processing your request. Please try again.' });
    }
  }
});

// Twilio webhook: Incoming call
app.post('/api/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To; // Which Twilio number was called
  const callStartTime = Date.now();

  console.log(`\n========== INCOMING CALL ==========`);
  console.log(`[CALL START] CallSid: ${callSid}`);
  console.log(`[CALL START] From: ${from}`);
  console.log(`[CALL START] To: ${to}`);
  console.log(`[CALL START] Time: ${new Date().toISOString()}`);

  // Prevent duplicate processing - check if this call already has a session
  if (callSessions.has(callSid)) {
    console.log(`[CALL DUPLICATE] CallSid ${callSid} already being processed. Ignoring duplicate request.`);
    const twiml = new VoiceResponse();
    return res.type('text/xml').send(twiml.toString());
  }

  const twiml = new VoiceResponse();

  // Check if this phone number has already used their trial (only if restrictions are enabled)
  if (ENABLE_TRIAL_RESTRICTIONS && trialPhoneNumbers.has(from)) {
    console.log(`[CALL REJECTED] Trial already used by ${from}`);
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Thank you for calling. You have already used your free trial. Visit youraisolution.nl to get this service for your business. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Look up session: First check if this Twilio number has a mapped session
  let sessionId = twilioNumberToSession.get(to);

  // If no mapped session, get the most recent active session
  if (!sessionId) {
    sessionId = getActiveSession();
    console.log(`[SESSION LOOKUP] No mapping for ${to}, using most recent session: ${sessionId}`);
  } else {
    console.log(`[SESSION LOOKUP] Found mapped session for ${to}: ${sessionId}`);
  }

  if (!sessionId) {
    console.log(`[CALL REJECTED] No active sessions found`);
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Welcome to Your AI Solution. Please set up your trial on our website at youraisolution.nl first, then call this number. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const sessionData = businessSessions.get(sessionId);

  if (!sessionData || !sessionData.businessInfo) {
    console.log(`[CALL ERROR] No business info found for session ${sessionId}`);
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, we could not find your business information. Please try again from the website. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const businessInfo = sessionData.businessInfo;

  // Log which business is handling this call
  console.log(`[CALL CONNECTED] Business: ${businessInfo.businessName}`);
  console.log(`[CALL CONNECTED] Type: ${businessInfo.businessType}`);
  console.log(`[CALL CONNECTED] Session: ${sessionId}`);
  console.log(`[CALL CONNECTED] Concurrent calls: ${callSessions.size + 1}`);

  // Mark this number as having used the trial (only if restrictions are enabled)
  if (ENABLE_TRIAL_RESTRICTIONS) {
    trialPhoneNumbers.add(from);
  }

  // Get primary language from business info (default to Dutch)
  let primaryLanguage = 'nl-NL';
  if (businessInfo.languages && businessInfo.languages.length > 0) {
    // Parse languages if it's a JSON string
    const languages = typeof businessInfo.languages === 'string'
      ? JSON.parse(businessInfo.languages)
      : businessInfo.languages;

    // Map language names to codes
    const langMap = {
      'Dutch': 'nl-NL',
      'English': 'en-US',
      'German': 'de-DE',
      'French': 'fr-FR',
      'Spanish': 'es-ES',
      'Arabic': 'ar-SA',
      'Turkish': 'tr-TR',
      'Polish': 'pl-PL',
      'Portuguese': 'pt-BR',
      'Italian': 'it-IT'
    };
    primaryLanguage = langMap[languages[0]] || 'nl-NL';
  }

  // Create call session (each call is independent)
  callSessions.set(callSid, {
    businessInfo: businessInfo,
    businessName: businessInfo.businessName,
    conversationHistory: [],
    startTime: callStartTime,
    from: from,
    sessionId: sessionId,
    lastLanguage: primaryLanguage, // Track the last detected language for Gather
    activeVoiceLanguage: primaryLanguage // Track the currently active voice/language
  });

  // Get welcome greeting in the business's primary language
  const greetings = {
    'nl-NL': `Hallo! Bedankt voor het bellen naar ${businessInfo.businessName}. Hoe kan ik u helpen?`,
    'en-US': `Hello! Thank you for calling ${businessInfo.businessName}. How can I help you today?`,
    'en-GB': `Hello! Thank you for calling ${businessInfo.businessName}. How can I help you today?`,
    'de-DE': `Hallo! Vielen Dank für Ihren Anruf bei ${businessInfo.businessName}. Wie kann ich Ihnen helfen?`,
    'fr-FR': `Bonjour! Merci d'avoir appelé ${businessInfo.businessName}. Comment puis-je vous aider?`,
    'es-ES': `¡Hola! Gracias por llamar a ${businessInfo.businessName}. ¿Cómo puedo ayudarte?`,
    'ar-SA': `مرحباً! شكراً لاتصالك بـ ${businessInfo.businessName}. كيف يمكنني مساعدتك؟`,
    'tr-TR': `Merhaba! ${businessInfo.businessName}'i aradığınız için teşekkür ederiz. Size nasıl yardımcı olabilirim?`,
    'pl-PL': `Cześć! Dziękujemy za telefon do ${businessInfo.businessName}. Jak mogę pomóc?`,
    'pt-BR': `Olá! Obrigado por ligar para ${businessInfo.businessName}. Como posso ajudá-lo?`,
    'it-IT': `Ciao! Grazie per aver chiamato ${businessInfo.businessName}. Come posso aiutarti?`
  };
  const welcomeGreeting = greetings[primaryLanguage] || greetings['en-US'];

  // Get the voice config for the primary language
  const voiceConfig = LANGUAGE_VOICE_MAP[primaryLanguage] || LANGUAGE_VOICE_MAP['en-US'];

  console.log(`[CALL SETUP] Primary language: ${primaryLanguage}`);
  console.log(`[CALL SETUP] Welcome voice: ${voiceConfig.voice}`);
  console.log(`[CALL SETUP] Greeting: ${welcomeGreeting}`);

  // Greet and gather speech (OLD WORKING SYSTEM)
  twiml.say({
    voice: voiceConfig.voice,
    language: voiceConfig.language
  }, welcomeGreeting);

  // Set up speech recognition for the primary language
  const speechRecognitionLang = SPEECH_RECOGNITION_MAP[primaryLanguage] || 'en-US';
  console.log(`[CALL SETUP] Speech recognition language: ${speechRecognitionLang}`);

  twiml.gather({
    input: 'speech',
    action: '/api/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    language: speechRecognitionLang // Use speech recognition language mapping
  });

  const twimlXml = twiml.toString();
  console.log(`\n========== TWIML RESPONSE ==========`);
  console.log(`[TWIML] CallSid: ${callSid}`);
  console.log(`[TWIML] Using Gather/Say (not ConversationRelay)`);
  console.log(`[TWIML] Full XML:\n${twimlXml}`);
  console.log(`========================================\n`);

  res.type('text/xml').send(twimlXml);
});

// Twilio webhook: Process speech input
app.post('/api/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  console.log(`[SPEECH INPUT] CallSid: ${callSid}`);
  console.log(`[SPEECH INPUT] Text: "${speechResult}"`);

  const twiml = new VoiceResponse();

  // Get call session
  const session = callSessions.get(callSid);

  if (session) {
    console.log(`[SPEECH INPUT] Business: ${session.businessName}`);
  }

  if (!session) {
    console.log(`[CALL END] CallSid: ${callSid}`);
    console.log(`[CALL END] Reason: Session expired or not found`);

    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, your session has expired. Please call again. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Check if 3 minutes have elapsed
  const elapsed = (Date.now() - session.startTime) / 1000 / 60; // minutes
  if (elapsed >= 3) {
    const callDuration = ((Date.now() - session.startTime) / 1000).toFixed(1); // seconds
    console.log(`[CALL END] CallSid: ${callSid}`);
    console.log(`[CALL END] Business: ${session.businessName}`);
    console.log(`[CALL END] Duration: ${callDuration}s`);
    console.log(`[CALL END] Reason: Trial time limit reached`);
    console.log(`[CALL END] Active calls remaining: ${callSessions.size - 1}`);

    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Thanks for trying Your AI Solution! Visit youraisolution.nl to get this for your business. Goodbye!');
    twiml.hangup();
    callSessions.delete(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (!speechResult) {
    // Use the session's current language for the retry message
    const currentLang = session.activeVoiceLanguage || session.lastLanguage || 'en-US';
    const currentVoiceConfig = LANGUAGE_VOICE_MAP[currentLang] || LANGUAGE_VOICE_MAP['en-US'];
    const gatherLang = SPEECH_RECOGNITION_MAP[currentLang] || 'en-US';

    const retryMessages = {
      'nl-NL': 'Sorry, ik heb dat niet verstaan. Kunt u dat herhalen?',
      'en-US': 'Sorry, I didn\'t catch that. Could you please repeat?',
      'en-GB': 'Sorry, I didn\'t catch that. Could you please repeat?',
      'de-DE': 'Entschuldigung, das habe ich nicht verstanden. Könnten Sie das bitte wiederholen?',
      'fr-FR': 'Désolé, je n\'ai pas compris. Pouvez-vous répéter?',
      'es-ES': 'Lo siento, no entendí. ¿Puedes repetir?',
      'tr-TR': 'Üzgünüm, anlayamadım. Tekrar edebilir misiniz?',
      'it-IT': 'Scusa, non ho capito. Puoi ripetere?',
      'pl-PL': 'Przepraszam, nie zrozumiałem. Czy możesz powtórzyć?',
      'pt-BR': 'Desculpe, não entendi. Pode repetir?',
      'ar-SA': 'آسف، لم أفهم ذلك. هل يمكنك التكرار؟'
    };

    twiml.say({
      voice: currentVoiceConfig.voice,
      language: currentVoiceConfig.language
    }, retryMessages[currentLang] || retryMessages['en-US']);

    twiml.gather({
      input: 'speech',
      action: '/api/voice/process',
      method: 'POST',
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      language: gatherLang
    });
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    console.log(`[CLAUDE API] Calling API for ${session.businessName}...`);
    const apiStartTime = Date.now();

    // Build system prompt with multi-language support
    const systemPrompt = buildSystemPromptForVoiceMultiLanguage(session.businessInfo);

    // Build messages
    const messages = [
      ...session.conversationHistory,
      {
        role: 'user',
        content: speechResult
      }
    ];

    // Call Claude API with timeout
    const apiTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API timeout')), 10000) // 10 second timeout
    );

    const apiCall = anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages
    });

    const response = await Promise.race([apiCall, apiTimeout]);

    const apiDuration = Date.now() - apiStartTime;
    console.log(`[CLAUDE API] Response received in ${apiDuration}ms`);

    let reply = response.content[0].text;

    // Parse language tag from Claude's response [LANG:xx-XX]
    let detectedLanguage = session.lastLanguage || 'en-US'; // Default to last language or English
    const langMatch = reply.match(/\[LANG:([\w-]+)\]/);
    if (langMatch) {
      detectedLanguage = langMatch[1];
      // Remove the language tag from the reply
      reply = reply.replace(/\[LANG:[\w-]+\]/g, '').trim();
      console.log(`[LANGUAGE] Detected from Claude: ${detectedLanguage}`);
    } else {
      console.log(`[LANGUAGE] No tag found, using default: ${detectedLanguage}`);
    }

    // Get voice config for the detected language
    const voiceConfig = LANGUAGE_VOICE_MAP[detectedLanguage] || LANGUAGE_VOICE_MAP['en-US'];
    console.log(`[VOICE] Using voice: ${voiceConfig.voice} (${voiceConfig.language})`);

    // Strip emojis and formatting before TTS (safety net)
    const cleanReply = stripEmojisAndFormatting(reply);
    console.log(`[RESPONSE] Original: ${reply}`);
    console.log(`[RESPONSE] Cleaned: ${cleanReply}`);

    // Update conversation history (keep original for context)
    session.conversationHistory.push({
      role: 'user',
      content: speechResult
    });
    session.conversationHistory.push({
      role: 'assistant',
      content: reply
    });

    // Check if language changed - if so, do professional handoff
    const currentVoiceLang = session.activeVoiceLanguage || session.lastLanguage;
    const languageChanged = detectedLanguage !== currentVoiceLang;

    if (languageChanged) {
      console.log(`[LANGUAGE SWITCH] ${currentVoiceLang} -> ${detectedLanguage}`);
      console.log(`[HANDOFF] Initiating professional colleague handoff`);

      // Get the OLD voice config (current receptionist)
      const oldVoiceConfig = LANGUAGE_VOICE_MAP[currentVoiceLang] || LANGUAGE_VOICE_MAP['en-US'];

      // Step 1: Current receptionist says handoff message in OLD language/voice
      const handoffMessage = getHandoffMessage(currentVoiceLang, detectedLanguage);
      console.log(`[HANDOFF] Old voice says: "${handoffMessage}"`);
      twiml.say({
        voice: oldVoiceConfig.voice,
        language: oldVoiceConfig.language
      }, handoffMessage);

      // Step 2: Brief pause (feels like transferring)
      twiml.pause({ length: 1 });

      // Step 3: NEW colleague greets in NEW language/voice
      const colleagueGreeting = getColleagueGreeting(detectedLanguage, session.businessName);
      console.log(`[HANDOFF] New voice (${voiceConfig.voice}) says: "${colleagueGreeting}"`);
      twiml.say({
        voice: voiceConfig.voice,
        language: voiceConfig.language
      }, colleagueGreeting);

      // Step 4: NEW colleague delivers the actual response
      if (cleanReply && cleanReply.trim().length > 0) {
        console.log(`[HANDOFF] New voice continues with response`);
        twiml.say({
          voice: voiceConfig.voice,
          language: voiceConfig.language
        }, cleanReply);
      }

      // Update the active voice language
      session.activeVoiceLanguage = detectedLanguage;
      session.lastLanguage = detectedLanguage;

    } else {
      // No language change - speak normally with the current voice
      twiml.say({
        voice: voiceConfig.voice,
        language: voiceConfig.language
      }, cleanReply);

      // Update session's last language
      session.lastLanguage = detectedLanguage;
    }

    // Check time again before gathering more input
    const newElapsed = (Date.now() - session.startTime) / 1000 / 60;
    if (newElapsed >= 3) {
      const callDuration = ((Date.now() - session.startTime) / 1000).toFixed(1); // seconds
      console.log(`[CALL END] CallSid: ${callSid}`);
      console.log(`[CALL END] Business: ${session.businessName}`);
      console.log(`[CALL END] Duration: ${callDuration}s`);
      console.log(`[CALL END] Reason: Trial time limit reached (after response)`);
      console.log(`[CALL END] Active calls remaining: ${callSessions.size - 1}`);

      twiml.say({
        voice: 'Polly.Joanna'
      }, 'Thanks for trying Your AI Solution! Visit youraisolution.nl to get this for your business. Goodbye!');
      twiml.hangup();
      callSessions.delete(callSid);
    } else {
      // Gather next speech input with the language matching the response
      // Use the updated language (after any handoff) for speech recognition
      const gatherLanguage = SPEECH_RECOGNITION_MAP[detectedLanguage] || 'en-US';
      console.log(`[GATHER] Setting speech recognition to: ${gatherLanguage}`);

      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        language: gatherLanguage // Use speech recognition language mapping
      });
    }

    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    const apiDuration = Date.now() - apiStartTime;

    // Get current language for error messages
    const currentLang = session.activeVoiceLanguage || session.lastLanguage || 'en-US';
    const currentVoiceConfig = LANGUAGE_VOICE_MAP[currentLang] || LANGUAGE_VOICE_MAP['en-US'];
    const gatherLang = SPEECH_RECOGNITION_MAP[currentLang] || 'en-US';

    const delayMessages = {
      'nl-NL': 'We ondervinden een korte vertraging. Een moment geduld alstublieft.',
      'en-US': 'We\'re experiencing a brief delay. One moment please.',
      'en-GB': 'We\'re experiencing a brief delay. One moment please.',
      'de-DE': 'Wir haben eine kurze Verzögerung. Einen Moment bitte.',
      'fr-FR': 'Nous connaissons un bref délai. Un instant s\'il vous plaît.',
      'es-ES': 'Estamos experimentando un breve retraso. Un momento por favor.',
      'tr-TR': 'Kısa bir gecikme yaşıyoruz. Bir dakika lütfen.',
      'it-IT': 'Stiamo riscontrando un breve ritardo. Un momento per favore.',
      'pl-PL': 'Doświadczamy krótkiego opóźnienia. Chwileczkę.',
      'pt-BR': 'Estamos enfrentando um breve atraso. Um momento por favor.',
      'ar-SA': 'نواجه تأخيراً قصيراً. لحظة من فضلك.'
    };

    const errorMessages = {
      'nl-NL': 'Sorry, ik heb moeite met het verwerken daarvan. Kunt u het opnieuw proberen?',
      'en-US': 'Sorry, I\'m having trouble processing that. Could you try asking again?',
      'en-GB': 'Sorry, I\'m having trouble processing that. Could you try asking again?',
      'de-DE': 'Entschuldigung, ich habe Schwierigkeiten, das zu verarbeiten. Könnten Sie es noch einmal versuchen?',
      'fr-FR': 'Désolé, j\'ai du mal à traiter cela. Pourriez-vous réessayer?',
      'es-ES': 'Lo siento, tengo problemas para procesar eso. ¿Puedes intentarlo de nuevo?',
      'tr-TR': 'Üzgünüm, bunu işlemekte zorlanıyorum. Tekrar deneyebilir misiniz?',
      'it-IT': 'Scusa, ho difficoltà a elaborare questo. Potresti riprovare?',
      'pl-PL': 'Przepraszam, mam problem z przetworzeniem tego. Czy możesz spróbować ponownie?',
      'pt-BR': 'Desculpe, estou tendo problemas para processar isso. Você poderia tentar novamente?',
      'ar-SA': 'آسف، أواجه مشكلة في معالجة ذلك. هل يمكنك المحاولة مرة أخرى؟'
    };

    // Distinguish between timeout and API errors
    if (error.message === 'API timeout') {
      console.error(`[CLAUDE API] Timeout after ${apiDuration}ms for ${session.businessName}`);
      console.error(`[CLAUDE API] CallSid: ${callSid}`);

      // Play friendly delay message instead of hanging up
      twiml.say({
        voice: currentVoiceConfig.voice,
        language: currentVoiceConfig.language
      }, delayMessages[currentLang] || delayMessages['en-US']);

      // Give them another chance to continue the conversation
      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        language: gatherLang
      });

    } else {
      // API error (not timeout)
      console.error(`[CLAUDE API] Error for ${session.businessName}:`, error.message);
      console.error(`[CLAUDE API] Status: ${error.status || 'unknown'}`);
      console.error(`[CLAUDE API] CallSid: ${callSid}`);
      console.error(`[CLAUDE API] Duration: ${apiDuration}ms`);

      // For API errors, also try to continue gracefully
      twiml.say({
        voice: currentVoiceConfig.voice,
        language: currentVoiceConfig.language
      }, errorMessages[currentLang] || errorMessages['en-US']);

      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        language: gatherLang
      });
    }

    res.type('text/xml').send(twiml.toString());
  }
});

// Helper function to strip emojis and special characters
function stripEmojisAndFormatting(text) {
  // Remove emojis (comprehensive emoji regex)
  let cleaned = text.replace(/[\u{1F600}-\u{1F64F}]/gu, ''); // Emoticons
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F5FF}]/gu, ''); // Symbols & pictographs
  cleaned = cleaned.replace(/[\u{1F680}-\u{1F6FF}]/gu, ''); // Transport & map
  cleaned = cleaned.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, ''); // Flags
  cleaned = cleaned.replace(/[\u{2600}-\u{26FF}]/gu, ''); // Misc symbols
  cleaned = cleaned.replace(/[\u{2700}-\u{27BF}]/gu, ''); // Dingbats
  cleaned = cleaned.replace(/[\u{FE00}-\u{FE0F}]/gu, ''); // Variation selectors
  cleaned = cleaned.replace(/[\u{1F900}-\u{1F9FF}]/gu, ''); // Supplemental Symbols
  cleaned = cleaned.replace(/[\u{1FA00}-\u{1FA6F}]/gu, ''); // Extended pictographs

  // Remove markdown formatting
  cleaned = cleaned.replace(/\*\*/g, ''); // Bold
  cleaned = cleaned.replace(/\*/g, ''); // Italic
  cleaned = cleaned.replace(/#{1,6}\s/g, ''); // Headers
  cleaned = cleaned.replace(/`/g, ''); // Code
  cleaned = cleaned.replace(/~~(.*?)~~/g, '$1'); // Strikethrough

  // Remove bullet points and list markers
  cleaned = cleaned.replace(/^[\s]*[-•*]\s/gm, '');
  cleaned = cleaned.replace(/^\d+\.\s/gm, '');

  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

// Helper function to build system prompt for web chat
function buildSystemPrompt(businessInfo) {
  return `You are a multilingual receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

SPECIAL RULES:
${businessInfo.specialRules}

MULTILINGUAL CAPABILITY (CRITICAL):
- You are a multilingual receptionist and can speak and write in ANY language
- If a customer writes in Dutch, reply in Dutch
- If a customer writes in English, reply in English
- If a customer writes in German, reply in German
- If a customer writes in French, Spanish, Turkish, Italian, Polish, Portuguese, Arabic, or any other language - reply in that language
- If a customer asks you to switch to a specific language, do it right away
- NEVER say you cannot speak a language - just reply naturally in their language
- Match the customer's language automatically without asking

PREVENT UNNECESSARY LANGUAGE SWITCHES (CRITICAL):
- Only switch languages when the customer CLEARLY asks for a different language OR writes a full sentence in another language
- Single foreign words like "merci", "danke", "gracias", "shukran", or "grazie" in an otherwise English/Dutch message do NOT mean they want to switch
- Example: If customer writes "Thank you, merci!" in an English conversation → Stay in English, don't switch to French
- Example: If customer writes "Bedankt! Can you speak English?" → They want English, switch to English
- Example: If customer writes "مرحبا، هل تتحدث العربية؟" (full Arabic sentence) → Switch to Arabic
- If you're unsure whether they want to switch, ask: "Would you like me to continue in [current language] or switch to [detected language]?"
- Don't switch languages on accident just because they used one polite foreign word

IMPORTANT - NO MIXED LANGUAGES (CRITICAL):
- When you reply, use ONLY ONE language in your ENTIRE response
- NEVER mix languages in the same response
- If you switch to a new language, write your ENTIRE response in that one language ONLY
- Do NOT include ANY words from other languages
- Example BAD: "Sure! نعم، يمكنني مساعدتك" (mixing English and Arabic - NEVER DO THIS)
- Example GOOD: "نعم، بالطبع! كيف يمكنني مساعدتك؟" (only Arabic - CORRECT)

CRITICAL RULE - TRANSLATE EVERYTHING IN NON-ENGLISH LANGUAGES:
- When you are writing in a non-English/non-Dutch language, your ENTIRE response must be in that language only
- NOT A SINGLE English or Dutch word is allowed
- Translate EVERYTHING: business names, service names, prices, times, days of the week, numbers, months
- Example BAD (Arabic): "نعم، نحن نقدم haircut بسعر fifty euro يوم Sunday" (contains English words - BAD!)
- Example GOOD (Arabic): "نعم، نحن نقدم قص الشعر بسعر خمسين يورو يوم الأحد" (fully translated - CORRECT!)
- Example BAD (German): "Wir sind open bis 10pm every day" (mixing German/English - BAD!)
- Example GOOD (German): "Wir sind jeden Tag bis 22 Uhr geöffnet" (fully German - CORRECT!)
- This applies to: Arabic, German, French, Spanish, Turkish, Italian, Polish, Portuguese
- English/Dutch are exceptions: When writing English or Dutch, you can use English/Dutch words normally

RECOGNIZE LANGUAGE NAME REQUESTS:
- If the customer writes a language name (in any form), treat it as a language switch request
- Language names to recognize: "Arabic", "Arabisch", "العربية", "German", "Deutsch", "Duits", "French", "Français", "Frans", "Spanish", "Español", "Spaans", "English", "Engels", "Dutch", "Nederlands", "Turkish", "Türkçe", "Turks", "Italian", "Italiano", "Italiaans", "Polish", "Polski", "Pools", "Portuguese", "Português", "Portugees"
- Even if they just write the language name alone (like "Arabic" or "Deutsch"), understand they want to switch to that language
- Respond by switching to that language immediately

COMMUNICATION STYLE:
- Keep responses SHORT and natural - maximum 2 sentences when possible
- Use casual but professional language, like a friendly receptionist
- Use contractions: "we're" not "we are", "don't" not "do not"

NATURAL LANGUAGE - VARY YOUR RESPONSES:
- NEVER use words like "certainly", "absolutely", or "of course" at the start of EVERY reply - this sounds robotic
- Vary your responses naturally like a real person would
- Use casual, warm language: "Sure!", "No problem!", "Let me check...", "Happy to help!", "Got it!"
- Sound like a friendly human, not a formal robot

YES/NO QUESTIONS - ANSWER DIRECTLY:
- If someone asks a yes/no question, START WITH THE ANSWER first, then give details if needed
- Example BAD: "We have amazing pizzas and our opening hours are..." when asked "Are you open?"
- Example GOOD: "Yes, we're open until 10pm tonight."
- Get to the point fast

BUSINESS NAME USAGE:
- Never repeat the business name in every response - it sounds unnatural
- Just answer naturally without constantly mentioning the business name
- Example BAD: "At [Business Name] we serve pizza. [Business Name] is open until 10pm."
- Example GOOD: "We serve pizza and pasta. We're open until 10pm."

FORMATTING RULES:
- NEVER say "As an AI" or mention being an AI assistant
- NEVER use emojis, bullet points, or markdown formatting
- NEVER repeat full menus or price lists unless specifically asked
- Speak in complete sentences, not lists

HANDLING REQUESTS:
- For reservations/orders: Confirm details back ("So that's a table for 4 at 7pm, correct?")
- If you don't know: "I'm not sure about that, but I can have someone get back to you. Can I take your number?"
- To close: "Is there anything else I can help with?" then "Thanks for reaching out!"

Remember: You ARE the receptionist for ${businessInfo.businessName}. Be warm, helpful, and natural.`;
}

// Helper function to build system prompt for voice calls with multi-language support
function buildSystemPromptForVoiceMultiLanguage(businessInfo) {
  return `You are a multilingual receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

SPECIAL RULES:
${businessInfo.specialRules}

MULTI-LANGUAGE CAPABILITY (CRITICAL):
- You are a multilingual receptionist and can speak ANY language the caller uses
- If the caller speaks Dutch, reply in Dutch
- If the caller speaks English, reply in English
- If the caller speaks German, reply in German
- If the caller speaks French, Spanish, Turkish, Italian, Polish, Portuguese, or Arabic - reply in that language
- NEVER say you cannot speak a language - just reply naturally in their language

PREVENT UNNECESSARY LANGUAGE SWITCHES (CRITICAL):
- Only switch languages when the caller CLEARLY asks for a different language OR speaks a full sentence in another language
- Single foreign words like "merci", "danke", "gracias", "shukran", or "grazie" in an otherwise English/Dutch sentence do NOT mean they want to switch
- Example: If caller says "Thank you, merci!" in an English conversation → Stay in English, don't switch to French
- Example: If caller says "Bedankt! Can you speak English?" → They want English, switch to English
- Example: If caller says "مرحبا، هل تتحدث العربية؟" (full Arabic sentence) → Switch to Arabic
- If you're unsure whether they want to switch, ask: "Would you like me to continue in [current language] or switch to [detected language]?"
- Don't switch languages on accident just because they used one polite foreign word

IMPORTANT - NO MIXED LANGUAGES (CRITICAL):
- When you reply, use ONLY ONE language in your ENTIRE response
- NEVER mix languages in the same response
- If you switch to a new language, write your ENTIRE response in that one language ONLY
- Do NOT include ANY words from other languages
- Example BAD response: "Sure! نعم، يمكنني مساعدتك" (mixing English and Arabic - NEVER DO THIS)
- Example GOOD response: "نعم، بالطبع! كيف يمكنني مساعدتك؟" (only Arabic - CORRECT)
- This is critical because mixed languages cause terrible voice quality

CRITICAL RULE - TRANSLATE EVERYTHING IN NON-ENGLISH LANGUAGES:
- When you are speaking in a non-English/non-Dutch language, your ENTIRE response must be in that language only
- NOT A SINGLE English or Dutch word is allowed
- Translate EVERYTHING: business names, service names, prices, times, days of the week, numbers, months
- Example BAD (Arabic): "نعم، نحن نقدم haircut بسعر fifty euro يوم Sunday" (contains English words - TERRIBLE!)
- Example GOOD (Arabic): "نعم، نحن نقدم قص الشعر بسعر خمسين يورو يوم الأحد" (fully translated - CORRECT!)
- Example BAD (German): "Wir sind open bis 10pm every day" (mixing German/English - TERRIBLE!)
- Example GOOD (German): "Wir sind jeden Tag bis 22 Uhr geöffnet" (fully German - CORRECT!)
- This applies to: Arabic, German, French, Spanish, Turkish, Italian, Polish, Portuguese
- English/Dutch are exceptions: When speaking English or Dutch, you can use English/Dutch words normally
- Why this matters: Non-English voices (like Arabic Polly.Zeina) sound HORRIBLE when trying to pronounce English words

LANGUAGE TAG INSTRUCTIONS:
- At the VERY END of your response, on a new line, add the language code like this:
  [LANG:nl-NL] for Dutch
  [LANG:en-US] for English (US)
  [LANG:en-GB] for English (UK)
  [LANG:de-DE] for German
  [LANG:fr-FR] for French
  [LANG:es-ES] for Spanish
  [LANG:tr-TR] for Turkish
  [LANG:it-IT] for Italian
  [LANG:pl-PL] for Polish
  [LANG:pt-BR] for Portuguese
  [LANG:ar-SA] for Arabic
- This language tag MUST always be the last line of your response

HANDLE GARBLED INPUT - OFFER LANGUAGE TRANSFER (CRITICAL):
- If you receive input that looks like nonsense, random syllables, or words that don't make sense (like "Aib", "Ablass Banion", "and so is" when it should be Arabic, or garbled text that seems wrong), this probably means the caller is speaking a different language that the speech recognition couldn't understand properly
- In this case, do NOT say "can you repeat that" or "I didn't catch that" - this is useless because the speech recognition language is wrong so it will never understand
- Instead, offer a language transfer in the CURRENT active language of the call
- Example responses (choose based on current language):
  English: "It sounds like you might be speaking a different language. I can transfer you to a colleague. Which language do you prefer? For example: Dutch, German, Arabic, French, Spanish, or Turkish."
  Dutch: "Het lijkt erop dat u mogelijk een andere taal spreekt. Ik kan u doorverbinden met een collega. Welke taal heeft u de voorkeur? Bijvoorbeeld: Engels, Duits, Arabisch, Frans, Spaans, of Turks."
  German: "Es klingt, als würden Sie möglicherweise eine andere Sprache sprechen. Ich kann Sie zu einem Kollegen durchstellen. Welche Sprache bevorzugen Sie? Zum Beispiel: Englisch, Niederländisch, Arabisch, Französisch, Spanisch oder Türkisch."
  Arabic: "يبدو أنك قد تتحدث لغة أخرى. يمكنني تحويلك إلى زميل. ما هي اللغة التي تفضلها؟ على سبيل المثال: الإنجليزية، الهولندية، الألمانية، الفرنسية، الإسبانية، أو التركية."
  French: "Il semble que vous parliez peut-être une autre langue. Je peux vous transférer à un collègue. Quelle langue préférez-vous ? Par exemple : anglais, néerlandais, allemand, arabe, espagnol ou turc."
  Spanish: "Parece que podría estar hablando otro idioma. Puedo transferirle a un colega. ¿Qué idioma prefiere? Por ejemplo: inglés, neerlandés, alemán, árabe, francés o turco."
  Turkish: "Başka bir dil konuşuyor olabilirsiniz. Sizi bir meslektaşıma aktarabilirim. Hangi dili tercih edersiniz? Örneğin: İngilizce, Hollandaca, Almanca, Arapça, Fransızca veya İspanyolca."

RECOGNIZE LANGUAGE NAME REQUESTS (CRITICAL):
- If the caller says a language name (in any form), treat it as a language switch request
- Language names to recognize: "Arabic", "Arabisch", "العربية", "arabi", "German", "Deutsch", "Duits", "French", "Français", "Frans", "Spanish", "Español", "Spaans", "English", "Engels", "Dutch", "Nederlands", "Turkish", "Türkçe", "Turks", "Italian", "Italiano", "Italiaans", "Polish", "Polski", "Pools", "Portuguese", "Português", "Portugees"
- Even if they just say the language name alone (like "Arabic" or "Deutsch"), understand they want to switch to that language
- Respond by switching to that language immediately (the colleague handoff will happen automatically)

PHONE CALL COMMUNICATION STYLE (CRITICAL):
- This is a PHONE CALL, not a text message
- Keep your answers SHORT - maximum 2 sentences when possible. Long responses feel unnatural on the phone.
- Speak naturally like a friendly, professional receptionist would on the phone
- Use contractions: "we're" not "we are", "don't" not "do not"

NATURAL LANGUAGE - VARY YOUR RESPONSES (CRITICAL):
- NEVER use words like "certainly", "absolutely", or "of course" at the start of EVERY reply - this sounds robotic
- Vary your responses naturally like a real person would
- Use casual, warm language: "Sure!", "No problem!", "Let me check...", "Happy to help!", "Got it!"
- Example: Instead of always saying "Certainly, I can help with that" → say "Sure!", "No problem!", "Happy to!", "Let me check..."
- Sound like a friendly human, not a formal robot

YES/NO QUESTIONS - ANSWER DIRECTLY (CRITICAL):
- If someone asks a yes/no question, START WITH THE ANSWER first, then give details if needed
- Example BAD: "We have amazing pizzas and our opening hours are..." when asked "Are you open?"
- Example GOOD: "Yes, we're open until 10pm tonight."
- Get to the point fast - this is a phone call, not an essay

BUSINESS NAME USAGE:
- Never repeat the business name in every response - it sounds unnatural
- Say the business name ONCE in the greeting, then just answer naturally
- Example BAD: "At [Business Name] we serve pizza. [Business Name] is open until 10pm."
- Example GOOD: "We serve pizza and pasta. We're open until 10pm."

FORMATTING RULES:
- NEVER say "As an AI" or "I'm an AI assistant" - just answer naturally
- NEVER use emojis (you're speaking, not texting!)
- NEVER use bullet points or numbered lists - speak in normal sentences
- NEVER use markdown formatting like asterisks or hashtags
- NEVER repeat full menus or price lists unless specifically asked - give relevant info only

HANDLING REQUESTS:
- For reservations/orders: Confirm details back to them ("So that's a large pepperoni and two colas, is that right?")
- If you don't know something: "I'm not sure about that, but I can have someone from the team get back to you. Can I take your number?"
- To close conversation: "Is there anything else I can help with?" then "Thanks for calling, have a great day!"

Remember: You ARE the receptionist for ${businessInfo.businessName}. Sound warm, natural, and professional like a real person on the phone.`;
}

// Helper function to generate session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Start server
app.listen(PORT, () => {
  console.log(`Your AI Solution server is running on http://localhost:${PORT}`);
});
