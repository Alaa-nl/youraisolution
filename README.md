# Your AI Solution - AI Receptionist Service

An AI-powered receptionist that handles customer inquiries via chat and phone calls 24/7.

## Features

- 🤖 **AI Chat Interface**: Test your AI receptionist through a web chat interface
- 📞 **Voice Call Integration**: Speak with your AI receptionist via phone using Twilio
- 🌐 **Multi-language Support**: Dutch and English language capabilities
- ⏱️ **Free Trial**: 3-minute phone call trial (one per phone number)
- 🎯 **Custom Business Context**: AI responds based on your specific business information

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the `.env.example` file to `.env`:

```bash
cp .env.example .env
```

Then fill in your credentials in the `.env` file:

```env
# Server Configuration
PORT=3000

# Anthropic API Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Twilio Configuration (for voice calls)
TWILIO_ACCOUNT_SID=your_twilio_account_sid_here
TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
TWILIO_PHONE_NUMBER=+1234567890
```

### 3. Set Up Twilio (Required for Phone Calls)

1. **Create a Twilio Account**: Sign up at [twilio.com](https://www.twilio.com/)

2. **Get a Phone Number**:
   - Go to Phone Numbers → Buy a number
   - Choose a number with Voice capabilities
   - Copy the phone number

3. **Configure Webhook**:
   - For local development, use [ngrok](https://ngrok.com/) to expose your localhost:
     ```bash
     ngrok http 3000
     ```
   - Copy the HTTPS URL from ngrok (e.g., `https://abc123.ngrok.io`)
   - Go to your Twilio phone number settings
   - Under "Voice & Fax" → "A Call Comes In":
     - Select "Webhook"
     - Enter: `https://your-ngrok-url.ngrok.io/api/voice/incoming`
     - Method: `HTTP POST`
   - Click Save

4. **Add Twilio Credentials to .env**:
   - Account SID: Found in Twilio Console dashboard
   - Auth Token: Found in Twilio Console dashboard
   - Phone Number: The number you purchased (format: +1234567890)

### 4. Get Anthropic API Key

1. Sign up at [console.anthropic.com](https://console.anthropic.com/)
2. Go to Settings → API Keys
3. Create a new API key
4. Add credits to your account (Plans & Billing)
5. Copy the API key to your `.env` file

### 5. Start the Server

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

The server will run at `http://localhost:3000`

## Usage

### Web Chat Interface

1. Open `http://localhost:3000` in your browser
2. Fill in your business information:
   - Business name
   - Business type
   - Description (menu, services, prices)
   - Opening hours
   - Languages
   - Special rules
3. Click "Start Testing Your AI Receptionist"
4. Chat with your AI agent

### Phone Call Feature

1. After setting up your business in the chat interface
2. Click "Try a Phone Call with Your AI Agent"
3. Dial the displayed phone number
4. Speak with your AI receptionist
5. Free trial: 3 minutes per phone number

## How It Works

### Chat Interface
- Frontend captures business info
- Sends to `/api/chat` endpoint
- Claude Haiku 4.5 generates responses based on business context
- Maintains conversation history

### Voice Calls
- Twilio receives incoming call
- Webhook `/api/voice/incoming` handles the call
- Twilio converts speech to text
- Text sent to Claude Haiku 4.5 with business context
- Claude's response converted to speech via Twilio
- 3-minute time limit enforced
- One trial per phone number

## Project Structure

```
youraisolution/
├── public/
│   └── index.html          # Frontend UI
├── server.js               # Express server & API endpoints
├── package.json            # Dependencies
├── .env                    # Environment variables (not in git)
├── .env.example           # Environment template
└── README.md              # This file
```

## API Endpoints

- `POST /api/setup` - Setup business information
- `GET /api/phone-number` - Get phone number for trial
- `POST /api/chat` - Send chat message to AI
- `POST /api/voice/incoming` - Twilio webhook for incoming calls
- `POST /api/voice/process` - Twilio webhook for speech processing

## Technologies Used

- **Backend**: Node.js, Express.js
- **AI**: Anthropic Claude Haiku 4.5
- **Voice**: Twilio Voice API
- **Frontend**: Tailwind CSS, Vanilla JavaScript
- **Environment**: dotenv

## Notes

- The in-memory storage is reset when the server restarts
- For production, implement persistent storage (database)
- Twilio requires HTTPS webhooks (use ngrok for local dev)
- Each phone number can only use the free trial once per server session

## Troubleshooting

### "Your credit balance is too low" error
- Add credits to your Anthropic account at console.anthropic.com

### Phone calls not working
- Check that ngrok is running and URL is configured in Twilio
- Verify Twilio credentials in .env file
- Check server logs for errors

### Chat not working
- Verify ANTHROPIC_API_KEY in .env file
- Check that you have credits in your Anthropic account
- Look at browser console for errors

## License

ISC
