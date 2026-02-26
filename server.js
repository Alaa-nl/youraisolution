require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const bcrypt = require('bcrypt');
const session = require('express-session');
const database = require('./database');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

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
const callSessions = new Map(); // CallSid -> { businessInfo, conversationHistory, startTime, businessName, from, currentLanguage, lastDetectedLanguage, languageDetectionCount }
const trialPhoneNumbers = new Set(); // Phone numbers that have used their free trial
const businessSessions = new Map(); // SessionId -> { businessInfo, createdAt, sessionId }
const twilioNumberToSession = new Map(); // Twilio number -> SessionId mapping for multi-number support

// Create WebSocket server for ConversationRelay
const wss = new WebSocket.Server({ noServer: true });

// Language configuration for ConversationRelay
const LANGUAGE_CONFIG = {
  'nl-NL': { voice: 'Lotte', provider: 'Amazon' },
  'en-US': { voice: 'Salli', provider: 'Amazon' },
  'en-GB': { voice: 'Amy', provider: 'Amazon' },
  'de-DE': { voice: 'Marlene', provider: 'Amazon' },
  'fr-FR': { voice: 'Celine', provider: 'Amazon' },
  'es-ES': { voice: 'Conchita', provider: 'Amazon' },
  'ar-SA': { voice: 'Zeina', provider: 'Amazon' },
  'tr-TR': { voice: 'Filiz', provider: 'Amazon' },
  'pl-PL': { voice: 'Ewa', provider: 'Amazon' },
  'pt-BR': { voice: 'Vitoria', provider: 'Amazon' },
  'it-IT': { voice: 'Carla', provider: 'Amazon' }
};

// Map simplified language codes to full language codes
const LANGUAGE_CODE_MAP = {
  'nl': 'nl-NL',
  'en': 'en-US',
  'de': 'de-DE',
  'fr': 'fr-FR',
  'es': 'es-ES',
  'ar': 'ar-SA',
  'tr': 'tr-TR',
  'pl': 'pl-PL',
  'pt': 'pt-BR',
  'it': 'it-IT'
};

