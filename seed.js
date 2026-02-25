require('dotenv').config();
const bcrypt = require('bcrypt');
const database = require('./database');

async function seed() {
  console.log('🌱 Starting database seeding...\n');

  // Initialize database tables and queries
  database.initializeDatabase();
  const queries = database.queries;

  try {
    // Check if test account already exists
    const existingCustomer = queries.findCustomerByEmail.get('test@youraisolution.nl');

    if (existingCustomer) {
      console.log('⚠️  Test account already exists. Deleting and recreating...');
      database.db.prepare('DELETE FROM customers WHERE email = ?').run('test@youraisolution.nl');
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash('test1234', 10);

    // Create test customer
    const result = queries.createCustomer.run(
      'test@youraisolution.nl',
      hashedPassword,
      'Test Business',
      'professional'
    );

    const customerId = result.lastInsertRowid;

    console.log('✅ Test customer created:');
    console.log('   Email: test@youraisolution.nl');
    console.log('   Password: test1234');
    console.log('   Plan: professional');
    console.log('   Customer ID:', customerId);

    // Create business profile
    queries.createBusinessProfile.run(customerId, 'Test Business');

    console.log('✅ Business profile created');

    // Create setup progress
    const step1Data = JSON.stringify({
      business_name: 'Test Business',
      business_type: 'restaurant',
      address: 'Test Street 123, Amsterdam',
      website: 'https://test-business.nl',
      business_email: 'test@youraisolution.nl',
      owner_phone: '+31612345678'
    });

    queries.createSetupProgress.run(customerId, step1Data);

    console.log('✅ Setup progress initialized');
    console.log('\n🎉 Seeding completed successfully!');
    console.log('\n📝 You can now log in with:');
    console.log('   Email: test@youraisolution.nl');
    console.log('   Password: test1234\n');

  } catch (error) {
    console.error('❌ Error during seeding:', error.message);
    process.exit(1);
  }
}

seed();
