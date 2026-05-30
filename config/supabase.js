const { createClient } = require("@supabase/supabase-js");

// Creates the shared Supabase client used by controllers and middleware.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = supabase;