console.log(`Trial restrictions: ${ENABLE_TRIAL_RESTRICTIONS ? 'ENABLED' : 'DISABLED (Testing Mode)'}`);

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
    currentLanguage: primaryLanguage,
    lastDetectedLanguage: null,
    languageDetectionCount: 0
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

  // Determine the correct WebSocket host
  // Use environment variable for production, fall back to request host
  const wsHost = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.WS_HOST || req.headers.host || 'youraisolution.onrender.com';
  const wsUrl = `wss://${wsHost}/api/voice/websocket?CallSid=${callSid}`;

  console.log(`[CALL SETUP] WebSocket host: ${wsHost}`);
  console.log(`[CALL SETUP] WebSocket URL: ${wsUrl}`);

  // Create ConversationRelay with multi-language support
  const connect = twiml.connect();
  const conversationRelay = connect.conversationRelay({
    url: wsUrl,
    language: 'multi', // Start with multi-language detection enabled
    ttsProvider: 'Amazon',
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-2-general',
    welcomeGreeting: welcomeGreeting,
    voice: LANGUAGE_CONFIG[primaryLanguage].voice // Use primary language voice for greeting
  });

  // Add all supported languages
  Object.keys(LANGUAGE_CONFIG).forEach(langCode => {
    const config = LANGUAGE_CONFIG[langCode];
    conversationRelay.language({
      code: langCode,
      voice: config.voice,
      ttsProvider: 'Amazon',
      transcriptionProvider: 'Deepgram',
      speechModel: 'nova-2-general'
    });
  });

  const twimlXml = twiml.toString();
  console.log(`\n========== TWIML RESPONSE ==========`);
  console.log(`[TWIML] CallSid: ${callSid}`);
  console.log(`[TWIML] WebSocket URL: ${wsUrl}`);
  console.log(`[TWIML] Primary Language: ${primaryLanguage}`);
  console.log(`[TWIML] Welcome Greeting: ${welcomeGreeting}`);
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
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, I didn\'t catch that. Could you please repeat?');
    twiml.gather({
      input: 'speech',
      action: '/api/voice/process',
      method: 'POST',
      speechTimeout: 'auto',
      speechModel: 'phone_call'
    });
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    console.log(`[CLAUDE API] Calling API for ${session.businessName}...`);
    const apiStartTime = Date.now();

    // Build system prompt
    const systemPrompt = buildSystemPromptForVoice(session.businessInfo);

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

    const reply = response.content[0].text;

    // Strip emojis and formatting before TTS (safety net)
    const cleanReply = stripEmojisAndFormatting(reply);
    console.log(`Original reply: ${reply}`);
    console.log(`Cleaned reply: ${cleanReply}`);

    // Update conversation history (keep original for context)
    session.conversationHistory.push({
      role: 'user',
      content: speechResult
    });
    session.conversationHistory.push({
      role: 'assistant',
      content: reply
    });

    // Speak the CLEANED response (no emojis!)
    twiml.say({
      voice: 'Polly.Joanna'
    }, cleanReply);

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
      // Gather next speech input
      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });
    }

    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    const apiDuration = Date.now() - apiStartTime;

    // Distinguish between timeout and API errors
    if (error.message === 'API timeout') {
      console.error(`[CLAUDE API] Timeout after ${apiDuration}ms for ${session.businessName}`);
      console.error(`[CLAUDE API] CallSid: ${callSid}`);

      // Play friendly delay message instead of hanging up
      twiml.say({
        voice: 'Polly.Joanna'
      }, 'We\'re experiencing a brief delay. One moment please.');

      // Give them another chance to continue the conversation
      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call'
      });

    } else {
      // API error (not timeout)
      console.error(`[CLAUDE API] Error for ${session.businessName}:`, error.message);
      console.error(`[CLAUDE API] Status: ${error.status || 'unknown'}`);
      console.error(`[CLAUDE API] CallSid: ${callSid}`);
      console.error(`[CLAUDE API] Duration: ${apiDuration}ms`);

      // For API errors, also try to continue gracefully
      twiml.say({
        voice: 'Polly.Joanna'
      }, 'Sorry, I\'m having trouble processing that. Could you try asking again?');

      twiml.gather({
        input: 'speech',
        action: '/api/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        speechModel: 'phone_call'
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
  const languageText = businessInfo.languages.join(' and ');

  return `You are the receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

LANGUAGES:
Communicate in ${languageText}. Match the customer's language - if they write in Dutch, respond in Dutch. If English, respond in English.

SPECIAL RULES:
${businessInfo.specialRules}

COMMUNICATION STYLE:
- Keep responses short and natural (2-3 sentences maximum)
- Use casual but professional language, like a friendly receptionist
- Use contractions: "we're" not "we are", "don't" not "do not"
- Use natural filler phrases: "Sure!", "Of course!", "Let me check that"
- NEVER say "As an AI" or mention being an AI assistant
- NEVER use emojis, bullet points, or markdown formatting
- NEVER repeat full menus or price lists unless specifically asked
- Speak in complete sentences, not lists

HANDLING REQUESTS:
- For reservations/orders: Confirm details back ("So that's a table for 4 at 7pm, correct?")
- If you don't know: "I'm not sure about that, but I can have someone get back to you. Can I take your number?"
- To close: "Is there anything else I can help with?" then "Thanks for reaching out!"
- Match the customer's language automatically

Remember: You ARE the receptionist for ${businessInfo.businessName}. Be warm, helpful, and natural.`;
}

// Helper function to build system prompt for voice calls
function buildSystemPromptForVoice(businessInfo) {
  const languageText = businessInfo.languages.join(' and ');

  return `You are the receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

LANGUAGES:
Speak in ${languageText}. Match the caller's language automatically - if they speak Dutch, respond in Dutch. If English, respond in English.

SPECIAL RULES:
${businessInfo.specialRules}

PHONE CALL COMMUNICATION STYLE (CRITICAL):
- This is a PHONE CALL, not a text message
- Keep responses VERY short: 2-3 sentences maximum
- Speak naturally like a friendly, professional receptionist would on the phone
- Use contractions: "we're" not "we are", "don't" not "do not"
- Use short natural filler words: "Sure!", "Of course!", "Let me check that for you", "Great question"
- Greeting example: "Hi, thanks for calling ${businessInfo.businessName}, how can I help you?"
- NEVER say "As an AI" or "I'm an AI assistant" - just answer naturally
- NEVER use emojis (you're speaking, not texting!)
- NEVER use bullet points or numbered lists - speak in normal sentences
- NEVER use markdown formatting like asterisks or hashtags
- NEVER repeat full menus or price lists unless specifically asked - give relevant info only
- Use contractions to sound more natural when spoken

HANDLING REQUESTS:
- For reservations/orders: Confirm details back to them ("So that's a large pepperoni and two colas, is that right?")
- If you don't know something: "I'm not sure about that, but I can have someone from the team get back to you. Can I take your number?"
- To close conversation: "Is there anything else I can help with?" then "Thanks for calling, have a great day!"
- Match the caller's language automatically without asking

Remember: You ARE the receptionist for ${businessInfo.businessName}. Sound warm, natural, and professional like a real person on the phone.`;
}

// Helper function to build system prompt for voice calls with specific language
function buildSystemPromptForVoiceWithLanguage(businessInfo, targetLanguage) {
  return `You are the receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

ACTIVE LANGUAGE:
Reply in ${targetLanguage}. The system has detected the caller is speaking ${targetLanguage}.

LANGUAGE SWITCHING:
If the caller explicitly asks you to speak a different language (e.g., "Can you speak English?", "Spreek je Nederlands?"), reply naturally in that language. Also include this JSON at the end of your response: {"detected_language": "xx"} where xx is the two-letter language code (nl, en, de, fr, es, ar, tr, pl, pt, it).

SPECIAL RULES:
${businessInfo.specialRules}

PHONE CALL COMMUNICATION STYLE (CRITICAL):
- This is a PHONE CALL, not a text message
- Keep responses VERY short: 2-3 sentences maximum
- Speak naturally like a friendly, professional receptionist would on the phone
- Use contractions: "we're" not "we are", "don't" not "do not"
- Use short natural filler words: "Sure!", "Of course!", "Let me check that for you", "Great question"
- NEVER say "As an AI" or "I'm an AI assistant" - just answer naturally
- NEVER use emojis (you're speaking, not texting!)
- NEVER use bullet points or numbered lists - speak in normal sentences
- NEVER use markdown formatting like asterisks or hashtags
- NEVER repeat full menus or price lists unless specifically asked - give relevant info only
- NEVER announce language switches - just naturally continue in the requested language
- Use contractions to sound more natural when spoken

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

// Helper function to get language name from code
function getLanguageName(code) {
  const names = {
    'nl-NL': 'Dutch', 'nl': 'Dutch',
    'en-US': 'English', 'en-GB': 'English', 'en': 'English',
    'de-DE': 'German', 'de': 'German',
    'fr-FR': 'French', 'fr': 'French',
    'es-ES': 'Spanish', 'es': 'Spanish',
    'ar-SA': 'Arabic', 'ar': 'Arabic',
    'tr-TR': 'Turkish', 'tr': 'Turkish',
    'pl-PL': 'Polish', 'pl': 'Polish',
    'pt-BR': 'Portuguese', 'pt': 'Portuguese',
    'it-IT': 'Italian', 'it': 'Italian'
  };
  return names[code] || 'English';
}

// Helper function to send language switch message to Twilio
function sendLanguageSwitch(ws, languageCode) {
  const message = {
    type: 'language',
    ttsLanguage: languageCode,
    transcriptionLanguage: languageCode
  };
  ws.send(JSON.stringify(message));
  console.log(`[LANGUAGE SWITCH] Switching to ${languageCode}`);
}

// WebSocket handler for ConversationRelay
wss.on('connection', (ws, req) => {
  // Extract CallSid from query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('CallSid');

  if (!callSid) {
    console.log('[WS ERROR] No CallSid provided');
    ws.close();
    return;
  }

  console.log(`[WS CONNECTED] CallSid: ${callSid}`);

  const session = callSessions.get(callSid);
  if (!session) {
    console.log(`[WS ERROR] No session found for CallSid: ${callSid}`);
    ws.close();
    return;
  }

  console.log(`[WS] Business: ${session.businessName}`);

  // Handle incoming messages from Twilio
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle prompt messages (caller's speech)
      if (message.type === 'prompt') {
        const voicePrompt = message.voicePrompt;
        const detectedLang = message.lang; // Will be simplified code like "en" not "en-US" when using multi

        console.log(`[WS PROMPT] Text: "${voicePrompt}"`);
        console.log(`[WS PROMPT] Detected language: ${detectedLang}`);

        // Check time limit
        const elapsed = (Date.now() - session.startTime) / 1000 / 60; // minutes
        if (elapsed >= 3) {
          const textMessage = {
            type: 'text',
            token: 'Thanks for trying Your AI Solution! Visit youraisolution.nl to get this for your business. Goodbye!',
            last: true
          };
          ws.send(JSON.stringify(textMessage));

          const callDuration = ((Date.now() - session.startTime) / 1000).toFixed(1);
          console.log(`[CALL END] CallSid: ${callSid}`);
          console.log(`[CALL END] Business: ${session.businessName}`);
          console.log(`[CALL END] Duration: ${callDuration}s`);
          console.log(`[CALL END] Reason: Trial time limit reached`);

          callSessions.delete(callSid);
          ws.close();
          return;
        }

        // Language detection logic: switch only if 2 consecutive messages are in a different language
        if (detectedLang) {
          const fullLangCode = LANGUAGE_CODE_MAP[detectedLang] || detectedLang;

          if (fullLangCode !== session.currentLanguage) {
            // Check if this is the same language as last detection
            if (session.lastDetectedLanguage === fullLangCode) {
              session.languageDetectionCount++;

              // Switch language after 2 consecutive detections
              if (session.languageDetectionCount >= 2) {
                console.log(`[LANGUAGE] Switching from ${session.currentLanguage} to ${fullLangCode}`);
                session.currentLanguage = fullLangCode;
                session.languageDetectionCount = 0;
                session.lastDetectedLanguage = null;

                // Send language switch message to Twilio
                sendLanguageSwitch(ws, fullLangCode);
              }
            } else {
              // Different language detected, start counting
              session.lastDetectedLanguage = fullLangCode;
              session.languageDetectionCount = 1;
            }
          } else {
            // Same as current language, reset detection
            session.lastDetectedLanguage = null;
            session.languageDetectionCount = 0;
          }
        }

        // Build system prompt with current language
        const languageName = getLanguageName(session.currentLanguage);
        const systemPrompt = buildSystemPromptForVoiceWithLanguage(session.businessInfo, languageName);

        // Build messages
        const messages = [
          ...session.conversationHistory,
          {
            role: 'user',
            content: voicePrompt
          }
        ];

        // Call Claude API
        try {
          console.log(`[CLAUDE API] Calling API for ${session.businessName}...`);
          const apiStartTime = Date.now();

          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 300,
            system: systemPrompt,
            messages: messages
          });

          const apiDuration = Date.now() - apiStartTime;
          console.log(`[CLAUDE API] Response received in ${apiDuration}ms`);

          const reply = response.content[0].text;

          // Check if Claude detected a language switch request
          let detectedLanguageFromClaude = null;
          try {
            const jsonMatch = reply.match(/\{[^}]*"detected_language"[^}]*\}/);
            if (jsonMatch) {
              const jsonData = JSON.parse(jsonMatch[0]);
              detectedLanguageFromClaude = jsonData.detected_language;
            }
          } catch (e) {
            // No JSON found, that's okay
          }

          // If Claude detected a language switch, apply it
          if (detectedLanguageFromClaude && LANGUAGE_CODE_MAP[detectedLanguageFromClaude]) {
            const newLang = LANGUAGE_CODE_MAP[detectedLanguageFromClaude];
            if (newLang !== session.currentLanguage) {
              console.log(`[LANGUAGE] Claude detected switch request to ${newLang}`);
              session.currentLanguage = newLang;
              sendLanguageSwitch(ws, newLang);
            }
          }

          // Remove JSON metadata from reply before sending
          const cleanReply = reply.replace(/\{[^}]*"detected_language"[^}]*\}/g, '').trim();

          // Strip emojis and formatting for TTS
          const ttsReply = stripEmojisAndFormatting(cleanReply);

          // Update conversation history
          session.conversationHistory.push({
            role: 'user',
            content: voicePrompt
          });
          session.conversationHistory.push({
            role: 'assistant',
            content: reply
          });

          // Send text response to Twilio (will be converted to speech)
          const textMessage = {
            type: 'text',
            token: ttsReply,
            last: true
          };
          ws.send(JSON.stringify(textMessage));

        } catch (error) {
          console.error(`[CLAUDE API] Error for ${session.businessName}:`, error.message);

          // Send error message
          const errorMessage = {
            type: 'text',
            token: "I'm having trouble processing that. Could you try asking again?",
            last: true
          };
          ws.send(JSON.stringify(errorMessage));
        }
      }

      // Handle other message types (interrupt, dtmf, etc.)
      if (message.type === 'interrupt') {
        console.log(`[WS INTERRUPT] CallSid: ${callSid}`);
      }

    } catch (error) {
      console.error('[WS ERROR] Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`[WS CLOSED] CallSid: ${callSid}`);
    callSessions.delete(callSid);
  });

  ws.on('error', (error) => {
    console.error(`[WS ERROR] CallSid: ${callSid}`, error);
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  console.log(`[WS UPGRADE] Upgrade request received for: ${request.url}`);
  console.log(`[WS UPGRADE] Host: ${request.headers.host}`);
  console.log(`[WS UPGRADE] Origin: ${request.headers.origin}`);

  const url = new URL(request.url, `http://${request.headers.host}`);
  console.log(`[WS UPGRADE] Parsed pathname: ${url.pathname}`);

  if (url.pathname === '/api/voice/websocket') {
    console.log(`[WS UPGRADE] Path matches! Handling upgrade...`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`[WS UPGRADE] Upgrade successful! Emitting connection event...`);
      wss.emit('connection', ws, request);
    });
  } else {
    console.log(`[WS UPGRADE] Path does not match. Destroying socket. Expected: /api/voice/websocket, Got: ${url.pathname}`);
    socket.destroy();
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Your AI Solution server is running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}/api/voice/websocket`);
});
