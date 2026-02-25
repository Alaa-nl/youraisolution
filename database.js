const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const db = new Database(path.join(__dirname, 'youraisolution.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
function initializeDatabase() {
  // Customers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      business_name TEXT NOT NULL,
      plan TEXT DEFAULT 'starter' CHECK(plan IN ('starter', 'professional', 'business')),
      status TEXT DEFAULT 'trial' CHECK(status IN ('trial', 'active', 'cancelled')),
      trial_ends_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Business profiles table
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      business_name TEXT NOT NULL,
      business_type TEXT,
      address TEXT,
      website TEXT,
      owner_phone TEXT,
      description TEXT,
      opening_hours TEXT,
      languages TEXT,
      special_rules TEXT,
      greeting_message TEXT,
      backup_phone TEXT,
      connection_method TEXT CHECK(connection_method IN ('forward_existing', 'new_number')),
      twilio_number TEXT,
      is_setup_complete INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  // Conversations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('call', 'chat', 'whatsapp')),
      caller_number TEXT,
      summary TEXT,
      full_transcript TEXT,
      duration_seconds INTEGER,
      action_taken TEXT CHECK(action_taken IN ('info_given', 'appointment_booked', 'transferred', 'callback_requested')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE
    )
  `);

  // Appointments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      service TEXT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration_minutes INTEGER,
      status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled', 'completed')),
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE
    )
  `);

  // Callback requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS callback_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      reason TEXT,
      is_handled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE
    )
  `);

  // Setup progress table (for multi-step wizard)
  db.exec(`
    CREATE TABLE IF NOT EXISTS setup_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL UNIQUE,
      current_step INTEGER DEFAULT 1,
      step1_data TEXT,
      step2_data TEXT,
      step3_data TEXT,
      step4_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_business_profiles_customer ON business_profiles(customer_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_business ON conversations(business_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id);
    CREATE INDEX IF NOT EXISTS idx_callback_requests_business ON callback_requests(business_id);
  `);

  console.log('Database tables initialized successfully');
}

// Helper functions for common queries - these will be initialized after tables are created
let queries = null;

function initializeQueries() {
  queries = {
    // Customer queries
    createCustomer: db.prepare(`
      INSERT INTO customers (email, password, business_name, plan, trial_ends_at)
      VALUES (?, ?, ?, ?, datetime('now', '+7 days'))
    `),

    findCustomerByEmail: db.prepare(`
      SELECT * FROM customers WHERE email = ?
    `),

    findCustomerById: db.prepare(`
      SELECT * FROM customers WHERE id = ?
    `),

    updateCustomerPlan: db.prepare(`
      UPDATE customers SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),

    // Business profile queries
    createBusinessProfile: db.prepare(`
      INSERT INTO business_profiles (customer_id, business_name)
      VALUES (?, ?)
    `),

    findBusinessByCustomerId: db.prepare(`
      SELECT * FROM business_profiles WHERE customer_id = ?
    `),

    updateBusinessProfile: db.prepare(`
      UPDATE business_profiles
      SET business_name = ?, business_type = ?, address = ?, website = ?,
          owner_phone = ?, description = ?, opening_hours = ?, languages = ?,
          special_rules = ?, greeting_message = ?, backup_phone = ?,
          connection_method = ?, is_setup_complete = ?, updated_at = CURRENT_TIMESTAMP
      WHERE customer_id = ?
    `),

    // Setup progress queries
    createSetupProgress: db.prepare(`
      INSERT INTO setup_progress (customer_id, current_step, step1_data)
      VALUES (?, 1, ?)
    `),

    findSetupProgress: db.prepare(`
      SELECT * FROM setup_progress WHERE customer_id = ?
    `),

    updateSetupProgress: db.prepare(`
      UPDATE setup_progress
      SET current_step = ?, step1_data = ?, step2_data = ?, step3_data = ?,
          step4_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE customer_id = ?
    `),

    // Conversation queries
    createConversation: db.prepare(`
      INSERT INTO conversations (business_id, type, caller_number, summary, full_transcript, duration_seconds, action_taken)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    findConversationsByBusinessId: db.prepare(`
      SELECT * FROM conversations WHERE business_id = ? ORDER BY created_at DESC LIMIT 50
    `),

    // Appointment queries
    createAppointment: db.prepare(`
      INSERT INTO appointments (business_id, customer_name, customer_phone, service, date, time, duration_minutes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    findUpcomingAppointments: db.prepare(`
      SELECT * FROM appointments
      WHERE business_id = ? AND status = 'confirmed' AND date >= date('now')
      ORDER BY date, time
    `),

    // Callback request queries
    createCallbackRequest: db.prepare(`
      INSERT INTO callback_requests (business_id, customer_name, customer_phone, reason)
      VALUES (?, ?, ?, ?)
    `),

    findPendingCallbacks: db.prepare(`
      SELECT * FROM callback_requests
      WHERE business_id = ? AND is_handled = 0
      ORDER BY created_at DESC
    `)
  };

  return queries;
}

module.exports = {
  db,
  initializeDatabase: function() {
    initializeDatabase();
    return initializeQueries();
  },
  get queries() {
    if (!queries) {
      throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return queries;
  }
};
