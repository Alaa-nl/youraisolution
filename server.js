require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
const PORT = process.env.PORT || 3000;

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

// In-memory storage for call sessions and trial tracking
const callSessions = new Map(); // CallSid -> { businessInfo, conversationHistory, startTime }
const trialPhoneNumbers = new Set(); // Phone numbers that have used their free trial
const businessSessions = new Map(); // SessionId -> businessInfo (for linking form to call)
let activeSessionId = null; // The session ID for the next incoming call

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
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
  businessSessions.set(sessionId, businessInfo);

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

  // Set this as the active session for incoming calls
  activeSessionId = sessionId;

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

  console.log(`Incoming call from ${from}, CallSid: ${callSid}, Active SessionId: ${activeSessionId}`);

  const twiml = new VoiceResponse();

  // Check if this phone number has already used their trial
  if (trialPhoneNumbers.has(from)) {
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Thank you for calling. You have already used your free trial. Visit youraisolution.nl to get this service for your business. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Get business info from active session
  if (!activeSessionId) {
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Welcome to Your AI Solution. Please set up your trial on our website at youraisolution.nl first, then call this number. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const businessInfo = businessSessions.get(activeSessionId);

  if (!businessInfo) {
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, we could not find your business information. Please try again from the website. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Mark this number as having used the trial
  trialPhoneNumbers.add(from);

  // Create call session
  callSessions.set(callSid, {
    businessInfo: businessInfo,
    conversationHistory: [],
    startTime: Date.now(),
    from: from
  });

  // Greet and gather speech
  const businessName = businessInfo.businessName;
  twiml.say({
    voice: 'Polly.Joanna'
  }, `Hello! Thank you for calling ${businessName}. How can I help you today?`);

  twiml.gather({
    input: 'speech',
    action: '/api/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call'
  });

  res.type('text/xml').send(twiml.toString());
});

// Twilio webhook: Process speech input
app.post('/api/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  console.log(`Processing speech for CallSid: ${callSid}, Speech: ${speechResult}`);

  const twiml = new VoiceResponse();

  // Get call session
  const session = callSessions.get(callSid);

  if (!session) {
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, your session has expired. Please call again. Goodbye!');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Check if 3 minutes have elapsed
  const elapsed = (Date.now() - session.startTime) / 1000 / 60; // minutes
  if (elapsed >= 3) {
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

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages
    });

    const reply = response.content[0].text;

    // Update conversation history
    session.conversationHistory.push({
      role: 'user',
      content: speechResult
    });
    session.conversationHistory.push({
      role: 'assistant',
      content: reply
    });

    // Speak the response
    twiml.say({
      voice: 'Polly.Joanna'
    }, reply);

    // Check time again before gathering more input
    const newElapsed = (Date.now() - session.startTime) / 1000 / 60;
    if (newElapsed >= 3) {
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
    console.error('Error processing speech:', error);
    twiml.say({
      voice: 'Polly.Joanna'
    }, 'Sorry, I encountered an error. Please try again later. Goodbye!');
    twiml.hangup();
    callSessions.delete(callSid);
    res.type('text/xml').send(twiml.toString());
  }
});

// Helper function to build system prompt
function buildSystemPrompt(businessInfo) {
  const languageText = businessInfo.languages.join(' and ');

  return `You are an AI receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

LANGUAGES:
You can communicate in ${languageText}. If the customer writes in one of these languages, respond in the same language.

SPECIAL RULES:
${businessInfo.specialRules}

YOUR ROLE:
- Be friendly, professional, and helpful
- Answer questions about the business, services, prices, and availability
- Help customers book appointments or make reservations when requested
- Provide accurate information based on the business details above
- If you don't know something, be honest and offer to help in another way
- Stay in character as the receptionist for ${businessInfo.businessName}
- Keep responses concise and conversational

Remember: You represent ${businessInfo.businessName}. Be welcoming and make customers feel valued.`;
}

// Helper function to build system prompt for voice calls
function buildSystemPromptForVoice(businessInfo) {
  const languageText = businessInfo.languages.join(' and ');

  return `You are an AI receptionist for ${businessInfo.businessName}, a ${businessInfo.businessType}.

BUSINESS INFORMATION:
${businessInfo.description}

OPENING HOURS:
${businessInfo.openingHours}

LANGUAGES:
You can communicate in ${languageText}. If the customer speaks in one of these languages, respond in the same language.

SPECIAL RULES:
${businessInfo.specialRules}

YOUR ROLE:
- Be friendly, professional, and helpful
- Answer questions about the business, services, prices, and availability
- Help customers book appointments or make reservations when requested
- Provide accurate information based on the business details above
- If you don't know something, be honest and offer to help in another way
- Stay in character as the receptionist for ${businessInfo.businessName}
- Keep responses VERY BRIEF and conversational (1-3 sentences max) - this is a phone call
- Speak naturally as if you're having a phone conversation

Remember: You represent ${businessInfo.businessName}. Be welcoming and make customers feel valued.`;
}

// Helper function to generate session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Start server
app.listen(PORT, () => {
  console.log(`Your AI Solution server is running on http://localhost:${PORT}`);
});
